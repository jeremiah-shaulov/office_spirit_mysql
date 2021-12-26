import {debugAssert} from './debug_assert.ts';
import {Dsn} from './dsn.ts';
import {ServerDisconnectedError, SqlError} from "./errors.ts";
import {MyConn, doSavepoint} from './my_conn.ts';
import {MyProtocol} from './my_protocol.ts';
import {crc32} from "./deps.ts";

const SAVE_UNUSED_BUFFERS = 10;
const DEFAULT_MAX_CONNS = 250;
const DEFAULT_CONNECTION_TIMEOUT = 0;
const DEFAULT_KEEP_ALIVE_TIMEOUT = 10000;
const DEFAULT_KEEP_ALIVE_MAX = Number.MAX_SAFE_INTEGER;
const KEEPALIVE_CHECK_EACH = 1000;
const TRY_CONNECT_INTERVAL_MSEC = 100;

type OnLoadFile = (filename: string) => Promise<(Deno.Reader & Deno.Closer) | undefined>;
type OnBeforeCommit = (conns: Iterable<MyConn>) => Promise<void>;

export type XaInfoTable = {dsn: Dsn, table: string, hash: number};

export interface MyPoolOptions
{	dsn?: Dsn | string | (Dsn|string)[];
	maxConns?: number;
	onLoadFile?: OnLoadFile;
	onBeforeCommit?: OnBeforeCommit;
	xaInfoTables?: {dsn: Dsn|string, table: string}[];
}

class XaIdGen
{	private lastTime = 0;
	private lastEnum = 0;
	private pid = Deno.pid;

	next(xaInfoTableHash?: number)
	{	const curTime = Math.floor(Date.now()/1000);
		let curEnum = 0;
		if (curTime == this.lastTime)
		{	curEnum = ++this.lastEnum;
		}
		else
		{	this.lastTime = curTime;
			this.lastEnum = 0;
		}
		let v = curTime.toString(36)+'.'+curEnum.toString(36)+'@'+this.pid.toString(36);
		if (xaInfoTableHash != undefined)
		{	v += '>'+xaInfoTableHash.toString(36);
		}
		return v+'-';
	}
}

const xaIdGen = new XaIdGen;

class MyPoolConns
{	idle: MyProtocol[] = [];
	busy: MyProtocol[] = [];
	nCreating = 0;

	async newConn(dsn: Dsn, unusedBuffer?: Uint8Array, onLoadFile?: OnLoadFile)
	{	const connectionTimeout = dsn.connectionTimeout>=0 ? dsn.connectionTimeout : DEFAULT_CONNECTION_TIMEOUT;
		let now = Date.now();
		const connectTill = now + connectionTimeout;
		for (let i=0; true; i++)
		{	try
			{	return await MyProtocol.inst(dsn, unusedBuffer, onLoadFile);
			}
			catch (e)
			{	// with connectTill==0 must not retry
				now = Date.now();
				if (now>=connectTill || !(e instanceof ServerDisconnectedError) && e.name!='ConnectionRefused')
				{	throw e;
				}
			}
			await new Promise(y => setTimeout(y, Math.min(TRY_CONNECT_INTERVAL_MSEC, connectTill-now)));
		}
	}
}

export class MySession
{	protected connsArr: MyConn[] = [];
	private savepointEnum = 0;
	private trxOptions: {readonly: boolean, xaId1: string} | undefined;
	private curXaInfoTable: XaInfoTable | undefined;

	constructor
	(	private pool: MyPool,
		private defaultDsn: Dsn|undefined,
		private maxConns: number,
		private xaInfoTables: XaInfoTable[] = [],
		private getConnFunc: (dsn: Dsn) => Promise<MyProtocol>,
		private returnConnFunc: (dsn: Dsn, conn: MyProtocol, rollbackPreparedXaId1: string) => void,
		private onBeforeCommit?: OnBeforeCommit,
	)
	{
	}

	get conns(): Iterable<MyConn> // Iterable<MyConn>, not MyConn[], to ensure that the array will not be modified from outside
	{	return this.connsArr;
	}

