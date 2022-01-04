import {debugAssert} from './debug_assert.ts';
import {StatusFlags} from './constants.ts';
import {MyProtocol, RowType} from './my_protocol.ts';
import {SqlSource} from './my_protocol_reader_writer.ts';
import {BusyError, CanceledError, ServerDisconnectedError, SqlError} from './errors.ts';
import {Resultsets, ResultsetsInternal, ResultsetsPromise} from './resultsets.ts';
import type {Param, Params, ColumnValue} from './resultsets.ts';
import {Dsn} from './dsn.ts';

export type GetConnFunc = (dsn: Dsn) => Promise<MyProtocol>;
export type ReturnConnFunc = (dsn: Dsn, protocol: MyProtocol, rollbackPreparedXaId1: string) => void;
export type OnBeforeCommit = (conns: Iterable<MyConn>) => Promise<void>;

export class MyConn
{	protected protocol: MyProtocol|undefined;

	private isConnecting = false;
	protected savepointEnum = 0;
	private curXaId = '';
	private curXaIdAppendConn = false;
	private isXaPrepared = false;
	protected pendingTrxSql: string[] = []; // empty string means XA START (because full XA ID was not known)

	readonly dsnStr: string; // dsn is private to ensure that it will not be modified from outside

	constructor
	(	private dsn: Dsn,
		private maxConns: number,
		trxOptions: {readonly: boolean, xaId1: string} | undefined,
		private getConnFunc: GetConnFunc,
		private returnConnFunc: ReturnConnFunc,
		private onBeforeCommit?: OnBeforeCommit,
	)
	{	this.dsnStr = dsn.name;
		if (trxOptions)
		{	this.startTrxFromConstructor(trxOptions);
		}
	}

	get serverVersion()
	{	return this.protocol?.serverVersion ?? '';
	}

	get connectionId()
	{	return this.protocol?.connectionId ?? 0;
	}

	get autocommit()
	{	return ((this.protocol?.statusFlags ?? 0) & StatusFlags.SERVER_STATUS_AUTOCOMMIT) != 0;
	}

	get inTrx()
	{	return this.pendingTrxSql.length!=0 || ((this.protocol?.statusFlags ?? 0) & StatusFlags.SERVER_STATUS_IN_TRANS) != 0;
	}

	get inTrxReadonly()
	{	return ((this.protocol?.statusFlags ?? 0) & StatusFlags.SERVER_STATUS_IN_TRANS_READONLY) != 0;
	}

	get noBackslashEscapes()
	{	return ((this.protocol?.statusFlags ?? 0) & StatusFlags.SERVER_STATUS_NO_BACKSLASH_ESCAPES) != 0;
	}

	get schema()
	{	return this.protocol?.schema ?? '';
	}

	get inXa()
	{	return this.curXaId != '';
	}

	get xaId()
	{	return this.curXaIdAppendConn ? '' : this.curXaId;
	}

	/**	If end() called during connection process, the connection will not be established after this function returns.
	 **/
	async connect()
	{	if (this.isConnecting)
		{	throw new BusyError(`Previous operation is still in progress`);
		}
		if (!this.protocol)
		{	this.isConnecting = true;
			try
			{	const protocol = await this.getConnFunc(this.dsn);
				if (!this.isConnecting) // end() called
				{	this.returnConnFunc(this.dsn, protocol, '');
					throw new CanceledError(`Operation cancelled: end() called during connection process`);
				}
				this.protocol = protocol;
			}
			finally
			{	this.isConnecting = false;
			}
		}
	}

	end()
	{	const {protocol, curXaId, isXaPrepared} = this;
		this.isConnecting = false;
		this.savepointEnum = 0;
		this.curXaId = '';
		this.curXaIdAppendConn = false;
		this.isXaPrepared = false;
		this.pendingTrxSql.length = 0;
		this.protocol = undefined;
		if (protocol)
		{	this.returnConnFunc(this.dsn, protocol, isXaPrepared ? curXaId : '');
		}
	}

	query<ColumnType=ColumnValue>(sql: SqlSource, params?: Params)
	{	return new ResultsetsPromise<Record<string, ColumnType>>
		(	(y, n) =>
			{	this.doQuery<Record<string, ColumnType>>(sql, params, RowType.OBJECT).then(y, n);
			}
		);
	}

	queryMap<ColumnType=ColumnValue>(sql: SqlSource, params?: Params)
	{	return new ResultsetsPromise<Map<string, ColumnType>>
		(	(y, n) =>
			{	this.doQuery<Map<string, ColumnType>>(sql, params, RowType.MAP).then(y, n);
			}
		);
	}

