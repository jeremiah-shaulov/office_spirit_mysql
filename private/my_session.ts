import {Dsn} from './dsn.ts';
import {MyConn, MyConnInternal, SAVEPOINT_ENUM_SESSION_FROM} from './my_conn.ts';
import {Pool, XaInfoTable} from "./my_pool.ts";
import {SqlLogger} from "./sql_logger.ts";
import {SqlLogToWritable} from "./sql_log_to_writable.ts";
import {XaIdGen} from "./xa_id_gen.ts";

const xaIdGen = new XaIdGen;

export class MySession
{	#connsArr = new Array<MyConnInternal>;
	#savepointEnum = 0;
	#trxOptions: {readonly: boolean, xaId1: string} | undefined;
	#curXaInfoTable: XaInfoTable | undefined;
	#sqlLogger: SqlLogger | true | undefined;
	#isDisposed = false;

	#pool;
	#onDispose;

	constructor(pool: Pool, onDispose?: VoidFunction)
	{	this.#pool = pool;
		this.#onDispose = onDispose;
	}

	/**	Disposes all the connections in this session.
		This method doesn't throw.
	 **/
	[Symbol.dispose]()
	{	const onDispose = this.#onDispose;
		const connsArr = this.#connsArr;
		this.#onDispose = undefined;
		this.#isDisposed = true;
		this.#connsArr = [];
		let error;
		for (const conn of connsArr)
		{	try
			{	conn[Symbol.dispose]();
			}
			catch (e)
			{	if (error != undefined)
				{	this.#pool.logger.error(error);
				}
				error = e;
			}
		}
		onDispose?.();
		if (error != undefined)
		{	throw error;
		}
	}

	get conns(): readonly MyConn[]
	{	return this.#connsArr;
	}