	conn(dsn?: Dsn|string, fresh=false)
	{	if (dsn == undefined)
		{	dsn = this.defaultDsn;
			if (dsn == undefined)
			{	throw new Error(`DSN not provided, and also default DSN was not specified`);
			}
		}
		if (!fresh)
		{	const dsnStr = typeof(dsn)=='string' ? dsn : dsn.name;
			for (const conn of this.connsArr)
			{	if (conn.dsnStr == dsnStr)
				{	return conn;
				}
			}
		}
		const conn = new MyConn(typeof(dsn)=='string' ? new Dsn(dsn) : dsn, this.maxConns, this.trxOptions, this.getConnFunc, this.returnConnFunc, undefined);
		this.connsArr[this.connsArr.length] = conn;
		return conn;
	}

	async startTrx(options?: {readonly?: boolean, xa?: boolean})
	{	// 1. Fail if there are XA started
		for (const conn of this.connsArr)
		{	if (conn.xaId1)
			{	throw new SqlError(`There's already an active Distributed Transaction on ${conn.dsnStr}`);
			}
		}
		// 2. Commit current transactions
		await this.commit();
		// 3. trxOptions
		const readonly = !!options?.readonly;
		let xaId1 = '';
		let curXaInfoTable: XaInfoTable | undefined;
		if (options?.xa)
		{	const {xaInfoTables} = this;
			const {length} = xaInfoTables;
			const i = length<=1 ? 0 : Math.floor(Math.random() * length) % length;
			curXaInfoTable = xaInfoTables[i];
			xaId1 = xaIdGen.next(curXaInfoTable?.hash);
		}
		const trxOptions = {readonly, xaId1};
		this.trxOptions = trxOptions;
		this.curXaInfoTable = curXaInfoTable;
		// 4. Start transaction
		const promises = [];
		for (const conn of this.connsArr)
		{	promises[promises.length] = conn.startTrx(trxOptions);
		}
		await this.doAll(promises, true);
	}

	savepoint()
	{	const pointId = ++this.savepointEnum;
		const promises = [];
		for (const conn of this.connsArr)
		{	promises[promises.length] = conn[doSavepoint](pointId, `SAVEPOINT s${pointId}`);
		}
		return this.doAll(promises);
	}

	rollback(toPointId?: number)
	{	this.trxOptions = undefined;
		this.curXaInfoTable = undefined;
		const promises = [];
		for (const conn of this.connsArr)
		{	promises[promises.length] = conn.rollback(toPointId);
		}
		return this.doAll(promises);
	}

	async commit()
	{	const {trxOptions, curXaInfoTable} = this;
		this.trxOptions = undefined;
		this.curXaInfoTable = undefined;
		if (trxOptions && curXaInfoTable)
		{	await this.pool.forConn
			(	async conn =>
				{	// 1. Connect to curXaInfoTable DSN (if throws exception, don't continue)
					await conn.connect();
					if (!conn.autocommit)
					{	await conn.execute("SET autocommit=1");
					}
					// 2. Call onBeforeCommit
					if (this.onBeforeCommit)
					{	await this.onBeforeCommit(this.conns);
					}
					// 3. Prepare commit
					const promises = [];
					for (const conn of this.connsArr)
					{	if (conn.xaId1)
						{	promises[promises.length] = conn.prepareCommit();
						}
					}
					await this.doAll(promises, true);
					// 4. Log to XA info table
					await conn.execute(`INSERT INTO \`${curXaInfoTable.table}\` (\`xa_id\`) VALUES ('${trxOptions.xaId1}')`);
					// 5. Commit
					promises.length = 0;
					for (const conn of this.connsArr)
					{	promises[promises.length] = conn.commit();
					}
					await this.doAll(promises);
					// 6. Remove record from XA info table
					await conn.execute(`DELETE FROM \`${curXaInfoTable.table}\` WHERE \`xa_id\` = '${trxOptions.xaId1}'`);
				},
				curXaInfoTable.dsn
			);
		}
		else
		{	// 1. Call onBeforeCommit
			if (this.onBeforeCommit)
			{	await this.onBeforeCommit(this.conns);
			}
			// 2. Prepare commit
			const promises = [];
			for (const conn of this.connsArr)
			{	if (conn.xaId1)
				{	promises[promises.length] = conn.prepareCommit();
				}
			}
			await this.doAll(promises, true);
			// 3. Commit
			promises.length = 0;
			for (const conn of this.connsArr)
			{	promises[promises.length] = conn.commit();
			}
			await this.doAll(promises);
		}
	}

