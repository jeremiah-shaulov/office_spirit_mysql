import {debugAssert} from './debug_assert.ts';
import {Dsn} from './dsn.ts';
import {ServerDisconnectedError, SqlError} from "./errors.ts";
import {DEFAULT_MAX_CONNS, MyConn, MyConnInternal, OnBeforeCommit} from './my_conn.ts';
import {MyProtocol, OnLoadFile, Logger, TakeCareOfDisconneced} from './my_protocol.ts';
import {MySession} from "./my_session.ts";
import {XaIdGen} from "./xa_id_gen.ts";
import {SafeSqlLogger} from "./sql_logger.ts";
import {crc32} from "./deps.ts";
import {Interval} from './interval.ts';
import {ErrorCodes} from './constants.ts';

const SAVE_UNUSED_BUFFERS = 10;
const DEFAULT_MAX_CONNS_WAIT_QUEUE = 50;
const DEFAULT_CONNECTION_TIMEOUT_MSEC = 5000;
const DEFAULT_RECONNECT_INTERVAL_MSEC = 500;
const DEFAULT_KEEP_ALIVE_TIMEOUT_MSEC = 10000;
const DEFAULT_KEEP_ALIVE_MAX = Number.MAX_SAFE_INTEGER;
const KEEPALIVE_CHECK_AND_CLEAR_DISCONNECTED_EACH_MSEC = 1000;
const DEFAULT_DANGLING_XA_CHECK_EACH_MSEC = 6000;
const TRACK_HEALH_STATUS_FOR_PERIOD_SEC = 60;

export type XaInfoTable = {dsn: Dsn, table: string, hash: number};

export interface MyPoolOptions
{	/**	Default Data Source Name for the pool.
	 **/
	dsn?: Dsn | string;

	/**	When {@link Dsn.maxConns} exceeded, new connection requests will enter waiting queue (like backlog). This is the queue maximum size.
		@default 50
	 **/
	maxConnsWaitQueue?: number;

	/**	Handler for `LOAD DATA LOCAL INFILE` query.
	 **/
	onLoadFile?: OnLoadFile;

	/**	Callback that will be called every time a transaction is about to be committed.
	 **/
	onBeforeCommit?: OnBeforeCommit;

	/**	Will automatically manage distributed transactions on DSNs listed here (will rollback or commit dangling transactions).
	 **/
	managedXaDsns?: Dsn | string | (Dsn|string)[];

	/**	Check for dangling transactions each this number of milliseconds.
		@default 6000
	 **/
	xaCheckEach?: number;

	/**	You can provide tables (that you need to create), that will improve distributed transactions management (optional).
	 **/
	xaInfoTables?: {dsn: Dsn|string, table: string}[];

	/**	A `console`-compatible logger, or `globalThis.console`. It will be used to report errors and print log messages.
	 **/
	logger?: Logger;
}

class OptionsManager
{	dsn: Dsn|undefined;
	maxConnsWaitQueue = DEFAULT_MAX_CONNS_WAIT_QUEUE;
	onLoadFile: OnLoadFile|undefined;
	onBeforeCommit: OnBeforeCommit|undefined;
	managedXaDsns = new Array<Dsn>;
	xaCheckEach = DEFAULT_DANGLING_XA_CHECK_EACH_MSEC;
	xaInfoTables = new Array<XaInfoTable>;
	logger: Logger = console;

