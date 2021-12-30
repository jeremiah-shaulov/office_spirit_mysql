import {debugAssert} from './debug_assert.ts';
import {Dsn} from './dsn.ts';
import {ServerDisconnectedError} from "./errors.ts";
import {MyConn, OnBeforeCommit} from './my_conn.ts';
import {MyProtocol, OnLoadFile} from './my_protocol.ts';
import {MySession, MySessionInternal} from "./my_session.ts";
import {XaIdGen} from "./xa_id_gen.ts";
import {crc32} from "./deps.ts";

const SAVE_UNUSED_BUFFERS = 10;
const DEFAULT_MAX_CONNS = 250;
const DEFAULT_CONNECTION_TIMEOUT = 0;
const DEFAULT_KEEP_ALIVE_TIMEOUT = 10000;
const DEFAULT_KEEP_ALIVE_MAX = Number.MAX_SAFE_INTEGER;
const KEEPALIVE_CHECK_EACH = 1000;
const DEFAULT_DANGLING_XA_CHECK_EACH = 6000;
const TRY_CONNECT_INTERVAL_MSEC = 100;

export type XaInfoTable = {dsn: Dsn, table: string, hash: number};

export interface MyPoolOptions
{	dsn?: Dsn | string;
	maxConns?: number;
	onLoadFile?: OnLoadFile;
	onBeforeCommit?: OnBeforeCommit;
	managedXaDsns?: Dsn | string | (Dsn|string)[];
	xaCheckEach?: number;
	xaInfoTables?: {dsn: Dsn|string, table: string}[];
}

class MyPoolConns
{	idle: MyProtocol[] = [];
	busy: MyProtocol[] = [];
	nCreating = 0;
}

export class MyPool
{	private connsPool = new Map<string, MyPoolConns>();
	private unusedBuffers: Uint8Array[] = [];
	private nIdleAll = 0;
	private nBusyAll = 0;
	private hTimer: number | undefined;
	private xaTask: XaTask;
	private haveSlotsCallbacks: (() => void)[] = [];
	private onerror: (error: Error) => void = () => {}; // TODO: use
	private onend: () => void = () => {};
	private nSessionsOrConns = 0;

	private dsn: Dsn | undefined;
	private maxConns = DEFAULT_MAX_CONNS;
	private onLoadFile: OnLoadFile|undefined;
	private onBeforeCommit: OnBeforeCommit|undefined;

	private getConnFunc = this.getConn.bind(this);
	private returnConnFunc = this.returnConn.bind(this);

	constructor(options?: Dsn | string | MyPoolOptions)
	{	this.xaTask = new XaTask(this);
		this.options(options);
	}