	private async doAll(promises: Promise<unknown>[], rollbackOnError=false)
	{	const result = await Promise.allSettled(promises);
		let error;
		for (const r of result)
		{	if (r.status == 'rejected')
			{	if (!error)
				{	error = r.reason;
				}
				else
				{	console.error(r.reason);
				}
			}
		}
		if (error)
		{	if (rollbackOnError)
			{	try
				{	await this.rollback();
				}
				catch (e2)
				{	console.error(e2);
				}
			}
			throw error;
		}
	}
}

class MySessionInternal extends MySession
{	endSession()
	{	for (const conn of this.connsArr)
		{	conn.end();
		}
	}
}

export class MyPool
{	private connsPool = new Map<string, MyPoolConns>();
	private unusedBuffers: Uint8Array[] = [];
	private nIdleAll = 0;
	private nBusyAll = 0;
	private hTimer: number | undefined;
	private haveSlotsCallbacks: (() => void)[] = [];
	private onerror: (error: Error) => void = () => {}; // TODO: use
	private onend: () => void = () => {};
	private nSessionsOrConns = 0;

	private dsn: Dsn[] = [];
	private defaultDsn: Dsn | undefined;
	private maxConns = DEFAULT_MAX_CONNS;
	private onLoadFile: OnLoadFile|undefined;
	private onBeforeCommit: OnBeforeCommit|undefined;
	private xaInfoTables: XaInfoTable[] = [];

	private getConnFunc = this.getConn.bind(this);
	private returnConnFunc = this.returnConn.bind(this);

	constructor(options?: Dsn | string | (Dsn|string)[] | MyPoolOptions)
	{	this.options(options);
	}

	/**	Set and/or get configuration.
	 **/
	options(options?: Dsn | string | (Dsn|string)[] | MyPoolOptions): MyPoolOptions
	{	if (options)
		{	if (typeof(options)=='string' || (options instanceof Dsn) || Array.isArray(options))
			{	options = {dsn: options};
			}
			const {dsn, maxConns, onLoadFile, onBeforeCommit, xaInfoTables} = options;
			if (typeof(dsn) == 'string')
			{	this.dsn = dsn ? [new Dsn(dsn)] : [];
			}
			else if (dsn instanceof Dsn)
			{	this.dsn = [dsn];
			}
			else if (dsn)
			{	this.dsn.length = 0;
				for (const item of dsn)
				{	if (item)
					{	this.dsn.push(typeof(item)=='string' ? new Dsn(item) : item);
					}
				}
			}
			this.defaultDsn = this.dsn[0];
			if (typeof(maxConns)=='number' && maxConns>0)
			{	this.maxConns = maxConns;
			}
			this.onLoadFile = onLoadFile;
			this.onBeforeCommit = onBeforeCommit;
			if (xaInfoTables)
			{	this.xaInfoTables.length = 0;
				for (const {dsn, table} of xaInfoTables)
				{	if (dsn && table)
					{	const dsnObj = typeof(dsn)=='string' ? new Dsn(dsn) : dsn;
						const hash = crc32(dsnObj.name) ^ crc32(table);
						if (this.xaInfoTables.findIndex(v => v.hash == hash) == -1)
						{	this.xaInfoTables.push({dsn: dsnObj, table, hash});
						}
					}
				}
			}
		}
		const {dsn, maxConns, onLoadFile, onBeforeCommit, xaInfoTables} = this;
		return {dsn, maxConns, onLoadFile, onBeforeCommit, xaInfoTables};
	}

	/**	`onError(callback)` - catch general connection errors. Only one handler is active. Second `onError()` overrides the previous handler.
		`onError(undefined)` - removes the event handler.
	 **/
	onError(callback?: (error: Error) => void)
	{	this.onerror = !callback ? () => {} : error =>
		{	try
			{	callback(error);
			}
			catch (e)
			{	console.error(e);
			}
		};
	}

