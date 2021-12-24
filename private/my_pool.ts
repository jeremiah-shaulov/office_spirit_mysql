import {debugAssert} from './debug_assert.ts';
import {Dsn} from './dsn.ts';
import {ServerDisconnectedError} from "./errors.ts";
import {MyConn} from './my_conn.ts';
import {MyProtocol} from './my_protocol.ts';

const SAVE_UNUSED_BUFFERS = 10;
const DEFAULT_MAX_CONNS = 250;
const DEFAULT_CONNECTION_TIMEOUT = 0;
const DEFAULT_KEEP_ALIVE_TIMEOUT = 10000;
const DEFAULT_KEEP_ALIVE_MAX = Number.MAX_SAFE_INTEGER;
const KEEPALIVE_CHECK_EACH = 1000;
const TRY_CONNECT_INTERVAL_MSEC = 100;

type OnLoadFile = (filename: string) => Promise<(Deno.Reader & Deno.Closer) | undefined>;

export type XaInfoTable = {dsn: Dsn, table: string};

export interface MyPoolOptions
{	dsn?: Dsn|string;
	maxConns?: number;
	onLoadFile?: OnLoadFile;
	xaInfoTables?: {dsn: Dsn|string, table: string}[];
}

class MyPoolConns
{	idle: MyProtocol[] = [];
	busy: MyProtocol[] = [];

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
{	protected conns: Map<string, MyConn[]> = new Map;

	constructor
	(	private pool: MyPool, // TODO: use
		private defaultDsn: Dsn|undefined,
		private maxConns: number,
		private onbegin: (dsn: Dsn) => Promise<MyProtocol>,
		private onend: (dsn: Dsn, conn: MyProtocol, rollbackPreparedXaId?: number) => void,
		private onbeforexaprepare?: (hostname: string, port: number, connectionId: number, xaId: number) => Promise<XaInfoTable | undefined>,
		private onafterxacommit?: (hostname: string, port: number, connectionId: number, xaId: number, xaInfoTable: XaInfoTable) => Promise<void>,
	)
	{
	}

	conn(dsn?: Dsn|string, fresh=false)
	{	if (dsn == null)
		{	dsn = this.defaultDsn;
			if (dsn == null)
			{	throw new Error(`DSN not provided, and also default DSN was not specified`);
			}
		}
		else if (typeof(dsn) == 'string')
		{	dsn = new Dsn(dsn);
		}
		let conns = this.conns.get(dsn.name);
		if (!conns)
		{	conns = [];
			this.conns.set(dsn.name, conns);
		}
		if (fresh || !conns.length)
		{	const conn = new MyConn(dsn, this.maxConns, this.onbegin, this.onend, this.onbeforexaprepare, this.onafterxacommit);
			conns[conns.length] = conn;
			return conn;
		}
		return conns[0];
	}
}

class MySessionInternal extends MySession
{	end()
	{	for (const conns of this.conns.values())
		{	for (const conn of conns)
			{	conn.end();
			}
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

	private dsn: Dsn|undefined;
	private maxConns: number;
	private onLoadFile: OnLoadFile|undefined;
	private xaInfoTables: XaInfoTable[] = [];

	constructor(options?: MyPoolOptions|Dsn|string)
	{	if (typeof(options) == 'string')
		{	this.dsn = new Dsn(options);
			this.maxConns = DEFAULT_MAX_CONNS;
		}
		else if (options instanceof Dsn)
		{	this.dsn = options;
			this.maxConns = DEFAULT_MAX_CONNS;
		}
		else
		{	this.dsn = typeof(options?.dsn)=='string' ? new Dsn(options.dsn) : options?.dsn;
			this.maxConns = options?.maxConns || DEFAULT_MAX_CONNS;
			this.onLoadFile = options?.onLoadFile;
			const xaInfoTables = options?.xaInfoTables;
			if (xaInfoTables)
			{	for (const item of xaInfoTables)
				{	this.xaInfoTables.push({dsn: typeof(item.dsn)=='string' ? new Dsn(item.dsn) : item.dsn, table: item.table});
				}
			}
		}
	}

	/**	Set and/or get configuration.
	 **/
	options(options?: MyPoolOptions): MyPoolOptions
	{	this.dsn = typeof(options?.dsn)=='string' ? new Dsn(options.dsn) : options?.dsn ?? this.dsn;
		this.maxConns = options?.maxConns ?? this.maxConns;
		this.onLoadFile = options && 'onLoadFile' in options ? options.onLoadFile : this.onLoadFile;
		{	const xaInfoTables = options?.xaInfoTables;
			if (xaInfoTables)
			{	this.xaInfoTables = [];
				for (const item of xaInfoTables)
				{	this.xaInfoTables.push({dsn: typeof(item.dsn)=='string' ? new Dsn(item.dsn) : item.dsn, table: item.table});
				}
			}
		}
		const {dsn, maxConns, onLoadFile, xaInfoTables} = this;
		return {dsn, maxConns, onLoadFile, xaInfoTables};
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
	{	const session = new MySessionInternal(this, this.dsn, this.maxConns, this.getConn.bind(this), this.returnConn.bind(this), this.xaInfoTables.length ? this.beforeXaPrepare.bind(this) : undefined, this.xaInfoTables.length ? this.afterXaCommit.bind(this) : undefined);
		try
		{	this.nSessionsOrConns++;
			return await callback(session);
		}
		finally
		{	session.end();
			if (--this.nSessionsOrConns==0 && this.nBusyAll==0)
			{	this.onend();
			}
		}
	}

	async forConn<T>(callback: (conn: MyConn) => Promise<T>, dsn?: Dsn|string)
	{	if (dsn == null)
		{	dsn = this.dsn;
			if (dsn == null)
			{	throw new Error(`DSN not provided, and also default DSN was not specified`);
			}
		}
		else if (typeof(dsn) == 'string')
		{	dsn = new Dsn(dsn);
		}
		const conn = new MyConn(dsn, this.maxConns, this.getConn.bind(this), this.returnConn.bind(this), this.xaInfoTables.length ? this.beforeXaPrepare.bind(this) : undefined, this.xaInfoTables.length ? this.afterXaCommit.bind(this) : undefined);
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
			{	conn = await conns.newConn(dsn, this.unusedBuffers.pop(), this.onLoadFile);
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

	private returnConn(dsn: Dsn, conn: MyProtocol, rollbackPreparedXaId?: number)
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
		for (const [dsn, {idle, busy}] of connsPool)
		{	for (let i=idle.length-1; i>=0; i--)
			{	const conn = idle[i];
				if (conn.useTill<=now || closeAllIdle)
				{	idle.splice(i, 1);
					this.nIdleAll--;
					promises[promises.length] = this.closeConn(conn);
				}
			}
			//
			if (busy.length+idle.length == 0)
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

	private async beforeXaPrepare(hostname: string, port: number, connectionId: number, xaId: number)
	{	const {xaInfoTables} = this;
		if (xaInfoTables.length != 0)
		{	const i = Math.floor(Math.random() * xaInfoTables.length) % xaInfoTables.length;
			const xaInfoTable = xaInfoTables[i];
			const {dsn, table} = xaInfoTable;
			if (hostname.indexOf("'")!=-1 || hostname.indexOf("\\")!=-1)
			{	console.error(`Invalid hostname in XA Info DSN: ${hostname}`);
			}
			else if (table.indexOf("`") != -1)
			{	console.error(`Invalid table name in XA Info DSN: ${table}`);
			}
			else
			{	// TODO: ensure autocommit
				// TODO: no reset connection
				const sql = `INSERT INTO \`${table}\` (\`host\`, \`port\`, \`connection_id\`, \`xa_id\`, prepare_time) VALUES ('${hostname}', ${Number(port)}, ${Number(connectionId)}, ${Number(xaId)}, Now())`;
				await this.forConn(conn => conn.execute(sql), dsn);
				return xaInfoTable;
			}
		}
	}

	private async afterXaCommit(hostname: string, port: number, connectionId: number, xaId: number, xaInfoTable: XaInfoTable)
	{	const {dsn, table} = xaInfoTable;
		if (hostname.indexOf("'")!=-1 || hostname.indexOf("\\")!=-1)
		{	console.error(`Invalid hostname in XA Info DSN: ${hostname}`);
		}
		else if (table.indexOf("`") != -1)
		{	console.error(`Invalid table name in XA Info DSN: ${table}`);
		}
		else
		{	const sql = `DELETE FROM \`${table}\` WHERE (\`host\`, \`port\`, \`connection_id\`, \`xa_id\`) = ('${hostname}', ${Number(port)}, ${Number(connectionId)}, ${Number(xaId)})`;
			await this.forConn(conn => conn.execute(sql), dsn);
		}
	}
}