	queryArr<ColumnType=ColumnValue>(sql: SqlSource, params?: Params)
	{	return new ResultsetsPromise<ColumnType[]>
		(	(y, n) =>
			{	this.doQuery<ColumnType[]>(sql, params, RowType.ARRAY).then(y, n);
			}
		);
	}

	queryCol<ColumnType=ColumnValue>(sql: SqlSource, params?: Params)
	{	return new ResultsetsPromise<ColumnType>
		(	(y, n) =>
			{	this.doQuery<ColumnType>(sql, params, RowType.FIRST_COLUMN).then(y, n);
			}
		);
	}

	async makeLastColumnReader<ColumnType=ColumnValue>(sql: SqlSource, params?: Params)
	{	const resultsets = await this.doQuery<Record<string, ColumnType|Deno.Reader>>(sql, params, RowType.LAST_COLUMN_READER);
		const it = resultsets[Symbol.asyncIterator]();
		const {value} = await it.next();
		return value==undefined ? undefined : value; // void -> undefined
	}

	async forQuery<ColumnType=ColumnValue>(sql: SqlSource, callback: (prepared: Resultsets<Record<string, ColumnType>>) => Promise<unknown>): Promise<unknown>
	{	const prepared = await this.doQuery<Record<string, ColumnType>>(sql, true, RowType.OBJECT);
		try
		{	return await callback(prepared);
		}
		finally
		{	await prepared.discard();
			await prepared.disposePreparedStmt();
		}
	}

	async execute(sql: SqlSource, params?: Params)
	{	const resultsets: Resultsets<void> = await this.doQuery<void>(sql, params, RowType.FIRST_COLUMN);
		await resultsets.discard();
		return resultsets;
	}

	/**	Start transaction.
		To start regular transaction, call `startTrx()` without parameters.
		To start READONLY transaction, pass `{readonly: true}`.
		To start distributed transaction, pass `{xaId: '...'}`.
		If you want `conn.connectionId` to be automatically appended to XA identifier, pass `{xaId1: '...'}`, where `xaId1` is the first part of the `xaId`.
		If connection to server was not yet established, the `conn.connectionId` is not known (and `startTrx()` will not connect), so `conn.connectionId` will be appended later on first query.
	 **/
	async startTrx(options?: {readonly?: boolean, xaId?: string, xaId1?: string})
	{	const {protocol} = this;
		if (protocol && (protocol.statusFlags & StatusFlags.SERVER_STATUS_IN_TRANS))
		{	if (this.curXaId)
			{	throw new SqlError(`There's already an active Distributed Transaction`);
			}
			await this.commit();
		}
		let sql;
		const xaId = options?.xaId;
		const someXaId = xaId || options?.xaId1;
		if (someXaId)
		{	if (someXaId.indexOf("'")!=-1 || someXaId.indexOf("\\")!=-1)
			{	throw new Error(`Invalid XA ID: ${someXaId}`);
			}
			if (xaId)
			{	this.curXaId = xaId;
				this.curXaIdAppendConn = false;
				sql = !protocol ? '' : `XA START '${xaId}'`;
			}
			else
			{	this.curXaId = !protocol ? someXaId : someXaId + protocol.connectionId;
				this.curXaIdAppendConn = !protocol;
				sql = !protocol ? '' : `XA START '${this.curXaId}'`;
			}
		}
		else
		{	this.curXaId = '';
			this.curXaIdAppendConn = false;
			const readonly = options?.readonly;
			sql = readonly ? "START TRANSACTION READ ONLY" : "START TRANSACTION";
		}
		debugAssert(!this.isXaPrepared);
		if (protocol && !someXaId)
		{	this.pendingTrxSql.length = 0;
			await this.doQuery(sql);
		}
		else
		{	const {pendingTrxSql} = this;
			if (pendingTrxSql.length > 1)
			{	pendingTrxSql.length = 1;
			}
			pendingTrxSql[0] = sql;
		}
		this.savepointEnum = 0;
	}

	private startTrxFromConstructor(options: {readonly: boolean, xaId1: string})
	{	let sql;
		const {readonly, xaId1} = options;
		if (xaId1)
		{	this.curXaId = xaId1;
			this.curXaIdAppendConn = true;
			sql = '';
		}
		else
		{	sql = readonly ? "START TRANSACTION READ ONLY" : "START TRANSACTION";
		}
		this.pendingTrxSql[0] = sql;
	}

