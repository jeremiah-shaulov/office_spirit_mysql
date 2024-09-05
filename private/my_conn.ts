import {debugAssert} from './debug_assert.ts';
import {StatusFlags} from './constants.ts';
import {MyProtocol, RowType, Logger} from './my_protocol.ts';
import {SqlSource} from './my_protocol_reader_writer.ts';
import {BusyError, CanceledError, ServerDisconnectedError, SqlError} from './errors.ts';
import {Resultsets, ResultsetsInternal, ResultsetsPromise} from './resultsets.ts';
import type {Param, Params, ColumnValue} from './resultsets.ts';
import {Dsn} from './dsn.ts';
import {SqlLogger, SafeSqlLogger} from "./sql_logger.ts";
import {SqlLogToWriter} from "./sql_log_to_writer.ts";
import {Reader} from './deno_ifaces.ts';

export type GetConnFunc = (dsn: Dsn, sqlLogger: SafeSqlLogger|undefined) => Promise<MyProtocol>;
export type ReturnConnFunc = (dsn: Dsn, protocol: MyProtocol, rollbackPreparedXaId1: string, withDisposeSqlLogger: boolean) => void;
export type OnBeforeCommit = (conns: readonly MyConn[]) => Promise<void>;

export const DEFAULT_MAX_CONNS = 250;
export const SAVEPOINT_ENUM_SESSION_FROM = 0x4000_0000;

const C_COMMA = ','.charCodeAt(0);
const C_AT = '@'.charCodeAt(0);
const C_BACKTICK = '`'.charCodeAt(0);
const C_UNDERSCORE = '_'.charCodeAt(0);
const C_ZERO = '0'.charCodeAt(0);
const C_A = 'a'.charCodeAt(0);
const C_S_CAP = 'S'.charCodeAt(0);
const C_E_CAP = 'E'.charCodeAt(0);
const C_T_CAP = 'T'.charCodeAt(0);
const C_N_CAP = 'N'.charCodeAt(0);
const C_U_CAP = 'U'.charCodeAt(0);
const C_L_CAP = 'L'.charCodeAt(0);
const C_SPACE = ' '.charCodeAt(0);
const C_EQ = '='.charCodeAt(0);
const C_QEST = '?'.charCodeAt(0);

const encoder = new TextEncoder;

export class MyConn
{	protected protocol: MyProtocol|undefined;

	private isConnecting = false;
	protected sqlLogger: SafeSqlLogger | undefined;
	protected savepointEnum = 0;
	private curXaId = '';
	private curXaIdAppendConn = false;
	private isXaPrepared = false;
	protected pendingTrxSql: string[] = []; // empty string means XA START (because full XA ID was not known)
	private preparedStmtsForParams: number[] = [];

