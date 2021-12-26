import {debugAssert} from './debug_assert.ts';
import {StatusFlags} from './constants.ts';
import {MyProtocol, RowType} from './my_protocol.ts';
import {SqlSource} from './my_protocol_reader_writer.ts';
import {BusyError, CanceledError, SqlError} from './errors.ts';
import {Resultsets, ResultsetsProtocol, ResultsetsPromise} from './resultsets.ts';
import type {Param, Params, ColumnValue} from './resultsets.ts';
import {Dsn} from './dsn.ts';
import {MySession, XaInfoTable} from "./my_pool.ts";

export const doSavepoint = Symbol('sessionSavepoint');

export class MyConn
{	private protocol: MyProtocol|undefined;

	private isConnecting = false;
	private savepointEnum = 0;
	private curXaId: number | undefined;
	private xaPreparedInfo: XaInfoTable | true | undefined;
	private pendingTrxSql: string[] = [];

	readonly dsnStr: string; // dsn is private to ensure that it will not be modified from outside

	constructor
	(	private ownerSession: MySession | undefined,
		private dsn: Dsn,
		private maxConns: number,
		trxOptions: {readonly: boolean, xa: boolean} | undefined,
		private getConnFunc: (dsn: Dsn) => Promise<MyProtocol>,
		private returnConnFunc: (dsn: Dsn, protocol: MyProtocol, rollbackPreparedXaId?: number) => void,
		private beforeCommitFunc?: (conn: MyConn, session?: MySession) => Promise<void>,
		private beforeXaPrepareFunc?: (hostname: string, port: number, connectionId: number, xaId: number) => Promise<XaInfoTable | undefined>,
		private afterXaCommitFunc?: (hostname: string, port: number, connectionId: number, xaId: number, info: XaInfoTable) => Promise<void>,
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
	{	return this.protocol ? (this.protocol.statusFlags & StatusFlags.SERVER_STATUS_IN_TRANS) != 0 : this.pendingTrxSql.length > 0;
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

	get xaId()
	{	return this.inTrx ? this.curXaId : undefined;
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
				{	this.returnConnFunc(this.dsn, protocol);
					throw new CanceledError(`Operation cancelled: end() called during connection process`);
				}
				const {pendingTrxSql} = this;
				for (let i=0; i<pendingTrxSql.length; i++)
				{	await protocol.sendComQuery(pendingTrxSql[i]);
					if (!this.isConnecting) // end() called
					{	this.returnConnFunc(this.dsn, protocol);
						throw new CanceledError(`Operation cancelled: end() called during connection process`);
					}
				}
				pendingTrxSql.length = 0;
				this.protocol = protocol;
			}
			finally
			{	this.isConnecting = false;
			}
		}
	}