	/**	`onEnd(callback)` - Register callback to be called each time when number of ongoing requests reach 0.
		Only one callback is active. Second `onEnd()` overrides the previous callback.
		`onEnd(undefined)` - removes the event handler.
		Can be used as `await onEnd()`.
	 **/
	onEnd(callback?: () => void)
	{	if (this.nSessionsOrConns==0 && this.nBusyAll==0)
		{	return Promise.resolve();
		}
		let trigger: () => void;
		const promise = new Promise<void>(y => trigger = y);
		this.onend = () =>
		{	try
			{	callback?.();
			}
			catch (e)
			{	console.error(e);
			}
			trigger();
			trigger = () => {};
		};
		return promise;
	}

	closeIdle()
	{	return this.closeKeptAliveTimedOut(true);
	}

	haveSlots(): boolean
	{	return this.nBusyAll < this.maxConns;
	}

	async waitHaveSlots(): Promise<void>
	{	while (this.nBusyAll >= this.maxConns)
		{	await new Promise<void>(y => {this.haveSlotsCallbacks.push(y)});
		}
	}

	async session<T>(callback: (session: MySession) => Promise<T>)
	{	const session = new MySessionInternal(this, this.defaultDsn, this.maxConns, this.xaInfoTables, this.getConnFunc, this.returnConnFunc, this.onBeforeCommit);
		try
		{	this.nSessionsOrConns++;
			return await callback(session);
		}
		finally
		{	session.endSession();
			if (--this.nSessionsOrConns==0 && this.nBusyAll==0)
			{	this.onend();
			}
		}
	}

	async forConn<T>(callback: (conn: MyConn) => Promise<T>, dsn?: Dsn|string)
	{	if (dsn == undefined)
		{	dsn = this.defaultDsn;
			if (dsn == undefined)
			{	throw new Error(`DSN not provided, and also default DSN was not specified`);
			}
		}
		else if (typeof(dsn) == 'string')
		{	dsn = new Dsn(dsn);
		}
		const conn = new MyConn(dsn, this.maxConns, undefined, this.getConnFunc, this.returnConnFunc, this.onBeforeCommit);
		try
		{	this.nSessionsOrConns++;
			return await callback(conn);
		}
		finally
		{	conn.end();
			if (--this.nSessionsOrConns==0 && this.nBusyAll==0)
			{	this.onend();
			}
		}
	}

	private saveUnusedBuffer(buffer: Uint8Array)
	{	if (this.unusedBuffers.length < SAVE_UNUSED_BUFFERS)
		{	this.unusedBuffers.push(buffer);
		}
	}

	private async closeConn(conn: MyProtocol)
	{	this.nBusyAll++;
		try
		{	const buffer = await conn.end();
			if (buffer instanceof Uint8Array)
			{	this.saveUnusedBuffer(buffer);
			}
		}
		catch (e)
		{	// must not happen
			console.error(e);
		}
		this.nBusyAll--;
		if (this.nBusyAll+this.nIdleAll == 0)
		{	clearInterval(this.hTimer);
			this.hTimer = undefined;
		}
		if (this.nSessionsOrConns==0 && this.nBusyAll==0)
		{	this.onend();
		}
	}

	private async getConn(dsn: Dsn)
	{	debugAssert(this.nIdleAll>=0 && this.nBusyAll>=0);
		while (this.nBusyAll >= this.maxConns)
		{	await new Promise<void>(y => {this.haveSlotsCallbacks.push(y)});
		}
		const keepAliveTimeout = dsn.keepAliveTimeout>=0 ? dsn.keepAliveTimeout : DEFAULT_KEEP_ALIVE_TIMEOUT;
		const keepAliveMax = dsn.keepAliveMax>=0 ? dsn.keepAliveMax : DEFAULT_KEEP_ALIVE_MAX;
		let conns = this.connsPool.get(dsn.name);
		if (!conns)
		{	conns = new MyPoolConns;
			this.connsPool.set(dsn.name, conns);
		}
		const {idle, busy} = conns;
		const now = Date.now();
		while (true)
		{	let conn: MyProtocol|undefined;
			conn = idle.pop();
			if (!conn)
			{	conns.nCreating++;
				try
				{	conn = await conns.newConn(dsn, this.unusedBuffers.pop(), this.onLoadFile);
				}
				finally
				{	conns.nCreating--;
				}
			}
			else if (conn.useTill <= now)
			{	this.nIdleAll--;
				this.closeConn(conn);
				continue;
			}
			else
			{	this.nIdleAll--;
			}
			conn.useTill = Math.min(conn.useTill, now+keepAliveTimeout);
			conn.useNTimes = Math.min(conn.useNTimes, keepAliveMax);
			if (this.hTimer == undefined)
			{	this.hTimer = setInterval(() => {this.closeKeptAliveTimedOut()}, KEEPALIVE_CHECK_EACH);
			}
			busy.push(conn);
			this.nBusyAll++;
			this.closeExceedingIdleConns(idle);
			return conn;
		}
	}