	constructor
	(	readonly dsn: Dsn,
		trxOptions: {readonly: boolean, xaId1: string} | undefined,
		private logger: Logger,
		private getConnFunc: GetConnFunc,
		private returnConnFunc: ReturnConnFunc,
		private onBeforeCommit?: OnBeforeCommit,
	)
	{	if (trxOptions)
		{	this.startTrx(trxOptions);
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
			{	const protocol = await this.getConnFunc(this.dsn, this.sqlLogger);
				if (!this.isConnecting) // end() called
				{	this.returnConnFunc(this.dsn, protocol, '', false);
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
	{	this.doEnd(false);
	}

	protected doEnd(withDisposeSqlLogger: boolean)
	{	const {protocol, curXaId, isXaPrepared} = this;
		this.isConnecting = false;
		this.savepointEnum = 0;
		this.curXaId = '';
		this.curXaIdAppendConn = false;
		this.isXaPrepared = false;
		this.pendingTrxSql.length = 0;
		this.preparedStmtsForParams.length = 0;
		this.protocol = undefined;
		if (protocol)
		{	this.returnConnFunc(this.dsn, protocol, isXaPrepared ? curXaId : '', withDisposeSqlLogger);
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

	queryVoid(sql: SqlSource, params?: Params): Promise<Resultsets<void>>
	{	return this.doQuery<void>(sql, params, RowType.VOID);
	}

	/**	Alias of queryVoid().
		@deprecated
	 **/
	execute(sql: SqlSource, params?: Params): Promise<Resultsets<void>>
	{	return this.doQuery<void>(sql, params, RowType.VOID);
	}

	/**	Stream column contents as `Deno.Reader`. If the resultset contains multiple columns, only the last one will be used (and others discarded).
		@deprecated As `Deno.Reader` is deprecated, this method is deprecated as well.
	 **/
	async makeLastColumnReader<ColumnType=ColumnValue>(sql: SqlSource, params?: Params)
	{	const resultsets = await this.doQuery<Record<string, ColumnType|Reader>>(sql, params, RowType.LAST_COLUMN_READER);
		const it = resultsets[Symbol.asyncIterator]();
		const {value, done} = await it.next();
		return done ? undefined : value; // void -> undefined
	}

	/**	Stream column contents as `ReadableStream`. If the resultset contains multiple columns, only the last one will be used (and others discarded).
	 **/
	async makeLastColumnReadable<ColumnType=ColumnValue>(sql: SqlSource, params?: Params)
	{	const resultsets = await this.doQuery<Record<string, ColumnType|ReadableStream<Uint8Array>>>(sql, params, RowType.LAST_COLUMN_READABLE);
		const it = resultsets[Symbol.asyncIterator]();
		const {value, done} = await it.next();
		return done ? undefined : value; // void -> undefined
	}

	async forQuery<ColumnType=ColumnValue, T=unknown>(sql: SqlSource, callback: (prepared: Resultsets<Record<string, ColumnType>>) => Promise<T>): Promise<T>
	{	const prepared = await this.doQuery<Record<string, ColumnType>>(sql, true, RowType.OBJECT);
		try
		{	return await callback(prepared);
		}
		finally
		{	await prepared.discard();
			await prepared.disposePreparedStmt();
		}
	}

	async forQueryMap<ColumnType=ColumnValue, T=unknown>(sql: SqlSource, callback: (prepared: Resultsets<Map<string, ColumnType>>) => Promise<T>): Promise<T>
	{	const prepared = await this.doQuery<Map<string, ColumnType>>(sql, true, RowType.MAP);
		try
		{	return await callback(prepared);
		}
		finally
		{	await prepared.discard();
			await prepared.disposePreparedStmt();
		}
	}

	async forQueryArr<ColumnType=ColumnValue, T=unknown>(sql: SqlSource, callback: (prepared: Resultsets<ColumnType[]>) => Promise<T>): Promise<T>
	{	const prepared = await this.doQuery<ColumnType[]>(sql, true, RowType.ARRAY);
		try
		{	return await callback(prepared);
		}
		finally
		{	await prepared.discard();
			await prepared.disposePreparedStmt();
		}
	}

	async forQueryCol<ColumnType=ColumnValue, T=unknown>(sql: SqlSource, callback: (prepared: Resultsets<ColumnType>) => Promise<T>): Promise<T>
	{	const prepared = await this.doQuery<ColumnType>(sql, true, RowType.FIRST_COLUMN);
		try
		{	return await callback(prepared);
		}
		finally
		{	await prepared.discard();
			await prepared.disposePreparedStmt();
		}
	}

	async forQueryVoid<T>(sql: SqlSource, callback: (prepared: Resultsets<void>) => Promise<T>): Promise<T>
	{	const prepared = await this.doQuery<void>(sql, true, RowType.VOID);
		try
		{	return await callback(prepared);
		}
		finally
		{	await prepared.disposePreparedStmt();
		}
	}

	/**	Commit current transaction (if any), and start new.
		This is lazy operation. The corresponding command will be sent to the server later (however commit of the current transaction will happen immediately).
		To start regular transaction, call `startTrx()` without parameters.
		To start READONLY transaction, pass `{readonly: true}`.
		To start distributed transaction, pass `{xaId: '...'}`.
		If you want `conn.connectionId` to be automatically appended to XA identifier, pass `{xaId1: '...'}`, where `xaId1` is the first part of the `xaId`.
		If connection to server was not yet established, the `conn.connectionId` is not known (and `startTrx()` will not connect), so `conn.connectionId` will be appended later on first query.
	 **/
	async startTrx(options?: {readonly?: boolean, xaId?: string, xaId1?: string})
	{	// This function must not await when no transaction started (e.g. when called from constructor, or from `MySession.startTrx()`).
		// 1. Commit
		const {protocol} = this;
		if (protocol && (protocol.statusFlags & StatusFlags.SERVER_STATUS_IN_TRANS))
		{	if (this.curXaId)
			{	throw new SqlError(`There's already an active Distributed Transaction`);
			}
			await this.commit();
		}
		// 2. Set this.curXaId, this.curXaIdAppendConn, this.pendingTrxSql=['START ...'], this.savepointEnum=0
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
				sql = `XA START '${xaId}'`;
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
		debugAssert(!this.isXaPrepared); // because of `commit()` above
		const {pendingTrxSql} = this;
		if (pendingTrxSql.length > 1)
		{	pendingTrxSql.length = 1;
		}
		pendingTrxSql[0] = sql; // sql=='' means 'XA START' with connectionId appended, that will be known after the connection
		this.savepointEnum = 0;
	}

	/**	Creates transaction savepoint, and returns ID number of this new savepoint.
		Then you can call `conn.rollback(pointId)`.
		This is lazy operation. The corresponding command will be sent to the server later.
		Calling `savepoint()` immediately followed by `rollback(pointId)` to this point will send no commands.
	 **/
	savepoint()
	{	const pointId = ++this.savepointEnum;
		this.pendingTrxSql.push(`SAVEPOINT p${pointId}`);
		return pointId;
	}

	/**	If the current transaction is of distributed type, this function prepares the 2-phase commit.
		Else does nothing.
		If this function succeeds, the transaction will be saved on the server till you call `commit()`.
		The saved transaction can survive server restart and unexpected halt.
		You need to commit it as soon as possible, to release all the locks that it holds.
		Usually, you want to prepare transactions on all servers, and immediately commit them if `prepareCommit()` succeeded, or rollback them if it failed.
	 **/
	async prepareCommit()
	{	const {protocol, curXaId} = this;
		if (protocol && (protocol.statusFlags & StatusFlags.SERVER_STATUS_IN_TRANS) && curXaId && !this.isXaPrepared)
		{	if (this.onBeforeCommit) // when this MyConn belongs to MySession, the `onBeforeCommit` is not set
			{	await this.onBeforeCommit([this]);
			}
			await protocol.sendThreeQueries(-1, undefined, `XA END '${curXaId}'`, false, `XA PREPARE '${curXaId}'`);
			this.isXaPrepared = true;
		}
	}

	/**	Rollback to a savepoint, or all.
		If `toPointId` is not given or undefined - rolls back the whole transaction (XA transactions can be rolled back before `prepareCommit()` called, or after that).
		If `toPointId` is a number returned from `savepoint()` call, rolls back to that point (also works with XAs).
		If `toPointId` is `0`, rolls back to the beginning of transaction, and doesn't end this transaction (doesn't work with XAs).
		If rollback (not to savepoint) failed, will disconnect from server and throw ServerDisconnectedError.
		If `toPointId` was `0` (not for XAs), the transaction will be restarted after the disconnect if rollback failed.
	 **/
	async rollback(toPointId?: number)
	{	const {protocol, curXaId} = this;
		if (typeof(toPointId)=='number' && toPointId!==0)
		{	// Rollback to a savepoint, and leave the transaction started
			const isOfSession = toPointId >= SAVEPOINT_ENUM_SESSION_FROM;
			if (isOfSession)
			{	toPointId -= SAVEPOINT_ENUM_SESSION_FROM;
			}
			const {pendingTrxSql} = this;
			for (let i=pendingTrxSql.length-1; i>=0; i--)
			{	const sql = pendingTrxSql[i];
				if (!sql.startsWith(isOfSession ? 'SAVEPOINT s' : 'SAVEPOINT p'))
				{	break;
				}
				if (Number(sql.slice(11)) == toPointId)
				{	pendingTrxSql.length = i;
					return;
				}
			}
			if (protocol && (protocol.statusFlags & StatusFlags.SERVER_STATUS_IN_TRANS))
			{	await this.doQuery((isOfSession ? 'ROLLBACK TO s' : 'ROLLBACK TO p') + toPointId); // doQuery() will also flush this.pendingTrxSql
			}
			else
			{	throw new Error(`No such SAVEPOINT: ${isOfSession ? SAVEPOINT_ENUM_SESSION_FROM+toPointId : toPointId}`);
			}
		}
		else
		{	if (protocol && (protocol.statusFlags & StatusFlags.SERVER_STATUS_IN_TRANS || this.isXaPrepared)) // if xa_detach_on_prepare conf var is set, `statusFlags` will *not* contain `SERVER_STATUS_IN_TRANS` after `XA PREPARE`
			{	try
				{	if (typeof(toPointId) == 'number')
					{	await protocol.sendComQuery(`ROLLBACK AND CHAIN`);
					}
					else if (!curXaId)
					{	await protocol.sendComQuery(`ROLLBACK`);
					}
					else if (this.isXaPrepared)
					{	await protocol.sendComQuery(`XA ROLLBACK '${curXaId}'`);
					}
					else
					{	await protocol.sendThreeQueries(-1, undefined, `XA END '${curXaId}'`, true, `XA ROLLBACK '${curXaId}'`);
					}
				}
				catch (e)
				{	const {inTrxReadonly} = this;
					this.doEnd(false);
					protocol.logger.error(e);
					if (typeof(toPointId) == 'number')
					{	// want chain
						this.startTrx(inTrxReadonly ? {readonly: true} : undefined); // this must return resolved promise, and not throw exceptions
					}
					throw new ServerDisconnectedError(e.message);
				}
			}
			this.curXaId = '';
			this.curXaIdAppendConn = false;
			this.isXaPrepared = false;
			this.pendingTrxSql.length = 0;
		}
	}

	/**	Commit.
		If the current transaction is XA, and you didn't call `prepareCommit()` i'll throw error.
		With `andChain` parameter will commit and then restart the same transaction (doesn't work with XAs).
		If commit fails will rollback and throw error. If rollback also fails, will disconnect from server and throw ServerDisconnectedError.
	 **/
	async commit(andChain=false)
	{	const {protocol, curXaId, isXaPrepared} = this;
		let error;
		if (protocol && (protocol.statusFlags & StatusFlags.SERVER_STATUS_IN_TRANS || isXaPrepared)) // if xa_detach_on_prepare conf var is set, `statusFlags` will *not* contain `SERVER_STATUS_IN_TRANS` after `XA PREPARE`
		{	let sql;
			if (curXaId)
			{	if (!isXaPrepared)
				{	throw new SqlError(`Please, prepare commit first`);
				}
				if (andChain)
				{	error = new SqlError(`Cannot chain XA`);
				}
				sql = `XA COMMIT '${curXaId}'`;
			}
			else
			{	if (this.onBeforeCommit) // when this MyConn belongs to MySession, the `onBeforeCommit` is not set
				{	await this.onBeforeCommit([this]);
				}
				sql = andChain ? `COMMIT AND CHAIN` : `COMMIT`;
			}
			try
			{	await protocol.sendComQuery(sql);
			}
			catch (e)
			{	try
				{	await protocol.sendComQuery(curXaId ? `XA ROLLBACK '${curXaId}'` : andChain ? `ROLLBACK AND CHAIN` : `ROLLBACK`);
				}
				catch (e2)
				{	protocol.logger.error(e2);
					this.doEnd(false);
					protocol.logger.error(e);
					throw new ServerDisconnectedError(e.message);
				}
				error = e;
			}
		}
		this.curXaId = '';
		this.curXaIdAppendConn = false;
		this.isXaPrepared = false;
		this.pendingTrxSql.length = 0;
		if (error)
		{	throw error;
		}
	}

	setSqlLogger(sqlLogger?: SqlLogger|true)
	{	this.sqlLogger = !sqlLogger ? undefined : new SafeSqlLogger(this.dsn, sqlLogger===true ? new SqlLogToWriter(Deno.stderr, !Deno.noColor) : sqlLogger, this.logger);
		this.protocol?.setSqlLogger(this.sqlLogger);
	}

	private async doQuery<Row>(sql: SqlSource, params: Params|true=undefined, rowType=RowType.VOID): Promise<ResultsetsInternal<Row>>
	{	let nRetriesRemaining = this.dsn.maxConns || DEFAULT_MAX_CONNS;

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
					if (!await protocol.sendComQuery(sql, RowType.VOID, nRetriesRemaining-->0)) // TODO: how to process error?
					{	this.doEnd(false);
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
				const letReturnUndefined = nRetriesRemaining-- > 0;
				const {stmtId, values, query1} = await this.getNamedParamsQueries(protocol, params, letReturnUndefined);
				if (values)
				{	const resultsets =
					(	!query1 ?
						await protocol.sendComQuery<Row>(sql, rowType, letReturnUndefined) :
						await protocol.sendThreeQueries<Row>(stmtId, values, query1, false, sql, rowType, letReturnUndefined)
					);
					if (resultsets)
					{	return resultsets;
					}
				}
			}

			this.doEnd(false);
			// redo
		}
	}

	async getNamedParamsQueries(protocol: MyProtocol, params: Record<string, Param>, letReturnUndefined: boolean)
	{	const paramKeys = Object.keys(params);
		if (paramKeys.length == 0)
		{	return {stmtId: -1, values: paramKeys, query1: undefined};
		}
		if (paramKeys.length > 0xFFFF)
		{	throw new SqlError(`Too many query parameters. The maximum of ${0xFFFF} is supported`);
		}
		// Prepare stmts with not less than 8 placeholders, and increase by magnitude of 8 (if 9 params, use 16 placeholders)
		const pos = (paramKeys.length - 1) >> 3;
		const nPlaceholders = (pos + 1) << 3;
		const {preparedStmtsForParams} = this;
		let stmtId = preparedStmtsForParams[pos];
		// SET @_yl_fk=?,@_yl_fl=?,@_yl_fm=?,...,@_yl_g0=?,@_yl_g1=?,...,@_yl_ga=?,@_yl_gb=?,...,@_ym_00=?,...
		const query0 = typeof(stmtId)=='number' && stmtId!=-1 ? undefined : new Uint8Array(3 /*SET*/ + 10 /*,@_NN_NN=?*/ * nPlaceholders);
		// SET @`hello`=@_yl_fk,@_yl_fk=NULL,@world=@_yl_fl,@_yl_fl=NULL
		let query1Len = 3 /*SET*/;
		for (let i=paramKeys.length-1; i>=0; i--)
		{	query1Len += 12 /*,@``=@_NN_NN*/ + paramKeys[i].length + 13 /*,@_NN_NN=NULL*/; // guess: no multibyte chars
		}
		let query1 = new Uint8Array(query1Len);
		// Generate the queries
		debugAssert((36*36*36*36 - 0x10000).toString(36) == 'ylfk');
		const n = ['y'.charCodeAt(0), 'l'.charCodeAt(0), 'f'.charCodeAt(0), 'k'.charCodeAt(0)];
		for (let i=0, j=3, k=3; i<nPlaceholders; i++)
		{	// query0 += ",@_NN_NN"
			if (query0)
			{	query0[j++] = C_COMMA;
				query0[j++] = C_AT;
				query0[j++] = C_UNDERSCORE;
				query0[j++] = n[0];
				query0[j++] = n[1];
				query0[j++] = C_UNDERSCORE;
				query0[j++] = n[2];
				query0[j++] = n[3];
				query0[j++] = C_EQ;
				query0[j++] = C_QEST;
			}
			// query1 += ",@`hello`=@_NN_NN"
			if (i < paramKeys.length)
			{	query1[k++] = C_COMMA;
				query1[k++] = C_AT;
				query1[k++] = C_BACKTICK;
				const param = paramKeys[i].replaceAll('`', '``');
				while (true)
				{	const {read, written} = encoder.encodeInto(param, query1.subarray(k));
					if (read == param.length)
					{	k += written;
						break;
					}
					// realloc query1
					const tmp = new Uint8Array(query1.length * 2 + 25); // add 12 to be sure that i can `query1[k++] = ...` at least 25 times
					tmp.set(query1);
					query1 = tmp;
				}
				query1[k++] = C_BACKTICK;
				query1[k++] = C_EQ;
				query1[k++] = C_AT;
				query1[k++] = C_UNDERSCORE;
				query1[k++] = n[0];
				query1[k++] = n[1];
				query1[k++] = C_UNDERSCORE;
				query1[k++] = n[2];
				query1[k++] = n[3];
				query1[k++] = C_COMMA;
				query1[k++] = C_AT;
				query1[k++] = C_UNDERSCORE;
				query1[k++] = n[0];
				query1[k++] = n[1];
				query1[k++] = C_UNDERSCORE;
				query1[k++] = n[2];
				query1[k++] = n[3];
				query1[k++] = C_EQ;
				query1[k++] = C_N_CAP;
				query1[k++] = C_U_CAP;
				query1[k++] = C_L_CAP;
				query1[k++] = C_L_CAP;
			}
			else if (!query0)
			{	break;
			}
			// inc n
			for (let l=3; l>=0; l--)
			{	if (++n[l] == C_ZERO+10)
				{	n[l] = C_A;
				}
				else if (n[l] == C_A+26)
				{	n[l] = C_ZERO;
					continue;
				}
				break;
			}
		}
		query1[0] = C_S_CAP;
		query1[1] = C_E_CAP;
		query1[2] = C_T_CAP;
		query1[3] = C_SPACE;
		if (query0)
		{	query0[0] = C_S_CAP;
			query0[1] = C_E_CAP;
			query0[2] = C_T_CAP;
			query0[3] = C_SPACE;
			const resultsets = await protocol.sendComStmtPrepare<void>(query0, undefined, RowType.VOID, letReturnUndefined, true);
			if (!resultsets)
			{	return {stmtId: -1, values: undefined, query1: undefined};
			}
			stmtId = resultsets.stmtId;
			debugAssert(resultsets.nPlaceholders == nPlaceholders);
			while (preparedStmtsForParams.length < pos)
			{	preparedStmtsForParams[preparedStmtsForParams.length] = -1;
			}
			preparedStmtsForParams[pos] = stmtId;
		}
		debugAssert(typeof(stmtId)=='number' && stmtId!=-1);
		const values = Object.values(params);
		while (values.length < nPlaceholders)
		{	values[values.length] = null;
		}
		return {stmtId, values, query1};
	}
}

/**	This library creates connections as MyConnInternal object, but exposes them as MyConn.
	Methods that don't exist on MyConn are for internal use.
 **/
export class MyConnInternal extends MyConn
{	endAndDisposeSqlLogger()
	{	this.doEnd(true);
	}

	sessionSavepoint(pointId: number)
	{	this.pendingTrxSql.push(`SAVEPOINT s${pointId}`);
	}
}
