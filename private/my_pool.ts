import {debugAssert} from './debug_assert.ts';
import {Dsn} from './dsn.ts';
import {ServerDisconnectedError} from "./errors.ts";
import {DEFAULT_MAX_CONNS, MyConn, MyConnInternal, OnBeforeCommit} from './my_conn.ts';
import {MyProtocol, OnLoadFile, Logger} from './my_protocol.ts';
import {MySession, MySessionInternal} from "./my_session.ts";
import {XaIdGen} from "./xa_id_gen.ts";
import {SafeSqlLogger} from "./sql_logger.ts";
import {crc32} from "./deps.ts";

const SAVE_UNUSED_BUFFERS = 10;
const DEFAULT_MAX_CONNS_WAIT_QUEUE = 50;
const DEFAULT_CONNECTION_TIMEOUT_MSEC = 5000;
const DEFAULT_RECONNECT_INTERVAL_MSEC = 500;
const DEFAULT_KEEP_ALIVE_TIMEOUT_MSEC = 10000;
const DEFAULT_KEEP_ALIVE_MAX = Number.MAX_SAFE_INTEGER;
const KEEPALIVE_CHECK_EACH_MSEC = 1000;
const DEFAULT_DANGLING_XA_CHECK_EACH_MSEC = 6000;

export type XaInfoTable = {dsn: Dsn, table: string, hash: number};

export interface MyPoolOptions
{	dsn?: Dsn | string;
	/**	Like backlog. When there're `maxConns` connections, next connections will wait.
	 **/
	maxConnsWaitQueue?: number;
	onLoadFile?: OnLoadFile;
	onBeforeCommit?: OnBeforeCommit;
	managedXaDsns?: Dsn | string | (Dsn|string)[];
	xaCheckEach?: number;
	xaInfoTables?: {dsn: Dsn|string, table: string}[];
	logger?: Logger;
}

type HaveSlotsCallback = {y: () => void, till: number};

class MyPoolConns
{	idle: MyProtocol[] = [];
	busy: MyProtocol[] = [];
	nConnecting = 0;
	haveSlotsCallbacks: HaveSlotsCallback[] = [];
}

export class MyPool
{	private connsPool = new Map<number, MyPoolConns>();
	private unusedBuffers: Uint8Array[] = [];
	private nIdleAll = 0;
	private nBusyAll = 0;
	private nSessionsOrConns = 0;
	private hTimer: number | undefined;
	private xaTask: XaTask;
	private curRetryingPromise: Promise<true> | undefined;
	private isShuttingDown = false;
	private onend: (() => void) | undefined;