	conn(dsn?: Dsn|string, fresh=false)
	{	if (this.#isDisposed)
		{	throw new Error(`This session object is already disposed of`);
		}
		if (dsn == undefined)
		{	dsn = this.#pool.dsn;
			if (dsn == undefined)
			{	throw new Error(`DSN not provided, and also default DSN was not specified`);
			}
		}
		if (typeof(dsn) == 'string')
		{	dsn = new Dsn(dsn);
		}
		if (!fresh)
		{	const dsnStr = dsn.name;
			for (const conn of this.#connsArr)
			{	if (conn.dsn.name == dsnStr)
				{	return conn;
				}
			}
		}
		const conn = this.#pool.getConn(dsn);
		if (this.#trxOptions)
		{	conn.startTrx(this.#trxOptions);
		}
		if (this.#sqlLogger)
		{	conn.setSqlLogger(this.#sqlLogger);
		}
		for (let i=1; i<=this.#savepointEnum; i++)
		{	conn.sessionSavepoint(i);
		}
		this.#connsArr.push(conn);
		return conn;
	}

	/**	Commit current transaction (if any), and start new.
		If there're active transactions, they will be properly (2-phase if needed) committed.
		Then new transaction will be started on all connections in this session.
		If then you'll ask a new connection, it will join the transaction.
		If commit fails, this function does rollback, and throws the Error.
	 **/
	async startTrx(options?: {readonly?: boolean, xa?: boolean})
	{	// 1. Commit
		if (this.#connsArr.length)
		{	await this.commit();
		}
		// 2. options
		let readonly = !!options?.readonly;
		const xa = !!options?.xa;
		// 3. set this.trxOptions, this.curXaInfoTable, this.savepointEnum
		let xaId1 = '';
		let curXaInfoTable: XaInfoTable | undefined;
		if (xa)
		{	const xaInfoTables = this.#pool.xaTask.xaInfoTables;
			const {length} = xaInfoTables;
			let i = 0;
			if (length > 1)
			{	i = Math.floor(Math.random() * length);
				if (i == length)
				{	i = 0;
				}
			}
			curXaInfoTable = xaInfoTables[i];
			xaId1 = xaIdGen.next(curXaInfoTable?.hash);
			readonly = false;
		}
		const trxOptions = {readonly, xaId1};
		this.#trxOptions = trxOptions;
		this.#curXaInfoTable = curXaInfoTable;
		this.#savepointEnum = 0;
		// 4. Start transaction
		for (const conn of this.#connsArr)
		{	conn.startTrx(trxOptions); // this must return resolved promise
		}
	}

	/**	Create session-level savepoint, and return it's ID number.
		Then you can call `session.rollback(pointId)`.
		This is lazy operation. The corresponding command will be sent to the server later.
		Calling `savepoint()` immediately followed by `rollback(pointId)` to this point will send no commands.
		Using `MySession.savepoint()` doesn't interfere with `MyConn.savepoint()`, so it's possible to use both.
	 **/
	savepoint()
	{	const pointId = ++this.#savepointEnum;
		for (const conn of this.#connsArr)
		{	conn.sessionSavepoint(pointId);
		}
		return SAVEPOINT_ENUM_SESSION_FROM + pointId;
	}

	/**	Rollback all the active transactions in this session.
		If `toPointId` is not given or undefined - rolls back the whole transaction.
		If `toPointId` is a number returned from `savepoint()` call, rolls back all the transactions to that point.
		If `toPointId` is `0`, rolls back to the beginning of transaction, and doesn't end this transaction (also works with XAs).
		If rollback (not to savepoint) failed, will disconnect from server and throw ServerDisconnectedError.
		If `toPointId` was `0`, the transaction will be restarted after the disconnect if rollback failed.
	 **/
	async rollback(toPointId?: number)
	{	let wantRestartXa = false;
		if (typeof(toPointId) != 'number')
		{	this.#trxOptions = undefined;
			this.#curXaInfoTable = undefined;
			this.#savepointEnum = 0;
		}
		else if (toPointId === 0)
		{	if (this.#trxOptions?.xaId1)
			{	wantRestartXa = true;
				toPointId = undefined;
				this.#trxOptions = undefined;
				this.#curXaInfoTable = undefined;
			}
			this.#savepointEnum = 0;
		}
		else if (toPointId <= SAVEPOINT_ENUM_SESSION_FROM)
		{	throw new Error(`No such SAVEPOINT: ${toPointId}`);
		}
		else
		{	this.#savepointEnum = toPointId - (SAVEPOINT_ENUM_SESSION_FROM + 1);
		}
		const promises = new Array<Promise<void>>;
		for (const conn of this.#connsArr)
		{	promises[promises.length] = conn.rollback(toPointId);
		}
		let error;
		try
		{	await this.#doAll(promises);
		}
		catch (e)
		{	error = e;
		}
		if (wantRestartXa)
		{	try
			{	await this.startTrx(wantRestartXa ? {xa: true} : undefined); // this must return resolved promise, and not throw exceptions
			}
			catch (e)
			{	if (!error)
				{	error = e;
				}
				else
				{	this.#pool.logger.error(e);
				}
			}
		}
		if (error)
		{	throw error;
		}
	}

	/**	Commit all the active transactions in this session.
		If the session transaction was started with `{xa: true}`, will do 2-phase commit.
		If failed will rollback. If failed and `andChain` was true, will rollback and restart the same transaction (also XA).
		If rollback failed, will disconnect (and restart the transaction in case of `andChain`).
	 **/
	async commit(andChain=false)
	{	if (this.#trxOptions && this.#curXaInfoTable && this.#connsArr.length)
		{	using infoTableConn = this.#pool.getConn(this.#curXaInfoTable.dsn);
			await this.#doCommit(andChain, infoTableConn);
		}
		else
		{	await this.#doCommit(andChain);
		}
	}

	async #doCommit(andChain: boolean, infoTableConn?: MyConn)
	{	const trxOptions = this.#trxOptions;
		const curXaInfoTable = this.#curXaInfoTable;
		this.#trxOptions = undefined;
		this.#curXaInfoTable = undefined;
		this.#savepointEnum = 0;
		if (this.#connsArr.length)
		{	// 1. Connect to curXaInfoTable DSN (if throws exception, don't continue)
			if (infoTableConn)
			{	try
				{	await infoTableConn.connect();
					if (!infoTableConn.autocommit)
					{	await infoTableConn.queryVoid("SET autocommit=1");
					}
				}
				catch (e)
				{	this.#pool.logger.error(e);
					infoTableConn = undefined;
				}
			}
			// 2. Call onBeforeCommit
			if (this.#pool.onBeforeCommit)
			{	try
				{	await this.#pool.onBeforeCommit(this.conns);
				}
				catch (e)
				{	try
					{	await this.rollback(andChain ? 0 : undefined);
					}
					catch (e2)
					{	this.#pool.logger.error(e2);
					}
					throw e;
				}
			}
			// 3. Prepare commit
			const promises = new Array<Promise<void>>;
			for (const conn of this.#connsArr)
			{	if (conn.inXa)
				{	promises[promises.length] = conn.prepareCommit();
				}
			}
			if (promises.length)
			{	await this.#doAll(promises, true, andChain);
			}
			// 4. Log to XA info table
			if (trxOptions && curXaInfoTable && infoTableConn)
			{	try
				{	await infoTableConn.queryVoid(`INSERT INTO \`${curXaInfoTable.table}\` (\`xa_id\`) VALUES ('${trxOptions.xaId1}')`);
				}
				catch (e)
				{	this.#pool.logger.warn(`Couldn't add record to info table ${curXaInfoTable.table} on ${infoTableConn.dsn.name}`, e);
					infoTableConn = undefined;
				}
			}
			// 5. Commit
			promises.length = 0;
			for (const conn of this.#connsArr)
			{	promises[promises.length] = conn.commit();
			}
			await this.#doAll(promises);
			// 6. Remove record from XA info table
			if (trxOptions && curXaInfoTable && infoTableConn)
			{	try
				{	await infoTableConn.queryVoid(`DELETE FROM \`${curXaInfoTable.table}\` WHERE \`xa_id\` = '${trxOptions.xaId1}'`);
				}
				catch (e)
				{	this.#pool.logger.error(e);
				}
			}
			// 7. andChain
			if (andChain)
			{	await this.startTrx({readonly: trxOptions?.readonly, xa: !!trxOptions?.xaId1});
			}
		}
	}

	async #doAll(promises: Promise<unknown>[], rollbackOnError=false, rollbackAndChain=false)
	{	const result = await Promise.allSettled(promises);
		let error;
		for (const r of result)
		{	if (r.status == 'rejected')
			{	if (!error)
				{	error = r.reason;
				}
				else
				{	this.#pool.logger.error(r.reason);
				}
			}
		}
		if (error)
		{	if (rollbackOnError)
			{	try
				{	await this.rollback(rollbackAndChain ? 0 : undefined);
				}
				catch (e2)
				{	this.#pool.logger.debug(e2);
				}
			}
			throw error;
		}
	}

	setSqlLogger(sqlLogger?: SqlLogger|true)
	{	if (sqlLogger === true)
		{	sqlLogger = new SqlLogToWritable(Deno.stderr.writable, !Deno.noColor, undefined, undefined, undefined, this.#pool.logger); // want to pass the same object instance to each conn
		}
		this.#sqlLogger = sqlLogger;
		for (const conn of this.#connsArr)
		{	conn.setSqlLogger(sqlLogger);
		}
	}
}
