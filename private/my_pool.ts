import {debugAssert} from './debug_assert.ts';
import {Dsn} from './dsn.ts';
import {MyConn} from './my_conn.ts';
import {MyProtocol} from './my_protocol.ts';

const SAVE_UNUSED_BUFFERS = 10;
const DEFAULT_MAX_CONNS = 250;
const DEFAULT_KEEP_ALIVE_TIMEOUT = 10000;
const DEFAULT_KEEP_ALIVE_MAX = Number.MAX_SAFE_INTEGER;
const KEEPALIVE_CHECK_EACH = 1000;

export interface MyPoolOptions
{	dsn?: Dsn|string;
	maxConns?: number;
	onLoadFile?: (filename: string) => Promise<(Deno.Reader & Deno.Closer) | undefined>;
}

class MyPoolConns
{	idle: MyProtocol[] = [];
	busy: MyProtocol[] = [];
}

export class MySession
{	protected conns: Map<string, MyConn[]> = new Map;

	constructor
	(	protected pool: MyPool,
		private defaultDsn: Dsn|undefined,
		protected getConn: (dsn: Dsn) => Promise<MyProtocol>,
		protected returnConn: (dsn: Dsn, conn: MyProtocol) => void,
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
		{	const conn = new MyConn(dsn, this.getConn, this.returnConn);
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
	private onerror: (error: Error) => void = () => {};
	private onend: () => void = () => {};
	private nSessionsOrConns = 0;

	private dsn: Dsn|undefined;
	private maxConns: number;
	private onLoadFile: ((filename: string) => Promise<(Deno.Reader & Deno.Closer) | undefined>) | undefined;

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
		}
	}

	/**	Set and/or get configuration.
	 **/
	options(options?: MyPoolOptions): MyPoolOptions
	{	this.dsn = typeof(options?.dsn)=='string' ? new Dsn(options.dsn) : options?.dsn ?? this.dsn;
		this.maxConns = options?.maxConns ?? this.maxConns;
		this.onLoadFile = options && 'onLoadFile' in options ? options.onLoadFile : this.onLoadFile;
		const {dsn, maxConns, onLoadFile} = this;
		return {dsn, maxConns, onLoadFile};
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
	{	this.closeKeptAliveTimedOut(true);
		debugAssert(this.nIdleAll == 0);
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
	{	const session = new MySessionInternal(this, this.dsn, this.getConn.bind(this), this.returnConn.bind(this));
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
		const conn = new MyConn(dsn, this.getConn.bind(this), this.returnConn.bind(this));
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
		{	let conn;
			conn = idle.pop();
			if (!conn)
			{	conn = await MyProtocol.inst(dsn, this.unusedBuffers.pop(), this.onLoadFile);
			}
			else if (conn.useTill <= now)
			{	this.nIdleAll--;
				try
				{	this.saveUnusedBuffer(conn.close());
				}
				catch (e)
				{	this.onerror(e);
				}
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

	private returnConn(dsn: Dsn, conn: MyProtocol)
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
		if (this.nSessionsOrConns==0 && this.nBusyAll==0)
		{	this.onend();
		}
		conns.busy[i] = conns.busy[conns.busy.length - 1];
		conns.busy.length--;
		if (conn.isBrokenConnection || --conn.useNTimes<=0 || conn.useTill<=Date.now())
		{	try
			{	this.saveUnusedBuffer(conn.close());
			}
			catch (e)
			{	this.onerror(e);
			}
		}
		else
		{	conns.idle.push(conn);
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
	}

	private closeKeptAliveTimedOut(closeAllIdle=false)
	{	const {connsPool} = this;
		const now = Date.now();
		for (const [dsn, {idle, busy}] of connsPool)
		{	for (let i=idle.length-1; i>=0; i--)
			{	const conn = idle[i];
				if (conn.useTill<=now || closeAllIdle)
				{	idle.splice(i, 1);
					this.nIdleAll--;
					try
					{	this.saveUnusedBuffer(conn.close());
					}
					catch (e)
					{	this.onerror(e);
					}
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
						try
						{	this.saveUnusedBuffer(conn.close());
						}
						catch (e)
						{	this.onerror(e);
						}
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
			try
			{	this.saveUnusedBuffer(conn.close());
			}
			catch (e)
			{	this.onerror(e);
			}
			debugAssert(this.nIdleAll >= 0);
		}
	}
}