	/**	Set and/or get configuration.
	 **/
	update(options?: Dsn|string|MyPoolOptions): MyPoolOptions
	{	if (options)
		{	if (typeof(options)=='string' || (options instanceof Dsn))
			{	options = {dsn: options};
			}
			const {dsn, maxConnsWaitQueue, onLoadFile, onBeforeCommit, managedXaDsns, xaCheckEach, xaInfoTables, logger} = options;
			// dsn
			if (typeof(dsn) == 'string')
			{	this.dsn = dsn ? new Dsn(dsn) : undefined;
			}
			else if (dsn)
			{	this.dsn = dsn;
			}
			// maxConnsWaitQueue
			if (typeof(maxConnsWaitQueue) == 'number')
			{	this.maxConnsWaitQueue = maxConnsWaitQueue>=0 ? maxConnsWaitQueue : DEFAULT_MAX_CONNS_WAIT_QUEUE;
			}
			// onLoadFile
			this.onLoadFile = onLoadFile;
			// onBeforeCommit
			this.onBeforeCommit = onBeforeCommit;
			// managedXaDsns
			if (typeof(managedXaDsns) == 'string')
			{	this.managedXaDsns.length = 0;
				if (managedXaDsns)
				{	this.managedXaDsns[0] = new Dsn(managedXaDsns);
				}
			}
			else if (managedXaDsns instanceof Dsn)
			{	this.managedXaDsns.length = 0;
				if (managedXaDsns)
				{	this.managedXaDsns[0] = managedXaDsns;
				}
			}
			else if (managedXaDsns)
			{	this.managedXaDsns.length = 0;
				for (const item of managedXaDsns)
				{	if (item)
					{	this.managedXaDsns.push(typeof(item)=='string' ? new Dsn(item) : item);
					}
				}
			}
			// xaCheckEach
			if (typeof(xaCheckEach) == 'number')
			{	this.xaCheckEach = xaCheckEach>0 ? xaCheckEach : DEFAULT_DANGLING_XA_CHECK_EACH_MSEC;
			}
			// xaInfoTables
			if (xaInfoTables)
			{	this.xaInfoTables.length = 0;
				for (const {dsn, table} of xaInfoTables)
				{	if (dsn && table)
					{	const dsnObj = typeof(dsn)=='string' ? new Dsn(dsn) : dsn;
						const hash = (dsnObj.hash ^ crc32(table)) >>> 0;
						if (this.xaInfoTables.findIndex(v => v.hash == hash) == -1)
						{	this.xaInfoTables.push({dsn: dsnObj, table, hash});
						}
					}
				}
			}
			// logger
			this.logger = logger ?? console;
		}
		const {dsn, maxConnsWaitQueue, onLoadFile, onBeforeCommit, managedXaDsns, xaCheckEach, xaInfoTables, logger} = this;
		return {dsn, maxConnsWaitQueue, onLoadFile, onBeforeCommit, managedXaDsns, xaCheckEach, xaInfoTables, logger};
	}
}

type HaveSlotsCallback = {y: VoidFunction, till: number};

export type PoolStatus =
{	/**	Number of connections that are in use.
	 **/
	nBusy: number;

	/**	Number of connections that are idle.
	 **/
	nIdle: number;

	/**	Health status that reflects the ratio of successful and failed connection attempts.
		The connection attempts are those when no idle connection was found in the pool, and new connection was created.
		This library tracks the health status for the last 1 minute, and you can specify the period (1 - 60 sec) for which to return the status in {@link MyPool.getStatus()}.
		0.0 - all failed, 1.0 - all successful, NaN - there were no connection attempts.
	 **/
	healthStatus: number;
};

export class MyPool
{	#pool = new Pool;

	constructor(options?: Dsn|string|MyPoolOptions)
	{	this.options(options);
	}

	/**	Patches configuration options (if `options` parameter is provided).
		Returns the new options.
	 **/
	options(options?: Dsn|string|MyPoolOptions)
	{	return this.#pool.updateOptions(options);
	}

	/**	Wait till all active sessions and connections complete, and close idle connections in the pool.
		Then new connections will be rejected, and this object will be unusable.
	 **/
	[Symbol.asyncDispose]()
	{	return this.#pool[Symbol.asyncDispose]();
	}

	/**	Deprecated alias of `this[Symbol.asyncDispose]()`.
		@deprecated
	 **/
	shutdown()
	{	return this[Symbol.asyncDispose]();
	}

