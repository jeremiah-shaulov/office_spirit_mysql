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
	protected savepointEnum = 0;
	private curXaId = '';
	private curXaIdAppendConn = false;
	private isXaPrepared = false;
	protected pendingTrxSql: string[] = []; // empty string means XA START (because full XA ID was not known)
	private preparedStmtsForParams: number[] = [];

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
		this.preparedStmtsForParams.length = 0;
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

	queryVoid(sql: SqlSource, params?: Params): Promise<Resultsets<void>>
	{	return this.doQuery<void>(sql, params, RowType.VOID);
	}

	/**	@deprecated
		Alias of queryVoid().
	 **/
	execute(sql: SqlSource, params?: Params): Promise<Resultsets<void>>
	{	return this.doQuery<void>(sql, params, RowType.VOID);
	}

	async makeLastColumnReader<ColumnType=ColumnValue>(sql: SqlSource, params?: Params)
	{	const resultsets = await this.doQuery<Record<string, ColumnType|Deno.Reader>>(sql, params, RowType.LAST_COLUMN_READER);
		const it = resultsets[Symbol.asyncIterator]();
		const {value} = await it.next();
		return value==undefined ? undefined : value; // void -> undefined
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
			await protocol.sendTreeQueries(-1, -1, undefined, `XA END '${curXaId}'`, false, `XA PREPARE '${curXaId}'`);
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
						{	await protocol.sendTreeQueries(-1, -1, undefined, `XA END '${curXaId}'`, true, `XA ROLLBACK '${curXaId}'`);
						}
						else
						{	await protocol.sendComQuery(`XA ROLLBACK '${curXaId}'`);
						}
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

	private async doQuery<Row>(sql: SqlSource, params: Params|true=undefined, rowType=RowType.VOID): Promise<ResultsetsInternal<Row>>
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
					if (!await protocol.sendComQuery(sql, RowType.VOID, nRetriesRemaining-->0)) // TODO: how to process error?
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
				const letReturnUndefined = nRetriesRemaining-- > 0;
				const {stmtId, nPlaceholders, values, query1} = await this.getNamedParamsQueries(protocol, params, letReturnUndefined);
				if (nPlaceholders != -1)
				{	const resultsets =
					(	!query1 ?
						await protocol.sendComQuery<Row>(sql, rowType, letReturnUndefined) :
						await protocol.sendTreeQueries<Row>(stmtId, nPlaceholders, values, query1, false, sql, rowType, letReturnUndefined)
					);
					if (resultsets)
					{	return resultsets;
					}
				}
			}

			this.end();
			// redo
		}
	}

	async getNamedParamsQueries(protocol: MyProtocol, params: Record<string, Param>, letReturnUndefined: boolean)
	{	const paramKeys = Object.keys(params);
		if (paramKeys.length == 0)
		{	return {stmtId: -1, nPlaceholders: 0, values: undefined, query1: undefined};
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
			{	return {stmtId: -1, nPlaceholders: -1, values: undefined, query1: undefined};
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
		return {stmtId, nPlaceholders, values, query1};
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