	/**	Creates transaction savepoint, and returns Id number of this new savepoint.
		Then you can call `conn.rollback(pointId)`.
	 **/
	savepoint(): Promise<number>
	{	throw new Error('Not implemented');
	}

	/**	If the current transaction is of distributed type, this function prepares the 2-phase commit.
		Else does nothing.
		If this function succeeded, the transaction will be saved on the server till you call `commit()`.
		The saved transaction can survive server restart and unexpected halt.
		You need to commit it as soon as possible, to release all the locks that it holds.
		Usually, you want to prepare transactions on all servers, and immediately commit them, if `prepareCommit()` succeeded, or rollback them, if it failed.
		If you create cross-server session with `pool.session()`, you can start and commit transaction on session level, and in this case no need to explicitly prepare the commit (`session.commit()` will do it implicitly).
	 **/
	async prepareCommit()
	{	const {protocol, curXaId} = this;
		if (protocol && (protocol.statusFlags & StatusFlags.SERVER_STATUS_IN_TRANS) && curXaId && !this.isXaPrepared)
		{	// SERVER_STATUS_IN_TRANS is set - this means that this is not the very first query in the connection, so sendComQuery() can be used
			if (this.onBeforeCommit)
			{	await this.onBeforeCommit([this]);
			}
			await protocol.sendComQuery(`XA END '${curXaId}'`);
			await protocol.sendComQuery(`XA PREPARE '${curXaId}'`);
			this.isXaPrepared = true;
		}
	}

	/**	Rollback to a savepoint, or all.
		If `toPointId` is not given or undefined - rolls back the whole transaction (XA transactions can be rolled back before `prepareCommit()` called, or after that).
		If `toPointId` is a number returned from `savepoint()` call, rolls back to that point (also works with XAs).
		If `toPointId` is `0`, rolls back to the beginning of transaction, and doesn't end this transaction (doesn't work with XAs).
		If rollback fails, will disconnect from server and throw ServerDisconnectedError.
	 **/
	async rollback(toPointId?: number)
	{	const {protocol, curXaId} = this;
		if (protocol && (protocol.statusFlags & StatusFlags.SERVER_STATUS_IN_TRANS))
		{	if (typeof(toPointId) == 'number')
			{	await protocol.sendComQuery(toPointId>0 ? `ROLLBACK TO p${toPointId}` : `ROLLBACK AND CHAIN`);
			}
			else
			{	this.curXaId = '';
				this.curXaIdAppendConn = false;
				this.isXaPrepared = false;
				this.pendingTrxSql.length = 0;
				try
				{	if (curXaId)
					{	if (!this.isXaPrepared)
						{	try
							{	await protocol.sendComQuery(`XA END '${curXaId}'`);
							}
							catch (e)
							{	protocol.logger.error(e);
							}
						}
						await protocol.sendComQuery(`XA ROLLBACK '${curXaId}'`);
					}
					else
					{	await protocol.sendComQuery(`ROLLBACK`);
					}
				}
				catch (e)
				{	this.end();
					protocol.logger.error(e);
					throw new ServerDisconnectedError(e.message);
				}
			}
		}
		else
		{	this.curXaId = '';
			this.curXaIdAppendConn = false;
			this.isXaPrepared = false;
			this.pendingTrxSql.length = 0;
		}
	}

	/**	Commit.
		If the current transaction started with `{xa: true}`, i'll throw error, because you need to call `prepareCommit()` first.
		If commit fails will rollback and throw error. If rollback also fails, will disconnect from server and throw ServerDisconnectedError.
	 **/
	async commit()
	{	const {protocol, curXaId} = this;
		if (protocol && (protocol.statusFlags & StatusFlags.SERVER_STATUS_IN_TRANS))
		{	let sql;
			if (curXaId)
			{	if (!this.isXaPrepared)
				{	throw new SqlError(`Please, prepare commit first`);
				}
				sql = `XA COMMIT '${curXaId}'`;
			}
			else
			{	if (this.onBeforeCommit)
				{	await this.onBeforeCommit([this]);
				}
				sql = `COMMIT`;
			}
			this.curXaId = '';
			this.curXaIdAppendConn = false;
			this.isXaPrepared = false;
			this.pendingTrxSql.length = 0;
			try
			{	await protocol.sendComQuery(sql);
			}
			catch (e)
			{	try
				{	await protocol.sendComQuery(`ROLLBACK`);
				}
				catch (e2)
				{	protocol.logger.error(e2);
					this.end();
					protocol.logger.error(e);
					throw new ServerDisconnectedError(e.message);
				}
				throw e;
			}
		}
		else
		{	this.curXaId = '';
			this.curXaIdAppendConn = false;
			this.isXaPrepared = false;
			this.pendingTrxSql.length = 0;
		}
	}