	/**	Get {@link MySession} object, that allows to get connections to different database servers.
		Unlike {@link getConn()}, getting connection from {@link MySession.conn()} returns the same
		connection object if asked the same server.
	 **/
	getSession()
	{	return new MySession(this.#pool);
	}

	/**	Execute callback with new {@link MySession} object, and then destroy the object.
	 **/
	async forSession<T>(callback: (session: MySession) => Promise<T>)
	{	using session = this.getSession();
		return await callback(session);
	}

	/**	Deprecated alias of `forSession()`.
		@deprecated
	 **/
	session<T>(callback: (session: MySession) => Promise<T>)
	{	return this.forSession(callback);
	}

	/**	Get connection to server.
		@param dsn To which server to connect. If not specified, returns connection to pool-defaul @{link Dsn}.
		@returns New connection object from the pool. It can be a reused connection, or new empty object that will establish the actual connection on first query.
	 **/
	getConn(dsn?: Dsn|string): MyConn
	{	if (dsn == undefined)
		{	dsn = this.#pool.options.dsn;
			if (dsn == undefined)
			{	throw new Error(`DSN not provided, and also default DSN was not specified`);
			}
		}
		else if (typeof(dsn) == 'string')
		{	dsn = new Dsn(dsn);
		}
		return new MyConnInternal(dsn, this.#pool);
	}

	/**	Execute callback with new {@link MyConn} object, and then destroy the object.
	 **/
	async forConn<T>(callback: (conn: MyConn) => Promise<T>, dsn?: Dsn|string)
	{	using conn = this.getConn(dsn);
		return await callback(conn);
	}

	/**	@param healthStatusForPeriodSec The period in seconds for which to return the health status (1 - 60 inclusive).
	 **/
	getStatus(healthStatusForPeriodSec=TRACK_HEALH_STATUS_FOR_PERIOD_SEC)
	{	return this.#pool.getStatus(healthStatusForPeriodSec);
	}
}

export class Pool
{	#protocolsPerSchema = new Map<number, Protocols>;
	#protocolsFactory = new ProtocolsFactory;
	#nIdleAll = 0;
	#nBusyAll = 0;
	#useCnt = 0;
	#hCommonTask = new Interval(() => this.#commonTask(), KEEPALIVE_CHECK_AND_CLEAR_DISCONNECTED_EACH_MSEC);
	#hXaTask = new Interval(() => this.#xaTask(), Number.MAX_SAFE_INTEGER);
	#onend: VoidFunction|undefined;
	#takeCareOfDisconneced = new Array<TakeCareOfDisconneced>;

	options = new OptionsManager;

	async [Symbol.asyncDispose]()
	{	if (this.#useCnt!=0 || this.#nBusyAll!=0)
		{	await new Promise<void>(y => this.#onend = y);
		}
		await Promise.all
		(	[	this.#hCommonTask[Symbol.asyncDispose](),
				this.#hXaTask[Symbol.asyncDispose](),
			]
		);
		// close idle connections
		await this.#commonTask(true);
	}

	updateOptions(options?: Dsn|string|MyPoolOptions)
	{	const result = this.options.update(options);
		if (this.options.managedXaDsns.length)
		{	this.#hXaTask.delayMsec = this.options.xaCheckEach;
			this.#hXaTask.start();
		}
		else
		{	this.#hXaTask.stop();
		}
		return result;
	}

	ref()
	{	this.#useCnt++;
	}

	unref()
	{	if (--this.#useCnt==0 && this.#nBusyAll==0)
		{	this.#onend?.();
		}
	}

	getStatus(healthStatusForPeriodSec: number)
	{	const now = Date.now();
		const status = new Map<Dsn, PoolStatus>;
		for (const {idle, busy, healthStatus} of this.#protocolsPerSchema.values())
		{	const dsn = idle[0]?.dsn ?? busy[0]?.dsn;
			if (dsn)
			{	const h = healthStatus.getHealthStatusForPeriod(healthStatusForPeriodSec, now);
				status.set(dsn, {nBusy: busy.length, nIdle: idle.length, healthStatus: h});
			}
		}
		return status;
	}

	async getProtocol(dsn: Dsn, pendingChangeSchema: string, sqlLogger: SafeSqlLogger|undefined)
	{	debugAssert(this.#nIdleAll>=0 && this.#nBusyAll>=0 && this.#useCnt>=0);
		let now = Date.now();
		const keepAliveTimeout = dsn.keepAliveTimeout>=0 ? dsn.keepAliveTimeout : DEFAULT_KEEP_ALIVE_TIMEOUT_MSEC;
		const keepAliveMax = dsn.keepAliveMax>=0 ? dsn.keepAliveMax : DEFAULT_KEEP_ALIVE_MAX;
		const maxConns = dsn.maxConns || DEFAULT_MAX_CONNS;
		const connectionTimeout = dsn.connectionTimeout>=0 ? dsn.connectionTimeout : DEFAULT_CONNECTION_TIMEOUT_MSEC;
		const reconnectInterval = dsn.reconnectInterval>=0 ? dsn.reconnectInterval : DEFAULT_RECONNECT_INTERVAL_MSEC;
		// 1. Find in protocolsPerSchema
		let conns = this.#protocolsPerSchema.get(dsn.hash);
		if (!conns)
		{	conns = new Protocols;
			this.#protocolsPerSchema.set(dsn.hash, conns);
		}
		debugAssert(conns.nConnecting >= 0);
		const {idle, busy, haveSlotsCallbacks, healthStatus} = conns;
		// 2. Wait for a free slot
		const till = now + connectionTimeout;
		while (busy.length+conns.nConnecting >= maxConns)
		{	if (now>=till || !await this.#waitHaveSlots(conns, now, till, reconnectInterval))
			{	throw new Error(`All the ${maxConns} free slots are occupied for this DSN: ${dsn.hostname}`);
			}
			// after awaiting the promise that `waitHaveSlots()` returned, some connection could be occupied again
			now = Date.now();
		}
		// 3. Connect
		while (true)
		{	let protocol = idle.pop();
			if (!protocol && dsn.schema)
			{	protocol = this.#stealIdleProtocolWithTheSameHost(dsn);
				if (protocol && !pendingChangeSchema)
				{	pendingChangeSchema = dsn.schema;
				}
			}
			if (!protocol)
			{	conns.nConnecting++;
				this.#nBusyAll++;
				try
				{	protocol = await this.#protocolsFactory.newConn(dsn, pendingChangeSchema, this.#takeCareOfDisconneced, this.options.onLoadFile, sqlLogger, this.options.logger);
					conns.nConnecting--;
					this.#nBusyAll--;
					healthStatus.log(true, now);
				}
				catch (e)
				{	conns.nConnecting--;
					this.#decNBusyAll(maxConns, haveSlotsCallbacks);
					healthStatus.log(false, now);
					throw e;
				}
			}
			else if (protocol.useTill <= now)
			{	this.#nIdleAll--;
				this.#closeConn(protocol, maxConns, haveSlotsCallbacks);
				continue;
			}
			else
			{	this.#nIdleAll--;
				protocol.use(pendingChangeSchema);
				protocol.setSqlLogger(sqlLogger);
			}
			protocol.useTill = Math.min(protocol.useTill, now+keepAliveTimeout);
			protocol.useNTimes = Math.min(protocol.useNTimes, keepAliveMax);
			this.#hCommonTask.start();
			busy.push(protocol);
			this.#nBusyAll++;
			return protocol;
		}
	}

	async returnProtocol(protocol: MyProtocol, rollbackPreparedXaId: string, withDisposeSqlLogger: boolean)
	{	const protocolForReuse = await this.#protocolsFactory.closeConn(protocol, rollbackPreparedXaId, --protocol.useNTimes>0 && protocol.useTill>Date.now(), withDisposeSqlLogger);
		this.#doReturnProtocol(protocol, protocolForReuse);
	}

	returnProtocolAndForceImmediateDisconnect(protocol: MyProtocol, rollbackPreparedXaId: string, killCurQuery: boolean)
	{	const wasInQueryingState = protocol.forceImmediateDisconnect();
		killCurQuery &&= wasInQueryingState;
		if (rollbackPreparedXaId || killCurQuery)
		{	this.#takeCareOfDisconneced.push({dsn: protocol.dsn, rollbackPreparedXaId, killConnectionId: killCurQuery ? protocol.connectionId : 0});
			this.#hCommonTask.start(true);
		}
		this.#doReturnProtocol(protocol);
		return wasInQueryingState;
	}

	#doReturnProtocol(protocol: MyProtocol, protocolForReuse?: MyProtocol)
	{	const {dsn} = protocol;
		let conns = this.#protocolsPerSchema.get(dsn.hash);
		let i = -1;
		if (conns)
		{	i = conns.busy.indexOf(protocol);
		}
		if (i == -1)
		{	// maybe somebody edited properties of the Dsn object from outside, `protocolsPerSchema.get(dsn.hash)` was not found, because the `dsn.name` changed
			for (const conns2 of this.#protocolsPerSchema.values())
			{	i = conns2.busy.findIndex(p => p.dsn == dsn);
				if (i != -1)
				{	conns = conns2;
					break;
				}
			}
		}
		if (!conns || i==-1)
		{	// assume: returnProtocol already called for this connection
			return;
		}
		debugAssert(this.#nIdleAll>=0 && this.#nBusyAll>=1);
		conns.busy[i] = conns.busy[conns.busy.length - 1];
		conns.busy.length--;
		if (protocolForReuse)
		{	conns.idle.push(protocolForReuse);
			this.#nIdleAll++;
		}
		const maxConns = dsn.maxConns || DEFAULT_MAX_CONNS;
		this.#decNBusyAll(maxConns, conns.haveSlotsCallbacks);
	}

	#stealIdleProtocolWithTheSameHost(dsn: Dsn)
	{	const {hashNoSchema} = dsn;
		for (const {idle} of this.#protocolsPerSchema.values())
		{	const protocol = idle[idle.length - 1];
			if (protocol?.dsn.hashNoSchema === hashNoSchema)
			{	idle.length--;
				protocol.dsn = dsn;
				return protocol;
			}
		}
	}

	async #waitHaveSlots(conns: Protocols, now: number, till: number, reconnectInterval: number)
	{	this.#closeHaveSlotsTimedOut(conns.haveSlotsCallbacks);
		if (conns.haveSlotsCallbacks.length >= this.options.maxConnsWaitQueue)
		{	return false;
		}
		const iterTill = Math.min(till, now + reconnectInterval);
		let hTimer;
		const promiseNo = new Promise<void>(y => {hTimer = setTimeout(y, iterTill-now)});
		const hTimer2 = hTimer;
		const promiseYes = new Promise<void>(y => {conns.haveSlotsCallbacks.push({y, till: iterTill}); clearTimeout(hTimer2)});
		await Promise.race([promiseYes, promiseNo]);
		return true;
	}

	async #closeConn(protocol: MyProtocol, maxConns: number, haveSlotsCallbacks: HaveSlotsCallback[])
	{	this.#nBusyAll++;
		try
		{	await this.#protocolsFactory.closeConn(protocol);
		}
		catch (e)
		{	// must not happen
			this.options.logger.error(e);
		}
		this.#decNBusyAll(maxConns, haveSlotsCallbacks);
	}

	#decNBusyAll(maxConns: number, haveSlotsCallbacks: HaveSlotsCallback[])
	{	const nBusyAll = --this.#nBusyAll;
		const n = haveSlotsCallbacks.length;
		if (n == 0)
		{	if (nBusyAll == 0)
			{	if (this.#nIdleAll+this.#takeCareOfDisconneced.length == 0)
				{	this.#hCommonTask.stop();
				}
				if (this.#useCnt == 0)
				{	this.#onend?.();
				}
			}
		}
		else if (nBusyAll < maxConns)
		{	for (let i=0; i<n; i++)
			{	haveSlotsCallbacks[i].y();
			}
			haveSlotsCallbacks.length = 0;
		}
	}

	#closeHaveSlotsTimedOut(haveSlotsCallbacks: HaveSlotsCallback[])
	{	const now = Date.now();
		let n = haveSlotsCallbacks.length;
		for (let i=n-1; i>=0; i--)
		{	if (now >= haveSlotsCallbacks[i].till)
			{	const {y} = haveSlotsCallbacks[i];
				haveSlotsCallbacks[i] = haveSlotsCallbacks[--n];
				y();
			}
		}
		haveSlotsCallbacks.length = n;
	}

	/**	This is task callback (used with {@link Interval}).
		It closes idle connections that are kept alive for too long, and also takes care of forcely disconnected connections (see {@link MyConn.forceImmediateDisconnect()}).
	 **/
	async #commonTask(closeAllIdle=false)
	{	const protocolsPerSchema = this.#protocolsPerSchema;
		const now = Date.now();
		const promises = new Array<Promise<void>>;
		for (const [dsnHash, {idle, busy, nConnecting, haveSlotsCallbacks, healthStatus}] of protocolsPerSchema)
		{	let nIdle = idle.length;
			const wantCloseAllIdle = closeAllIdle || this.#takeCareOfDisconneced.findIndex(v => v.dsn.hash == dsnHash)!=-1;
			for (let i=nIdle-1; i>=0; i--)
			{	const protocol = idle[i];
				if (wantCloseAllIdle || protocol.useTill<=now)
				{	idle[i] = idle[--nIdle];
					this.#nIdleAll--;
					const maxConns = protocol.dsn.maxConns || DEFAULT_MAX_CONNS;
					promises[promises.length] = this.#closeConn(protocol, maxConns, haveSlotsCallbacks);
				}
			}
			idle.length = nIdle;
			// All removed?
			if (busy.length+nIdle+nConnecting==0 && healthStatus.isEmpty())
			{	protocolsPerSchema.delete(dsnHash);
			}
			//
			this.#closeHaveSlotsTimedOut(haveSlotsCallbacks);
		}
		const takeCareOfDisconneced = this.#takeCareOfDisconneced.slice();
		this.#takeCareOfDisconneced.length = 0;
L:		for (const info of takeCareOfDisconneced)
		{	const {dsn} = info;
			const maxConns = dsn.maxConns || DEFAULT_MAX_CONNS;
			for (const [dsnHash, {busy, nConnecting}] of protocolsPerSchema)
			{	if (dsnHash == dsn.hash)
				{	if (busy.length+nConnecting >= maxConns)
					{	continue L;
					}
				}
			}
			promises[promises.length] = this.getProtocol(dsn, '', undefined).then
			(	protocol =>
				{	if (closeAllIdle)
					{	protocol.useNTimes = 1;
					}
					return this.returnProtocol(protocol, '', false);
				},
				error =>
				{	this.#takeCareOfDisconneced.push(info);
					this.options.logger.error(error);
				}
			);
		}
		debugAssert(!closeAllIdle || this.#nIdleAll==0);
		if (this.#nBusyAll+this.#nIdleAll+this.#takeCareOfDisconneced.length == 0)
		{	this.#hCommonTask.stop();
		}
		await Promise.all(promises);
	}

	async #xaTask()
	{	using session = new MySession(this);
		// 1. Find dangling XAs (where owner connection id is dead) and corresponding xaInfoTables
		type Item = {conn: MyConn, table: string, xaId: string, xaId1: string, time: number, pid: number, connectionId: number, commit: boolean};
		const byInfoDsn = new Map<Dsn, Item[]>;
		const byConn = new Map<MyConn, Item[]>;
		const results = await Promise.allSettled
		(	this.options.managedXaDsns.map
			(	async dsn =>
				{	const conn = session.conn(dsn);
					// 1. Read XA RECOVER
					const xas = new Array<{xaId: string, xaId1: string, time: number, pid: number, hash: number, connectionId: number}>;
					const cids = new Array<number>;
					for await (const {data: xaId} of await conn.query<string>("XA RECOVER"))
					{	const m = XaIdGen.decode(xaId);
						if (m)
						{	const {time, pid, hash, connectionId, xaId1} = m;
							if (!isNaN(hash))
							{	xas[xas.length] = {xaId, xaId1, time, pid, hash, connectionId};
								if (cids.indexOf(connectionId) == -1)
								{	cids[cids.length] = connectionId;
								}
							}
						}
					}
					// 2. Filter `xas` array to preserve only dead connections
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
					{	const xaInfoTable = this.options.xaInfoTables.find(v => v.hash == hash);
						if (xaInfoTable)
						{	const {dsn, table} = xaInfoTable;
							const item = {conn, table, xaId, xaId1, time, pid, connectionId, commit: false};
							// add to byInfoDsn
							let items = byInfoDsn.get(dsn);
							if (!items)
							{	items = [];
								byInfoDsn.set(dsn, items);
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
				}
			)
		);
		for (const res of results)
		{	if (res.status == 'rejected')
			{	this.options.logger.error(res.reason);
			}
		}
		// 2. Find out should i rollback or commit, according to xaInfoTables
		const promises2 = new Array<Promise<void>>;
		for (const [dsn, items] of byInfoDsn)
		{	promises2[promises2.length] = Promise.resolve(session.conn(dsn)).then
			(	async conn =>
				{	const byTable = new Map<string, typeof items>;
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
		const results2 = await Promise.allSettled(promises2);
		for (const res of results2)
		{	if (res.status == 'rejected')
			{	this.options.logger.error(res.reason);
			}
		}
		// 3. Rollback or commit
		const promises3 = new Array<Promise<void>>;
		for (const items of byConn.values())
		{	let promise = Promise.resolve();
			for (const {conn, xaId, time, pid, connectionId, commit} of items)
			{	promise = promise.then
				(	() => conn.queryVoid((commit ? "XA COMMIT '" : " XA ROLLBACK '")+xaId+"'")
				).then
				(	() =>
					{	this.options.logger.warn(`${commit ? 'Committed' : 'Rolled back'} dangling transaction ${xaId} because it's MySQL thread ID ${connectionId} was dead. Transaction started ${Math.floor(Date.now()/1000) - time} sec ago by OS process ${pid}.`);
					}
				);
			}
			promises3[promises3.length] = promise;
		}
		const results3 = await Promise.allSettled(promises3);
		for (const res of results3)
		{	if (res.status == 'rejected')
			{	const {reason} = res;
				if (!(reason instanceof SqlError && reason.errorCode==ErrorCodes.ER_XAER_NOTA))
				{	this.options.logger.error(reason);
				}
			}
		}
	}
}

class Protocols
{	idle = new Array<MyProtocol>;
	busy = new Array<MyProtocol>;
	nConnecting = 0;
	haveSlotsCallbacks = new Array<HaveSlotsCallback>;
	healthStatus = new HealthStatus;
}

class ProtocolsFactory
{	#unusedBuffers = new Array<Uint8Array>;
	#curRetryingPromises = new Map<number, Promise<true>>;

	async newConn(dsn: Dsn, pendingChangeSchema: string, takeCareOfDisconneced: TakeCareOfDisconneced[], onLoadFile: OnLoadFile|undefined, sqlLogger: SafeSqlLogger|undefined, logger: Logger)
	{	const unusedBuffer = this.#unusedBuffers.pop();
		const connectionTimeout = dsn.connectionTimeout>=0 ? dsn.connectionTimeout : DEFAULT_CONNECTION_TIMEOUT_MSEC;
		const reconnectInterval = dsn.reconnectInterval>=0 ? dsn.reconnectInterval : DEFAULT_RECONNECT_INTERVAL_MSEC;
		let now = Date.now();
		const connectTill = now + connectionTimeout;
		for (let i=0; true; i++)
		{	try
			{	return await MyProtocol.inst(dsn, pendingChangeSchema, takeCareOfDisconneced, unusedBuffer, onLoadFile, sqlLogger, logger);
			}
			catch (e)
			{	// with connectionTimeout==0 must not retry
				now = Date.now();
				if (reconnectInterval==0 || now>=connectTill || !(e instanceof ServerDisconnectedError) && !(e instanceof Error && e.name=='ConnectionRefused'))
				{	throw e;
				}
				const dsnHash = dsn.hash;
				const curRetryingPromise = this.#curRetryingPromises.get(dsnHash);
				if (curRetryingPromise)
				{	let hTimer;
					const promiseNo = new Promise(y => {hTimer = setTimeout(y, connectTill-now)});
					if (true !== await Promise.race([curRetryingPromise, promiseNo])) // `curRetryingPromise` resolves to `true`
					{	throw e;
					}
					clearTimeout(hTimer);
				}
				else
				{	const wait = Math.min(reconnectInterval, connectTill-now);
					logger.warn(`Couldn't connect to ${dsn}. Will retry after ${wait} msec.`, e);
					const curRetryingPromise = new Promise<true>
					(	y =>
						setTimeout
						(	() =>
							{	this.#curRetryingPromises.delete(dsnHash);
								y(true);
							},
							wait
						)
					);
					this.#curRetryingPromises.set(dsnHash, curRetryingPromise);
					await curRetryingPromise;
				}
			}
		}
	}

	async closeConn(protocol: MyProtocol, rollbackPreparedXaId='', recycleConnection=false, withDisposeSqlLogger=false)
	{	const protocolOrBuffer = await protocol.end(rollbackPreparedXaId, recycleConnection, withDisposeSqlLogger);
		if (protocolOrBuffer instanceof Uint8Array)
		{	if (this.#unusedBuffers.length < SAVE_UNUSED_BUFFERS)
			{	this.#unusedBuffers.push(protocolOrBuffer);
			}
		}
		else
		{	return protocolOrBuffer;
		}
	}
}

class HealthStatus
{	#data = new Uint32Array(TRACK_HEALH_STATUS_FOR_PERIOD_SEC);
	#i = 0;
	#iSec = 0;

	isEmpty(now=Date.now())
	{	const sec = Math.trunc(now/1000);
		const diff = sec - this.#iSec;
		return diff > TRACK_HEALH_STATUS_FOR_PERIOD_SEC;
	}

	log(ok: boolean, now=Date.now())
	{	const sec = Math.trunc(now/1000);
		const data = this.#data;
		const diff = sec - this.#iSec;
		if (diff >= 0)
		{	let i = this.#i;
			if (diff >= TRACK_HEALH_STATUS_FOR_PERIOD_SEC)
			{	data.fill(0);
				i = 0;
				this.#iSec = sec;
			}
			else
			{	for (let iEnd=i+diff; i<iEnd;)
				{	if (++i == TRACK_HEALH_STATUS_FOR_PERIOD_SEC)
					{	i = 0;
						iEnd -= TRACK_HEALH_STATUS_FOR_PERIOD_SEC;
					}
					data[i] = 0;
				}
				this.#i = i;
			}
			const value = data[i];
			if ((ok ? value&0xFFFF : value>>16) < 0xFFFF)
			{	data[i] = value + (ok ? 1 : 0x10000);
			}
			else if ((ok ? value>>16 : value&0xFFFF) >= 0x10000/2)
			{	data[i] = value - (ok ? 0x10000 : 1);
			}
		}
	}

	getHealthStatusForPeriod(periodSec=TRACK_HEALH_STATUS_FOR_PERIOD_SEC, now=Date.now())
	{	const sec = Math.trunc(now/1000);
		const data = this.#data;
		let diff = sec - this.#iSec;
		if (diff < 0)
		{	periodSec += diff;
			diff = 0;
		}
		if (diff>=TRACK_HEALH_STATUS_FOR_PERIOD_SEC || periodSec<=0)
		{	return NaN;
		}
		let i = this.#i + diff;
		let nOk = 0;
		let nFail = 0;
		for (let iEnd=i+periodSec; i<iEnd;)
		{	if (++i == TRACK_HEALH_STATUS_FOR_PERIOD_SEC)
			{	i = 0;
				iEnd -= TRACK_HEALH_STATUS_FOR_PERIOD_SEC;
			}
			const value = data[i];
			nOk += value & 0xFFFF;
			nFail += value >> 16;
		}
		return nOk / (nOk + nFail);
	}
}