	end()
	{	const {protocol, curXaId, xaPreparedInfo} = this;
		this.isConnecting = false;
		this.savepointEnum = 0;
		this.curXaId = undefined;
		this.xaPreparedInfo = undefined;
		this.pendingTrxSql.length = 0;
		this.protocol = undefined;
		if (protocol)
		{	this.returnConnFunc(this.dsn, protocol, xaPreparedInfo ? curXaId : undefined);
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
		To start distributed transaction, pass `{xa: true}`.
		The XA transaction Id will be generated automatically. It will be available through `conn.xaId`.
	 **/
	async startTrx(options?: {readonly?: boolean, xa?: boolean})
	{	const {protocol} = this;
		let sql;
		if (options?.xa)
		{	if (protocol && (protocol.statusFlags & StatusFlags.SERVER_STATUS_IN_TRANS))
			{	if (this.curXaId != undefined)
				{	throw new SqlError(`There's already an active Distributed Transaction`);
				}
				await this.commit();
			}
			const xaId = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
			this.curXaId = xaId;
			this.xaPreparedInfo = undefined;
			sql = `XA START '${xaId}'`;
		}
		else
		{	const readonly = options?.readonly;
			sql = readonly ? "START TRANSACTION READ ONLY" : "START TRANSACTION";
		}
		if (protocol)
		{	await this.doQuery(sql);
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

	private startTrxFromConstructor(options: {readonly: boolean, xa: boolean})
	{	let sql;
		const {readonly, xa} = options;
		if (xa)
		{	const xaId = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
			this.curXaId = xaId;
			sql = `XA START '${xaId}'`;
		}
		else
		{	sql = readonly ? "START TRANSACTION READ ONLY" : "START TRANSACTION";
		}
		this.pendingTrxSql[0] = sql;
	}

	/**	Creates transaction savepoint, and returns Id number of this new savepoint.
		Then you can call `conn.rollback(pointId)`.
	 **/
	savepoint()
	{	const pointId = ++this.savepointEnum;
		return this[doSavepoint](pointId, `SAVEPOINT p${pointId}`);
	}

	async [doSavepoint](pointId: number, sql: string)
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

	/**	If the current transaction started with `{xa: true}`, this function prepares the 2-phase commit.
		If this function succeeded, the transaction will be saved on the server till you call `commit()`.
		The saved transaction can survive server restart and unexpected halt.
		You need to commit it as soon as possible, all the locks that it holds will be released.
		Usually, you want to prepare transactions on all servers, and immediately commit them, it `prepareCommit()` succeeded, or rollback them, if it failed.
		If you create cross-server session with `pool.session()`, you can start and commit transaction on session level, and in this case no need to explicitly prepare the commit (`session.commit()` will do it implicitly).
	 **/
	async prepareCommit()
	{	const {protocol, curXaId} = this;
		if (!protocol || !(protocol.statusFlags & StatusFlags.SERVER_STATUS_IN_TRANS) || typeof(curXaId)!='number')
		{	throw new SqlError(`There's no active Distributed Transaction`);
		}
		if (!this.xaPreparedInfo)
		{	// SERVER_STATUS_IN_TRANS is set - this means that this is not the very first query in the connection, so sendComQuery() can be used
			if (this.beforeCommitFunc)
			{	await this.beforeCommitFunc(this, this.ownerSession);
			}
			await protocol.sendComQuery(`XA END '${curXaId}'`);
			let xaPrepared;
			if (this.beforeXaPrepareFunc)
			{	xaPrepared = await this.beforeXaPrepareFunc(this.dsn.hostname, this.dsn.port, protocol.connectionId, curXaId);
			}
			await protocol.sendComQuery(`XA PREPARE '${curXaId}'`);
			this.xaPreparedInfo = xaPrepared || true;
		}
	}

	/**	Rollback to a savepoint, or all.
		If `toPointId` is not given or undefined - rolls back the whole transaction (XA transactions can be rolled back before `prepareCommit()` called, or after that).
		If `toPointId` is number returned from `savepoint()` call, rolls back to that point (also works with XAs).
		If `toPointId` is `0`, rolls back to the beginning of transaction (doesn't work with XAs).
	 **/
	async rollback(toPointId?: number)
	{	const {protocol, curXaId} = this;
		if (protocol && (protocol.statusFlags & StatusFlags.SERVER_STATUS_IN_TRANS))
		{	if (typeof(toPointId) == 'number')
			{	await protocol.sendComQuery(toPointId>0 ? `ROLLBACK TO p${toPointId}` : `ROLLBACK AND CHAIN`);
			}
			else
			{	if (typeof(curXaId) == 'number')
				{	const {xaPreparedInfo} = this;
					if (!xaPreparedInfo)
					{	try
						{	await protocol.sendComQuery(`XA END '${curXaId}'`);
						}
						catch (e)
						{	console.error(e);
						}
					}
					await protocol.sendComQuery(`XA ROLLBACK '${curXaId}'`);
					if (this.afterXaCommitFunc && xaPreparedInfo && xaPreparedInfo!==true)
					{	await this.afterXaCommitFunc(this.dsn.hostname, this.dsn.port, protocol.connectionId, curXaId, xaPreparedInfo);
					}
				}
				else
				{	await protocol.sendComQuery(`ROLLBACK`);
				}
			}
		}
		this.curXaId = undefined;
		this.xaPreparedInfo = undefined;
	}

	/**	Commit.
		If the current transaction started with `{xa: true}`, you need to call `prepareCommit()` first.
	 **/
	async commit()
	{	const {protocol, curXaId} = this;
		if (protocol && (protocol.statusFlags & StatusFlags.SERVER_STATUS_IN_TRANS))
		{	if (typeof(curXaId) == 'number')
			{	const {xaPreparedInfo} = this;
				if (!xaPreparedInfo)
				{	throw new SqlError(`Please, prepare commit first`);
				}
				await protocol.sendComQuery(`XA COMMIT '${curXaId}'`);
				if (this.afterXaCommitFunc && xaPreparedInfo!==true)
				{	await this.afterXaCommitFunc(this.dsn.hostname, this.dsn.port, protocol.connectionId, curXaId, xaPreparedInfo);
				}
			}
			else
			{	if (this.beforeCommitFunc)
				{	await this.beforeCommitFunc(this, this.ownerSession);
				}
				await protocol.sendComQuery(`COMMIT`);
			}
		}
		this.curXaId = undefined;
		this.xaPreparedInfo = undefined;
	}

	private async doQuery<Row>(sql: SqlSource, params: Params|true=undefined, rowType=RowType.FIRST_COLUMN): Promise<ResultsetsProtocol<Row>>
	{	let nRetriesRemaining = this.maxConns;

		while (true)
		{	if (!this.protocol)
			{	await this.connect();
			}
			if (!this.protocol)
			{	throw new CanceledError(`Operation cancelled: end() called during query`);
			}
			const {protocol} = this;

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