	private async doQuery<Row>(sql: SqlSource, params: Params|true=undefined, rowType=RowType.FIRST_COLUMN): Promise<ResultsetsInternal<Row>>
	{	let nRetriesRemaining = this.maxConns;

		while (true)
		{	if (!this.protocol)
			{	await this.connect();
			}
			if (!this.protocol)
			{	throw new CanceledError(`Operation cancelled: end() called during query`);
			}
			const {protocol, pendingTrxSql} = this;

			if (pendingTrxSql.length)
			{	for (let i=0; i<pendingTrxSql.length; i++)
				{	let sql = pendingTrxSql[i];
					if (!sql)
					{	if (this.curXaIdAppendConn)
						{	this.curXaId += protocol.connectionId;
							this.curXaIdAppendConn = false;
						}
						sql = `XA START '${this.curXaId}'`;
					}
					if (!await protocol.sendComQuery(sql, RowType.FIRST_COLUMN, nRetriesRemaining-->0))
					{	this.end();
						continue;
					}
				}
				pendingTrxSql.length = 0;
			}

			if (!params)
			{	// Text protocol query
				const resultsets = await protocol.sendComQuery<Row>(sql, rowType, nRetriesRemaining-->0);
				if (resultsets)
				{	return resultsets;
				}
			}
			else if (params === true)
			{	// Prepare for later execution
				const resultsets = await protocol.sendComStmtPrepare<Row>(sql, undefined, rowType, nRetriesRemaining-->0);
				if (resultsets)
				{	return resultsets;
				}
			}
			else if (Array.isArray(params))
			{	// Prepare to execute immediately: positional parameters
				const resultsets = await protocol.sendComStmtPrepare<Row>(sql, params.length==0 ? params : undefined, rowType, nRetriesRemaining-->0, true);
				if (resultsets)
				{	try
					{	await resultsets.exec(params);
					}
					finally
					{	await resultsets.disposePreparedStmt();
					}
					return resultsets;
				}
			}
			else
			{	// Prepare to execute immediately: named parameters
				let sqlSet = "";
				const paramsSet: Param[] = [];
				for (const [n, v] of Object.entries(params))
				{	sqlSet += !sqlSet.length ? "SET @`" : "`=?,@`";
					sqlSet += n.replaceAll('`', '``');
					paramsSet[paramsSet.length] = v;
				}

				let ok = true;
				if (sqlSet.length != 0)
				{	const resultsets = await protocol.sendComStmtPrepare<Row>(sqlSet+"`=?", undefined, rowType, nRetriesRemaining-->0, true);
					if (resultsets)
					{	try
						{	await resultsets.exec(paramsSet);
							debugAssert(!resultsets.hasMore);
						}
						finally
						{	await resultsets.disposePreparedStmt();
						}
					}
					else
					{	ok = false;
					}
				}
				if (ok)
				{	const resultsets = await protocol.sendComStmtPrepare<Row>(sql, undefined, rowType, nRetriesRemaining-->0, true);
					if (resultsets)
					{	try
						{	await resultsets.exec([]);
						}
						finally
						{	await resultsets.disposePreparedStmt();
						}
						return resultsets;
					}
				}
			}

			this.end();
			// redo
		}
	}
}

/**	This library creates connections as MyConnInternal object, but exposes them as MyConn.
	Methods that don't exist on MyConn are for internal use.
 **/
export class MyConnInternal extends MyConn
{	/**	Creates transaction savepoint, and returns Id number of this new savepoint.
		Then you can call `conn.rollback(pointId)`.
	 **/
	savepoint()
	{	const pointId = ++this.savepointEnum;
		return this.doSavepoint(pointId, `SAVEPOINT p${pointId}`);
	}

	async doSavepoint(pointId: number, sql: string)
	{	const {protocol} = this;
		if (protocol)
		{	if (!(protocol.statusFlags & StatusFlags.SERVER_STATUS_IN_TRANS))
			{	throw new SqlError(`There's no active transaction`);
			}
			// SERVER_STATUS_IN_TRANS is set - this means that this is not the very first query in the connection, so sendComQuery() can be used
			await protocol.sendComQuery(sql);
		}
		else
		{	if (this.pendingTrxSql.length == 0) // call startTrx() to add the first entry
			{	throw new SqlError(`There's no active transaction`);
			}
			this.pendingTrxSql.push(sql);
		}
		return pointId;
	}
}
