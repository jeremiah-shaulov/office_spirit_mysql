import {debugAssert} from './debug_assert.ts';
import {StatusFlags} from './constants.ts';
import {MyProtocol, RowType} from './my_protocol.ts';
import {SqlSource} from './my_protocol_reader_writer.ts';
import {BusyError, CanceledError, SqlError} from './errors.ts';
import {Resultsets, ResultsetsProtocol, ResultsetsPromise} from './resultsets.ts';
import type {Param, Params, ColumnValue} from './resultsets.ts';
import {Dsn} from './dsn.ts';
import {MySession} from "./my_pool.ts";

export const doSavepoint = Symbol('sessionSavepoint');

export class MyConn
{	private protocol: MyProtocol|undefined;

	private isConnecting = false;
	private savepointEnum = 0;
	private curXaId1 = '';
	private isXaPrepared = false;
	private pendingTrxSql: string[] = []; // empty string means XA START (because full XA ID was not known)

	readonly dsnStr: string; // dsn is private to ensure that it will not be modified from outside

	constructor
	(	private dsn: Dsn,
		private maxConns: number,
		trxOptions: {readonly: boolean, xaId1: string} | undefined,
		private getConnFunc: (dsn: Dsn) => Promise<MyProtocol>,
		private returnConnFunc: (dsn: Dsn, protocol: MyProtocol, rollbackPreparedXaId1: string) => void,
		private onBeforeCommit?: (conns: Iterable<MyConn>) => Promise<void>,
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

	get xaId1()
	{	return this.inTrx ? this.curXaId1 : '';
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
				const {pendingTrxSql} = this;
				for (let i=0; i<pendingTrxSql.length; i++)
				{	const sql = pendingTrxSql[i] || `XA START '${this.curXaId1}${protocol.connectionId}'`;
					await protocol.sendComQuery(sql);
					if (!this.isConnecting) // end() called
					{	this.returnConnFunc(this.dsn, protocol, '');
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
	{	const {protocol, curXaId1, isXaPrepared} = this;
		this.isConnecting = false;
		this.savepointEnum = 0;
		this.curXaId1 = '';
		this.isXaPrepared = false;
		this.pendingTrxSql.length = 0;
		this.protocol = undefined;
		if (protocol)
		{	this.returnConnFunc(this.dsn, protocol, isXaPrepared ? curXaId1 : '');
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
		To start distributed transaction, pass `{xaId1: '...'}`.
		The XA transaction Id consists of 2 parts: `xaId1` - string that you provide, and `conn.connectionId` that will be appended automatically.
	 **/
	async startTrx(options?: {readonly?: boolean, xaId1?: string})
	{	const {protocol} = this;
		let sql;
		if (options?.xaId1)
		{	if (protocol && (protocol.statusFlags & StatusFlags.SERVER_STATUS_IN_TRANS))
			{	if (this.curXaId1)
				{	throw new SqlError(`There's already an active Distributed Transaction`);
				}
				await this.commit();
			}
			const xaId1 = options.xaId1;
			this.curXaId1 = xaId1;
			sql = !protocol ? '' : `XA START '${xaId1}${protocol.connectionId}'`;
		}
		else
		{	this.curXaId1 = '';
			const readonly = options?.readonly;
			sql = readonly ? "START TRANSACTION READ ONLY" : "START TRANSACTION";
		}
		this.isXaPrepared = false;
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

	private startTrxFromConstructor(options: {readonly: boolean, xaId1: string})
	{	let sql;
		const {readonly, xaId1} = options;
		if (xaId1)
		{	this.curXaId1 = xaId1;
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
	{	const {protocol, curXaId1} = this;
		if (!protocol || !(protocol.statusFlags & StatusFlags.SERVER_STATUS_IN_TRANS) || !curXaId1)
		{	throw new SqlError(`There's no active Distributed Transaction`);
		}
		if (!this.isXaPrepared)
		{	// SERVER_STATUS_IN_TRANS is set - this means that this is not the very first query in the connection, so sendComQuery() can be used
			if (this.onBeforeCommit)
			{	await this.onBeforeCommit([this]);
			}
			await protocol.sendComQuery(`XA END '${curXaId1}${protocol.connectionId}'`);
			await protocol.sendComQuery(`XA PREPARE '${curXaId1}${protocol.connectionId}'`);
			this.isXaPrepared = true;
		}
	}

	/**	Rollback to a savepoint, or all.
		If `toPointId` is not given or undefined - rolls back the whole transaction (XA transactions can be rolled back before `prepareCommit()` called, or after that).
		If `toPointId` is number returned from `savepoint()` call, rolls back to that point (also works with XAs).
		If `toPointId` is `0`, rolls back to the beginning of transaction (doesn't work with XAs).
	 **/
	async rollback(toPointId?: number)
	{	const {protocol, curXaId1} = this;
		if (protocol && (protocol.statusFlags & StatusFlags.SERVER_STATUS_IN_TRANS))
		{	if (typeof(toPointId) == 'number')
			{	await protocol.sendComQuery(toPointId>0 ? `ROLLBACK TO p${toPointId}` : `ROLLBACK AND CHAIN`);
			}
			else
			{	if (curXaId1)
				{	if (!this.isXaPrepared)
					{	try
						{	await protocol.sendComQuery(`XA END '${curXaId1}${protocol.connectionId}'`);
						}
						catch (e)
						{	console.error(e);
						}
					}
					await protocol.sendComQuery(`XA ROLLBACK '${curXaId1}${protocol.connectionId}'`);
				}
				else
				{	await protocol.sendComQuery(`ROLLBACK`);
				}
			}
		}
		this.curXaId1 = '';
		this.isXaPrepared = false;
	}

	/**	Commit.
		If the current transaction started with `{xa: true}`, you need to call `prepareCommit()` first.
	 **/
	async commit()
	{	const {protocol, curXaId1} = this;
		if (protocol && (protocol.statusFlags & StatusFlags.SERVER_STATUS_IN_TRANS))
		{	if (curXaId1)
			{	if (!this.isXaPrepared)
				{	throw new SqlError(`Please, prepare commit first`);
				}
				await protocol.sendComQuery(`XA COMMIT '${curXaId1}${protocol.connectionId}'`);
			}
			else
			{	if (this.onBeforeCommit)
				{	await this.onBeforeCommit([this]);
				}
				await protocol.sendComQuery(`COMMIT`);
			}
		}
		this.curXaId1 = '';
		this.isXaPrepared = false;
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