	private dsn: Dsn | undefined;
	private maxConnsWaitQueue = DEFAULT_MAX_CONNS_WAIT_QUEUE;
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
			{	this.xaTask.xaCheckEach = xaCheckEach>0 ? xaCheckEach : DEFAULT_DANGLING_XA_CHECK_EACH_MSEC;
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
			// logger
			this.xaTask.logger = logger ?? console;
		}
		const {dsn, maxConnsWaitQueue, onLoadFile, onBeforeCommit, xaTask: {managedXaDsns, xaCheckEach, xaInfoTables, logger}} = this;
		return {dsn, maxConnsWaitQueue, onLoadFile, onBeforeCommit, managedXaDsns, xaCheckEach, xaInfoTables, logger};
	}

	/**	Wait till all active sessions and connections complete, and close idle connections in the pool.
		Then new connections will be rejected, and this object will be unusable.
	 **/
	async shutdown()
	{	this.isShuttingDown = true;
		try
		{	if (this.nSessionsOrConns!=0 || this.nBusyAll!=0)
			{	await new Promise<void>(y => this.onend = y);
			}
			// close idle connections
			await this.closeKeptAliveTimedOut(true);
		}
		finally
		{	this.isShuttingDown = false;
		}
	}

	private async waitHaveSlots(dsn: Dsn, till: number, haveSlotsCallbacks: HaveSlotsCallback[])
	{	const maxConns = dsn.maxConns || DEFAULT_MAX_CONNS;
		const reconnectInterval = dsn.reconnectInterval>=0 ? dsn.reconnectInterval : DEFAULT_RECONNECT_INTERVAL_MSEC;
		while (this.nBusyAll >= maxConns)
		{	this.closeHaveSlotsTimedOut(haveSlotsCallbacks);
			const now = Date.now();
			if (now >= till) // with connectionTimeout==0 must not retry
			{	return false;
			}
			if (haveSlotsCallbacks.length >= this.maxConnsWaitQueue)
			{	return false;
			}
			const iterTill = Math.min(till, now + reconnectInterval);
			const promiseYes = new Promise<void>(y => {haveSlotsCallbacks.push({y, till: iterTill})});
			let hTimer;
			const promiseNo = new Promise<void>(y => {hTimer = setTimeout(y, iterTill-now)});
			await Promise.race([promiseYes, promiseNo]);
			clearTimeout(hTimer);
		}
		return true;
	}

	async session<T>(callback: (session: MySession) => Promise<T>)
	{	if (this.isShuttingDown)
		{	throw new Error(`Connections pool is shut down`);
		}
		const session = new MySessionInternal(this, this.dsn, this.xaTask.xaInfoTables, this.xaTask.logger, this.getConnFunc, this.returnConnFunc, this.onBeforeCommit);
		try
		{	this.nSessionsOrConns++;
			return await callback(session);
		}
		finally
		{	session.endSession();
			if (--this.nSessionsOrConns==0 && this.nBusyAll==0)
			{	this.onend?.();
			}
		}
	}

	async forConn<T>(callback: (conn: MyConn) => Promise<T>, dsn?: Dsn|string)
	{	if (this.isShuttingDown && this.nSessionsOrConns==0)
		{	throw new Error(`Connections pool is shut down`);
		}
		if (dsn == undefined)
		{	dsn = this.dsn;
			if (dsn == undefined)
			{	throw new Error(`DSN not provided, and also default DSN was not specified`);
			}
		}
		else if (typeof(dsn) == 'string')
		{	dsn = new Dsn(dsn);
		}
		const conn = new MyConnInternal(dsn, undefined, this.xaTask.logger, this.getConnFunc, this.returnConnFunc, this.onBeforeCommit);
		try
		{	this.nSessionsOrConns++;
			return await callback(conn);
		}
		finally
		{	conn.endAndDisposeSqlLogger();
			if (--this.nSessionsOrConns==0 && this.nBusyAll==0)
			{	this.onend?.();
			}
		}
	}

	private saveUnusedBuffer(buffer: Uint8Array)
	{	if (this.unusedBuffers.length < SAVE_UNUSED_BUFFERS)
		{	this.unusedBuffers.push(buffer);
		}
	}

	private async newConn(dsn: Dsn, sqlLogger: SafeSqlLogger|undefined)
	{	const unusedBuffer = this.unusedBuffers.pop();
		const connectionTimeout = dsn.connectionTimeout>=0 ? dsn.connectionTimeout : DEFAULT_CONNECTION_TIMEOUT_MSEC;
		const reconnectInterval = dsn.reconnectInterval>=0 ? dsn.reconnectInterval : DEFAULT_RECONNECT_INTERVAL_MSEC;
		let now = Date.now();
		const connectTill = now + connectionTimeout;
		for (let i=0; true; i++)
		{	try
			{	return await MyProtocol.inst(dsn, unusedBuffer, this.onLoadFile, sqlLogger, this.xaTask.logger);
			}
			catch (e)
			{	// with connectionTimeout==0 must not retry
				now = Date.now();
				if (reconnectInterval==0 || now>=connectTill || !(e instanceof ServerDisconnectedError) && e.name!='ConnectionRefused')
				{	throw e;
				}
				if (this.curRetryingPromise)
				{	let hTimer;
					const promiseNo = new Promise(y => {hTimer = setTimeout(y, connectTill-now)});
					if (true !== await Promise.race([this.curRetryingPromise, promiseNo])) // `this.curRetryingPromise` resolves to `true`
					{	throw e;
					}
					clearTimeout(hTimer);
				}
				else
				{	const wait = Math.min(reconnectInterval, connectTill-now);
					this.xaTask.logger.warn(`Couldn't connect to ${dsn}. Will retry after ${wait} msec.`, e);
					this.curRetryingPromise = new Promise
					(	y =>
						setTimeout
						(	() =>
							{	this.curRetryingPromise = undefined;
								y(true);
							},
							wait
						)
					);
					await this.curRetryingPromise;
				}
			}
		}
	}

	private async closeConn(conn: MyProtocol, maxConns: number, haveSlotsCallbacks: HaveSlotsCallback[])
	{	this.nBusyAll++;
		try
		{	const buffer = await conn.end();
			if (buffer instanceof Uint8Array)
			{	this.saveUnusedBuffer(buffer);
			}
		}
		catch (e)
		{	// must not happen
			this.xaTask.logger.error(e);
		}
		this.decNBusyAll(maxConns, haveSlotsCallbacks);
	}

	private decNBusyAll(maxConns: number, haveSlotsCallbacks: HaveSlotsCallback[])
	{	const nBusyAll = --this.nBusyAll;
		const n = haveSlotsCallbacks.length;
		if (n == 0)
		{	if (nBusyAll == 0)
			{	if (this.nIdleAll == 0)
				{	clearInterval(this.hTimer);
					this.hTimer = undefined;
				}
				if (this.nSessionsOrConns == 0)
				{	this.onend?.();
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

	private async getConn(dsn: Dsn, sqlLogger: SafeSqlLogger|undefined)
	{	debugAssert(this.nIdleAll>=0 && this.nBusyAll>=0);
		// 1. Find connsPool
		const keepAliveTimeout = dsn.keepAliveTimeout>=0 ? dsn.keepAliveTimeout : DEFAULT_KEEP_ALIVE_TIMEOUT_MSEC;
		const keepAliveMax = dsn.keepAliveMax>=0 ? dsn.keepAliveMax : DEFAULT_KEEP_ALIVE_MAX;
		let conns = this.connsPool.get(dsn.hash);
		if (!conns)
		{	conns = new MyPoolConns;
			this.connsPool.set(dsn.hash, conns);
		}
		debugAssert(conns.nConnecting >= 0);
		const {idle, busy, haveSlotsCallbacks} = conns;
		// 2. Wait for a free slot
		const maxConns = dsn.maxConns || DEFAULT_MAX_CONNS;
		if (busy.length+conns.nConnecting >= maxConns)
		{	const connectionTimeout = dsn.connectionTimeout>=0 ? dsn.connectionTimeout : DEFAULT_CONNECTION_TIMEOUT_MSEC;
			const till = Date.now() + connectionTimeout;
			while (true)
			{	if (Date.now()>=till || !await this.waitHaveSlots(dsn, till, haveSlotsCallbacks))
				{	throw new Error(`All the ${maxConns} free slots are occupied for this DSN: ${dsn.hostname}`);
				}
				// after awaiting the promise that `waitHaveSlots()` returned, some connection could be occupied again
				if (busy.length+conns.nConnecting < maxConns)
				{	break;
				}
			}
		}
		// 3. Connect
		const now = Date.now();
		while (true)
		{	let conn: MyProtocol|undefined;
			conn = idle.pop();
			if (!conn)
			{	conns.nConnecting++;
				this.nBusyAll++;
				try
				{	conn = await this.newConn(dsn, sqlLogger);
					conns.nConnecting--;
					this.nBusyAll--;
				}
				catch (e)
				{	conns.nConnecting--;
					this.decNBusyAll(maxConns, haveSlotsCallbacks);
					throw e;
				}
			}
			else if (conn.useTill <= now)
			{	this.nIdleAll--;
				this.closeConn(conn, maxConns, haveSlotsCallbacks);
				continue;
			}
			else
			{	this.nIdleAll--;
				conn.setSqlLogger(sqlLogger);
			}
			conn.useTill = Math.min(conn.useTill, now+keepAliveTimeout);
			conn.useNTimes = Math.min(conn.useNTimes, keepAliveMax);
			if (this.hTimer == undefined)
			{	this.hTimer = setInterval(() => {this.closeKeptAliveTimedOut()}, KEEPALIVE_CHECK_EACH_MSEC);
				this.xaTask.start();
			}
			busy.push(conn);
			this.nBusyAll++;
			return conn;
		}
	}

	private returnConn(dsn: Dsn, conn: MyProtocol, rollbackPreparedXaId: string, withDisposeSqlLogger: boolean)
	{	conn.end(rollbackPreparedXaId, --conn.useNTimes>0 && conn.useTill>Date.now(), withDisposeSqlLogger).then
		(	protocolOrBuffer =>
			{	let conns = this.connsPool.get(dsn.hash);
				let i = -1;
				if (conns)
				{	i = conns.busy.indexOf(conn);
				}
				if (i == -1)
				{	// maybe somebody edited properties of the Dsn object from outside, `connsPool.get(dsn.hash)` was not found, because the `dsn.name` changed
					for (const conns2 of this.connsPool.values())
					{	i = conns2.busy.findIndex(conn => conn.dsn == dsn);
						if (i != -1)
						{	conns = conns2;
							break;
						}
					}
				}
				if (!conns || i==-1)
				{	// assume: returnConn() already called for this connection
					return;
				}
				debugAssert(this.nIdleAll>=0 && this.nBusyAll>=1);
				conns.busy[i] = conns.busy[conns.busy.length - 1];
				conns.busy.length--;
				if (protocolOrBuffer instanceof Uint8Array)
				{	this.saveUnusedBuffer(protocolOrBuffer);
				}
				else if (protocolOrBuffer)
				{	conns.idle.push(protocolOrBuffer);
					this.nIdleAll++;
				}
				const maxConns = dsn.maxConns || DEFAULT_MAX_CONNS;
				this.decNBusyAll(maxConns, conns.haveSlotsCallbacks);
			}
		);
	}

	private closeKeptAliveTimedOut(closeAllIdle=false)
	{	const {connsPool} = this;
		const now = Date.now();
		const promises = [];
		for (const [dsnHash, {idle, busy, nConnecting, haveSlotsCallbacks}] of connsPool)
		{	for (let i=idle.length-1; i>=0; i--)
			{	const conn = idle[i];
				if (conn.useTill<=now || closeAllIdle)
				{	idle.splice(i, 1);
					this.nIdleAll--;
					const maxConns = conn.dsn.maxConns || DEFAULT_MAX_CONNS;
					promises[promises.length] = this.closeConn(conn, maxConns, haveSlotsCallbacks);
				}
			}
			//
			if (busy.length+idle.length+nConnecting == 0)
			{	connsPool.delete(dsnHash);
			}
			//
			this.closeHaveSlotsTimedOut(haveSlotsCallbacks);
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

	private closeHaveSlotsTimedOut(haveSlotsCallbacks: HaveSlotsCallback[])
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
}

class XaTask
{	managedXaDsns: Dsn[] = [];
	xaCheckEach = DEFAULT_DANGLING_XA_CHECK_EACH_MSEC;
	xaInfoTables: XaInfoTable[] = [];
	logger: Logger = console;

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
					(	this.managedXaDsns.map
						(	async dsn =>
							{	const conn = session.conn(dsn);
								// 1. Read XA RECOVER
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
						{	this.logger.error(res.reason);
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
						{	this.logger.error(res.reason);
						}
					}
					// 3. Rollback or commit
					const promises3 = [];
					for (const items of byConn.values())
					{	let promise = Promise.resolve();
						for (const {conn, xaId, time, pid, connectionId, commit} of items)
						{	promise = promise.then
							(	() => conn.queryVoid((commit ? "XA COMMIT '" : " XA ROLLBACK '")+xaId+"'")
							).then
							(	() =>
								{	this.logger.warn(`${commit ? 'Committed' : 'Rolled back'} dangling transaction ${xaId} because it's MySQL process ID ${connectionId} was dead. Transaction started before ${Math.floor(Date.now()/1000) - time} sec by OS process ${pid}.`);
								}
							);
						}
						promises3[promises3.length] = promise;
					}
					const results3 = await Promise.allSettled(promises3);
					for (const res of results3)
					{	if (res.status == 'rejected')
						{	this.logger.error(res.reason);
						}
					}
				}
			);
		}
		catch (e)
		{	this.logger.error(e);
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
