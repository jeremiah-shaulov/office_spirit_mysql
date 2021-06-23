import {debug_assert} from './debug_assert.ts';
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
		private default_dsn: Dsn|undefined,
		protected get_conn: (dsn: Dsn) => Promise<MyProtocol>,
		protected return_conn: (dsn: Dsn, conn: MyProtocol) => void,
	)
	{
	}

	conn(dsn?: Dsn|string, fresh=false)
	{	if (dsn == null)
		{	dsn = this.default_dsn;
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
		{	let conn = new MyConn(dsn, this.get_conn, this.return_conn);
			conns[conns.length] = conn;
			return conn;
		}
		return conns[0];
	}
}

class MySessionInternal extends MySession
{	end()
	{	for (let conns of this.conns.values())
		{	for (let conn of conns)
			{	conn.end();
			}
		}
	}
}

export class MyPool
{	private conns_pool = new Map<string, MyPoolConns>();
	private unused_buffers: Uint8Array[] = [];
	private n_idle_all = 0;
	private n_busy_all = 0;
	private h_timer: number | undefined;
	private have_slots_callbacks: (() => void)[] = [];
	private onerror: (error: Error) => void = () => {};
	private onend: () => void = () => {};

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
		let {dsn, maxConns, onLoadFile} = this;
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
	{	let trigger: () => void;
		let promise = new Promise<void>(y => trigger = y);
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
	{	this.close_kept_alive_timed_out(true);
		debug_assert(this.n_idle_all == 0);
	}

	haveSlots(): boolean
	{	return this.n_busy_all < this.maxConns;
	}

	async waitHaveSlots(): Promise<void>
	{	while (this.n_busy_all >= this.maxConns)
		{	await new Promise<void>(y => {this.have_slots_callbacks.push(y)});
		}
	}

	async session<T>(callback: (session: MySession) => Promise<T>)
	{	let session = new MySessionInternal(this, this.dsn, this.get_conn.bind(this), this.return_conn.bind(this));
		try
		{	return await callback(session);
		}
		finally
		{	session.end();
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
		let conn = new MyConn(dsn, this.get_conn.bind(this), this.return_conn.bind(this));
		try
		{	return await callback(conn);
		}
		finally
		{	conn.end();
		}
	}

	private save_unused_buffer(buffer: Uint8Array)
	{	if (this.unused_buffers.length < SAVE_UNUSED_BUFFERS)
		{	this.unused_buffers.push(buffer);
		}
	}

	private async get_conn(dsn: Dsn)
	{	debug_assert(this.n_idle_all>=0 && this.n_busy_all>=0);
		while (this.n_busy_all >= this.maxConns)
		{	await new Promise<void>(y => {this.have_slots_callbacks.push(y)});
		}
		let keep_alive_timeout = dsn.keepAliveTimeout>=0 ? dsn.keepAliveTimeout : DEFAULT_KEEP_ALIVE_TIMEOUT;
		let keep_alive_max = dsn.keepAliveMax>=0 ? dsn.keepAliveMax : DEFAULT_KEEP_ALIVE_MAX;
		let conns = this.conns_pool.get(dsn.name);
		if (!conns)
		{	conns = new MyPoolConns;
			this.conns_pool.set(dsn.name, conns);
		}
		let {idle, busy} = conns;
		let now = Date.now();
		while (true)
		{	let conn;
			conn = idle.pop();
			if (!conn)
			{	conn = await MyProtocol.inst(dsn, this.unused_buffers.pop(), this.onLoadFile);
			}
			else if (conn.use_till <= now)
			{	this.n_idle_all--;
				try
				{	this.save_unused_buffer(conn.close());
				}
				catch (e)
				{	this.onerror(e);
				}
				continue;
			}
			else
			{	this.n_idle_all--;
			}
			conn.use_till = Math.min(conn.use_till, now+keep_alive_timeout);
			conn.use_n_times = Math.min(conn.use_n_times, keep_alive_max);
			if (this.h_timer == undefined)
			{	this.h_timer = setInterval(() => {this.close_kept_alive_timed_out()}, KEEPALIVE_CHECK_EACH);
			}
			busy.push(conn);
			this.n_busy_all++;
			this.close_exceeding_idle_conns(idle);
			return conn;
		}
	}

	private return_conn(dsn: Dsn, conn: MyProtocol)
	{	let conns = this.conns_pool.get(dsn.name);
		if (!conns)
		{	// assume: return_conn() already called for this connection
			return;
		}
		let i = conns.busy.indexOf(conn);
		if (i == -1)
		{	// assume: return_conn() already called for this connection
			return;
		}
		this.n_busy_all--;
		debug_assert(this.n_idle_all>=0 && this.n_busy_all>=0);
		if (this.n_busy_all == 0)
		{	this.onend();
		}
		conns.busy[i] = conns.busy[conns.busy.length - 1];
		conns.busy.length--;
		if (conn.is_broken_connection || --conn.use_n_times<=0 || conn.use_till<=Date.now())
		{	try
			{	this.save_unused_buffer(conn.close());
			}
			catch (e)
			{	this.onerror(e);
			}
		}
		else
		{	conns.idle.push(conn);
			this.n_idle_all++;
		}
		if (this.n_busy_all < this.maxConns)
		{	let n = this.have_slots_callbacks.length;
			if (n > 0)
			{	while (n-- > 0)
				{	this.have_slots_callbacks[n]();
				}
				this.have_slots_callbacks.length = 0;
			}
			else if (this.n_busy_all == 0)
			{	this.close_kept_alive_timed_out();
			}
		}
	}

	private close_kept_alive_timed_out(close_all_idle=false)
	{	let {conns_pool} = this;
		let now = Date.now();
		for (let [dsn, {idle, busy}] of conns_pool)
		{	for (let i=idle.length-1; i>=0; i--)
			{	let conn = idle[i];
				if (conn.use_till<=now || close_all_idle)
				{	idle.splice(i, 1);
					this.n_idle_all--;
					try
					{	this.save_unused_buffer(conn.close());
					}
					catch (e)
					{	this.onerror(e);
					}
				}
			}
			//
			if (busy.length+idle.length == 0)
			{	conns_pool.delete(dsn);
			}
		}
		if (this.n_busy_all+this.n_idle_all == 0)
		{	clearInterval(this.h_timer);
			this.h_timer = undefined;
		}
	}

	private close_exceeding_idle_conns(idle: MyProtocol[])
	{	debug_assert(this.n_busy_all <= this.maxConns);
		let n_close_idle = this.n_busy_all + this.n_idle_all - this.maxConns;
		while (n_close_idle > 0)
		{	let conn = idle.pop();
			if (!conn)
			{	for (let c_conns of this.conns_pool.values())
				{	while (true)
					{	conn = c_conns.idle.pop();
						if (!conn)
						{	break;
						}
						n_close_idle--;
						this.n_idle_all--;
						try
						{	this.save_unused_buffer(conn.close());
						}
						catch (e)
						{	this.onerror(e);
						}
						debug_assert(this.n_idle_all >= 0);
						if (n_close_idle == 0)
						{	return;
						}
					}
				}
				return;
			}
			n_close_idle--;
			this.n_idle_all--;
			try
			{	this.save_unused_buffer(conn.close());
			}
			catch (e)
			{	this.onerror(e);
			}
			debug_assert(this.n_idle_all >= 0);
		}
	}
}