	private returnConn(dsn: Dsn, conn: MyProtocol, rollbackPreparedXaId1: string)
	{	conn.end(rollbackPreparedXaId1, --conn.useNTimes>0 && conn.useTill>Date.now()).then
		(	protocolOrBuffer =>
			{	const conns = this.connsPool.get(dsn.name);
				if (!conns)
				{	// assume: returnConn() already called for this connection
					return;
				}
				const i = conns.busy.indexOf(conn);
				if (i == -1)
				{	// assume: returnConn() already called for this connection
					return;
				}
				this.nBusyAll--;
				debugAssert(this.nIdleAll>=0 && this.nBusyAll>=0);
				conns.busy[i] = conns.busy[conns.busy.length - 1];
				conns.busy.length--;
				if (protocolOrBuffer instanceof Uint8Array)
				{	this.saveUnusedBuffer(protocolOrBuffer);
				}
				else if (protocolOrBuffer)
				{	conns.idle.push(protocolOrBuffer);
					this.nIdleAll++;
				}
				if (this.nBusyAll < this.maxConns)
				{	let n = this.haveSlotsCallbacks.length;
					if (n > 0)
					{	while (n-- > 0)
						{	this.haveSlotsCallbacks[n]();
						}
						this.haveSlotsCallbacks.length = 0;
					}
					else if (this.nBusyAll == 0)
					{	this.closeKeptAliveTimedOut();
					}
				}
				if (this.nSessionsOrConns==0 && this.nBusyAll==0)
				{	this.onend();
				}
			}
		);
	}

	private closeKeptAliveTimedOut(closeAllIdle=false)
	{	const {connsPool} = this;
		const now = Date.now();
		const promises = [];
		for (const [dsn, {idle, busy, nCreating}] of connsPool)
		{	for (let i=idle.length-1; i>=0; i--)
			{	const conn = idle[i];
				if (conn.useTill<=now || closeAllIdle)
				{	idle.splice(i, 1);
					this.nIdleAll--;
					promises[promises.length] = this.closeConn(conn);
				}
			}
			//
			if (busy.length+idle.length+nCreating == 0)
			{	connsPool.delete(dsn);
			}
		}
		if (this.nBusyAll+this.nIdleAll == 0)
		{	clearInterval(this.hTimer);
			this.hTimer = undefined;
		}
		debugAssert(!closeAllIdle || this.nIdleAll==0);
		return Promise.all(promises);
	}

	private closeExceedingIdleConns(idle: MyProtocol[])
	{	debugAssert(this.nBusyAll <= this.maxConns);
		let nCloseIdle = this.nBusyAll + this.nIdleAll - this.maxConns;
		while (nCloseIdle > 0)
		{	let conn = idle.pop();
			if (!conn)
			{	for (const cConns of this.connsPool.values())
				{	while (true)
					{	conn = cConns.idle.pop();
						if (!conn)
						{	break;
						}
						nCloseIdle--;
						this.nIdleAll--;
						this.closeConn(conn);
						debugAssert(this.nIdleAll >= 0);
						if (nCloseIdle == 0)
						{	return;
						}
					}
				}
				return;
			}
			nCloseIdle--;
			this.nIdleAll--;
			this.closeConn(conn);
			debugAssert(this.nIdleAll >= 0);
		}
	}
}