	/**	Set and/or get configuration.
	 **/
	options(options?: Dsn | string | MyPoolOptions): MyPoolOptions
	{	if (options)
		{	if (typeof(options)=='string' || (options instanceof Dsn))
			{	options = {dsn: options};
			}
			const {dsn, maxConns, onLoadFile, onBeforeCommit, managedXaDsns, xaCheckEach, xaInfoTables} = options;
			// dsn
			if (typeof(dsn) == 'string')
			{	this.dsn = dsn ? new Dsn(dsn) : undefined;
			}
			else if (dsn)
			{	this.dsn = dsn;
			}
			// maxConns
			if (typeof(maxConns) == 'number')
			{	this.maxConns = maxConns>0 ? maxConns : DEFAULT_MAX_CONNS;
			}
			// onLoadFile
			this.onLoadFile = onLoadFile;
			// onBeforeCommit
			this.onBeforeCommit = onBeforeCommit;
			// managedXaDsns
			if (typeof(managedXaDsns) == 'string')
			{	this.xaTask.managedXaDsns.length = 0;
				if (managedXaDsns)
				{	this.xaTask.managedXaDsns[0] = new Dsn(managedXaDsns);
				}
			}
			else if (managedXaDsns instanceof Dsn)
			{	this.xaTask.managedXaDsns.length = 0;
				if (managedXaDsns)
				{	this.xaTask.managedXaDsns[0] = managedXaDsns;
				}
			}
			else if (managedXaDsns)
			{	this.xaTask.managedXaDsns.length = 0;
				for (const item of managedXaDsns)
				{	if (item)
					{	this.xaTask.managedXaDsns.push(typeof(item)=='string' ? new Dsn(item) : item);
					}
				}
			}
			// xaCheckEach
			if (typeof(xaCheckEach)=='number')
			{	this.xaTask.xaCheckEach = xaCheckEach>0 ? xaCheckEach : DEFAULT_DANGLING_XA_CHECK_EACH;
			}
			// xaInfoTables
			if (xaInfoTables)
			{	this.xaTask.xaInfoTables.length = 0;
				for (const {dsn, table} of xaInfoTables)
				{	if (dsn && table)
					{	const dsnObj = typeof(dsn)=='string' ? new Dsn(dsn) : dsn;
						const hash = (crc32(dsnObj.name) ^ crc32(table)) >>> 0;
						if (this.xaTask.xaInfoTables.findIndex(v => v.hash == hash) == -1)
						{	this.xaTask.xaInfoTables.push({dsn: dsnObj, table, hash});
						}
					}
				}
			}
			this.xaTask.start();
		}
		const {dsn, maxConns, onLoadFile, onBeforeCommit, xaTask: {managedXaDsns, xaCheckEach, xaInfoTables}} = this;
		return {dsn, maxConns, onLoadFile, onBeforeCommit, managedXaDsns, xaCheckEach, xaInfoTables};
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
	{	const session = new MySessionInternal(this, this.dsn, this.maxConns, this.xaTask.xaInfoTables, this.getConnFunc, this.returnConnFunc, this.onBeforeCommit);
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
		{	dsn = this.dsn;
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

	private async newConn(dsn: Dsn, unusedBuffer?: Uint8Array, onLoadFile?: OnLoadFile)
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
				{	conn = await this.newConn(dsn, this.unusedBuffers.pop(), this.onLoadFile);
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
				this.xaTask.start();
			}
			busy.push(conn);
			this.nBusyAll++;
			this.closeExceedingIdleConns(idle);
			return conn;
		}
	}

	private returnConn(dsn: Dsn, conn: MyProtocol, rollbackPreparedXaId: string)
	{	conn.end(rollbackPreparedXaId, --conn.useNTimes>0 && conn.useTill>Date.now()).then
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
		if (closeAllIdle)
		{	promises[promises.length] = this.xaTask.stop();
		}
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

class XaTask
{	managedXaDsns: Dsn[] = [];
	xaCheckEach = DEFAULT_DANGLING_XA_CHECK_EACH;
	xaInfoTables: XaInfoTable[] = [];

	private xaTaskTimer: number | undefined;
	private xaTaskBusy = false;
	private xaTaskOnDone: (() => void) | undefined;

	constructor(private pool: MyPool)
	{
	}

	async start()
	{	if (this.xaTaskBusy)
		{	return;
		}
		if (this.xaTaskTimer != undefined)
		{	clearTimeout(this.xaTaskTimer);
			this.xaTaskTimer = undefined;
		}
		if (this.managedXaDsns.length == 0)
		{	return;
		}
		this.xaTaskBusy = true;

		try
		{	await this.pool.session
			(	async session =>
				{	// 1. Find dangling XAs (where owner connection id is dead) and corresponding xaInfoTables
					type Item = {conn: MyConn, table: string, xaId: string, xaId1: string, time: number, pid: number, connectionId: number, commit: boolean};
					const byInfoDsn = new Map<string, Item[]>();
					const byConn = new Map<MyConn, Item[]>();
					const results = await Promise.allSettled
					(	this.managedXaDsns.map(dsn => session.conn(dsn)).map
						(	async conn =>
							{	// 1. Read XA RECOVER
								const xas: {xaId: string, xaId1: string, time: number, pid: number, hash: number, connectionId: number}[] = [];
								const cids: number[] = [];
								for await (const {data: xaId} of await conn.query<string>("XA RECOVER"))
								{	const m = XaIdGen.decode(xaId);
									if (m)
									{	const {time, pid, hash, connectionId, xaId1} = m;
										xas[xas.length] = {xaId, xaId1, time, pid, hash, connectionId};
										if (cids.indexOf(connectionId) == -1)
										{	cids[cids.length] = connectionId;
										}
									}
								}
								// 2. Filter `xas` array to leave only dead connections
								if (cids.length != 0)
								{	let last = xas.length - 1;
									for await (const {connectionId} of await conn.query<number>(`SELECT id FROM information_schema.processlist WHERE id IN (${cids.join(',')})`))
									{	for (let i=last; i>=0; i--)
										{	if (xas[i].connectionId == connectionId)
											{	// this connection is alive
												xas[i] = xas[last--];
											}
										}
									}
									xas.length = last + 1;
								}
								// 3. Find xaInfoTables
								for (const {xaId, xaId1, time, pid, hash, connectionId} of xas)
								{	let infoDsnStr = '';
									let table = '';
									if (!isNaN(hash))
									{	const xaInfoTable = this.xaInfoTables.find(v => v.hash == hash);
										if (xaInfoTable)
										{	infoDsnStr = xaInfoTable.dsn.name;
											table = xaInfoTable.table;
										}
									}
									const item = {conn, table, xaId, xaId1, time, pid, connectionId, commit: false};
									// add to byInfoDsn
									let items = byInfoDsn.get(infoDsnStr);
									if (!items)
									{	items = [];
										byInfoDsn.set(infoDsnStr, items);
									}
									items.push(item);
									// add to byConn
									items = byConn.get(conn);
									if (!items)
									{	items = [];
										byConn.set(conn, items);
									}
									items.push(item);
								}
							}
						)
					);
					for (const res of results)
					{	if (res.status == 'rejected')
						{	console.error(res.reason);
						}
					}
					// 2. Find out should i rollback or commit, according to xaInfoTables
					const promises2 = [];
					for (const [dsnStr, items] of byInfoDsn)
					{	if (dsnStr)
						{	promises2[promises2.length] = Promise.resolve(session.conn(dsnStr)).then
							(	async conn =>
								{	const byTable = new Map<string, typeof items>();
									for (const item of items)
									{	const {table} = item;
										if (table && table.indexOf('`')==-1)
										{	let items2 = byTable.get(table);
											if (!items2)
											{	items2 = [];
												byTable.set(table, items2);
											}
											items2.push(item);
										}
									}
									for (const [table, items2] of byTable)
									{	for await (const xaId1 of await conn.queryCol("SELECT `xa_id` FROM `"+table+"` WHERE `xa_id` IN ('"+items2.map(v => v.xaId1).join("','")+"')"))
										{	const item = items2.find(v => v.xaId1 === xaId1)
											if (item)
											{	item.commit = true;
											}
										}
									}
								}
							);
						}
					}
					const results2 = await Promise.allSettled(promises2);
					for (const res of results2)
					{	if (res.status == 'rejected')
						{	console.error(res.reason);
						}
					}
					// 3. Rollback or commit
					const promises3 = [];
					for (const items of byConn.values())
					{	let promise = Promise.resolve();
						for (const {conn, xaId, time, pid, connectionId, commit} of items)
						{	promise = promise.then
							(	() =>
								{	conn.execute((commit ? "XA COMMIT '" : " XA ROLLBACK '")+xaId+"'");
								}
							).then
							(	() =>
								{	console.error(`${commit ? 'Committed' : 'Rolled back'} dangling transaction ${xaId} because it's MySQL process ID ${connectionId} was dead. Transaction started before ${Math.floor(Date.now()/1000) - time} sec by OS process ${pid}.`);
								}
							);
						}
						promises3[promises3.length] = promise;
					}
					const results3 = await Promise.allSettled(promises3);
					for (const res of results3)
					{	if (res.status == 'rejected')
						{	console.error(res.reason);
						}
					}
				}
			);
		}
		catch (e)
		{	console.error(e);
		}

		this.xaTaskBusy = false;
		const {xaTaskOnDone} = this;
		this.xaTaskOnDone = undefined;
		if (xaTaskOnDone)
		{	this.xaTaskTimer = undefined;
			xaTaskOnDone();
		}
		else if (this.managedXaDsns.length == 0)
		{	this.xaTaskTimer = undefined;
		}
		else
		{	this.xaTaskTimer = setTimeout(() => this.start(), this.xaCheckEach);
		}
	}

	stop()
	{	if (!this.xaTaskBusy)
		{	clearTimeout(this.xaTaskTimer);
			this.xaTaskTimer = undefined;
			return Promise.resolve();
		}
		else
		{	return new Promise<void>(y => {this.xaTaskOnDone = y});
		}
	}
}