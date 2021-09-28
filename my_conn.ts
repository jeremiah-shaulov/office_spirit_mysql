import {debugAssert} from './debug_assert.ts';
import {StatusFlags} from './constants.ts';
import {MyProtocol, RowType} from './my_protocol.ts';
import {SqlSource} from './my_protocol_reader_writer.ts';
import {SqlError, BusyError, CanceledError, SendWithDataError} from './errors.ts';
import {Resultsets, ResultsetsDriver, ResultsetsPromise} from './resultsets.ts';
import type {Param, Params, ColumnValue} from './resultsets.ts';
import {Dsn} from './dsn.ts';

const DO_QUERY_ATTEMPTS = 3;

const enum State
{	IDLE_FRESH,
	IDLE,
	CONNECTING,
	QUERYING,
}

export class MyConn
{	private protocol: MyProtocol|undefined;

	private state = State.IDLE_FRESH;
	private stateId = 1;
	private curIdleResultsets: ResultsetsDriver<unknown>|undefined;
	private curStmtId = -1;
	private wantCloseCurStmt = false;

	constructor
	(	private dsn: Dsn,
		private onbegin: (dsn: Dsn) => Promise<MyProtocol>,
		private onend: (dsn: Dsn, protocol: MyProtocol) => void,
	)
	{
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
	{	return ((this.protocol?.statusFlags ?? 0) & StatusFlags.SERVER_STATUS_IN_TRANS) != 0;
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

	/**	Can return undefined, if end() called during connection process.
	 **/
	private async getProtocol()
	{	if (this.state==State.QUERYING || this.state==State.CONNECTING)
		{	throw new BusyError(`Previous operation is still in progress`);
		}
		debugAssert(this.state==State.IDLE_FRESH || this.state==State.IDLE);
		debugAssert(!this.curIdleResultsets);
		if (!this.protocol)
		{	const {stateId} = this;
			this.state = State.CONNECTING;
			const protocol = await this.onbegin(this.dsn);
			if (this.stateId != stateId)
			{	this.onend(this.dsn, protocol);
				throw new CanceledError(`Operation cancelled: end() called during connection process`);
			}
			this.state = State.IDLE_FRESH;
			this.protocol = protocol;
			if (this.dsn.initSql)
			{	const resultsets = await this.doQuery(this.dsn.initSql, undefined, RowType.FIRST_COLUMN);
				if (resultsets.hasMoreSomething)
				{	while (await resultsets.gotoNextResultset());
				}
			}
		}
		return this.protocol;
	}

	async connect()
	{	if (!this.protocol)
		{	await this.getProtocol();
		}
	}

	end()
	{	this.stateId = (this.stateId + 1) & 0x7FFF_FFFF;
		const {state, protocol, curIdleResultsets} = this;
		this.state = State.IDLE_FRESH;
		this.protocol = undefined;
		this.curIdleResultsets = undefined;
		this.curStmtId = -1;
		this.wantCloseCurStmt = false;
		if (protocol)
		{	switch (state)
			{	case State.IDLE_FRESH:
				case State.IDLE:
					if (curIdleResultsets)
					{	const theProtocol = protocol;
						curIdleResultsets.discard().then
						(	() =>
							{	this.onend(this.dsn, theProtocol);
							},
							e =>
							{	console.error(e);
								theProtocol.isBrokenConnection = true;
								this.onend(this.dsn, theProtocol);
							}
						);
						return;
					}
					this.onend(this.dsn, protocol);
					return;
				case State.QUERYING:
					return; // fetch routine must call onend()
				default:
					debugAssert(false); // in CONNECTING, protocol is undefined
			}
		}
	}

	private async protocolOp<T>(protocol: MyProtocol, canRedoNAttempt: number, origStateId: number, callback: () => Promise<T>): Promise<T|undefined>
	{	const {state} = this;
		if (this.state==State.QUERYING || this.state==State.CONNECTING)
		{	throw new BusyError(`Previous operation is still in progress`);
		}
		debugAssert(state==State.IDLE_FRESH || state==State.IDLE);
		let result: T;
		try
		{	this.state = State.QUERYING;
			result = await callback();
		}
		catch (e)
		{	debugAssert(this.state == State.QUERYING);
			if (!(e instanceof SqlError))
			{	protocol.isBrokenConnection = true;
			}
			if (this.stateId != origStateId)
			{	this.onend(this.dsn, protocol);
				throw e;
			}
			this.state = State.IDLE;
			if (!(e instanceof SqlError))
			{	this.end();
				if (state==State.IDLE_FRESH && canRedoNAttempt!=-1 && canRedoNAttempt<DO_QUERY_ATTEMPTS && (e instanceof SendWithDataError))
				{	// maybe connection was killed while it was idle in pool
					return; // redo COM_QUERY or COM_STMT_PREPARE
				}
			}
			if (this.wantCloseCurStmt)
			{	await this.protocolOp(protocol, canRedoNAttempt, origStateId, () => protocol.sendComStmtClose(this.curStmtId));
				this.curStmtId = -1;
				this.wantCloseCurStmt = false;
			}
			throw e;
		}
		if (this.stateId != origStateId)
		{	this.onend(this.dsn, protocol);
			throw new CanceledError(`Operation cancelled: end() called during query`);
		}
		this.state = State.IDLE;
		if (this.wantCloseCurStmt)
		{	await this.protocolOp(protocol, canRedoNAttempt, origStateId, () => protocol.sendComStmtClose(this.curStmtId));
			this.curStmtId = -1;
			this.wantCloseCurStmt = false;
		}
		return result;
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
		return value===undefined ? undefined : value; // void -> undefined
	}

	async forQuery<ColumnType=ColumnValue>(sql: SqlSource, callback: (prepared: Resultsets<Record<string, ColumnType>>) => Promise<unknown>): Promise<unknown>
	{	if (this.curStmtId != -1)
		{	throw new BusyError(`Another prepared statement is active`);
		}
		const {stateId} = this;
		const prepared = await this.doQuery<Record<string, ColumnType>>(sql, true, RowType.OBJECT);
		try
		{	if (this.stateId == stateId)
			{	this.curStmtId = prepared.stmtId;
				return await callback(prepared);
			}
		}
		finally
		{	if (this.stateId == stateId)
			{	if (this.state == State.QUERYING)
				{	this.wantCloseCurStmt = true;
				}
				else
				{	this.curStmtId = -1;
					if (prepared.hasMoreSomething)
					{	await prepared.discard();
					}
					await this.protocol?.sendComStmtClose(prepared.stmtId);
				}
			}
		}
		throw new CanceledError(`Operation cancelled: end() called during query`);
	}

	async execute(sql: SqlSource, params?: Params)
	{	const resultsets: Resultsets<void> = await this.doQuery<void>(sql, params, RowType.FIRST_COLUMN);
		await resultsets.discard();
		return resultsets;
	}

	private async doQuery<Row>(sql: SqlSource, params: Params|true, rowType: RowType): Promise<ResultsetsDriver<Row>>
	{	if (this.curIdleResultsets)
		{	throw new BusyError(`Please, read previous resultsets first`);
		}
		for (let nAttempt=1; true; nAttempt++)
		{	const protocol = this.protocol ?? await this.getProtocol();
			const {stateId} = this;
			const resultsets = new ResultsetsDriver<Row>();
			let ok = false;

			if (!params)
			{	// Text protocol query
				ok = true === await this.protocolOp
				(	protocol,
					nAttempt,
					stateId,
					async () =>
					{	await protocol.sendComQuery(sql);
						await protocol.readComQueryResponse(resultsets);
						return true;
					}
				);
			}
			else if (params === true)
			{	// Prepare for later execution
				resultsets.stmtExecute = async (params: Param[]) =>
				{	await this.protocolOp(protocol, -1, stateId, () => protocol.sendComStmtExecute(resultsets, params));
					this.setCurIdleResultsets(protocol, stateId, resultsets, rowType);
				};

				ok = true === await this.protocolOp
				(	protocol,
					nAttempt,
					stateId,
					async () =>
					{	await protocol.sendComStmtPrepare(sql);
						await protocol.readComStmtPrepareResponse(resultsets);
						return true;
					}
				);
			}
			else if (Array.isArray(params))
			{	// Prepare to execute immediately: positional parameters
				ok = true === await this.protocolOp
				(	protocol,
					nAttempt,
					stateId,
					async () =>
					{	await protocol.sendComStmtPrepare(sql, params.length==0 ? params : undefined);
						await protocol.readComStmtPrepareResponse(resultsets);
						await protocol.sendComStmtExecute(resultsets, params);
						return true;
					}
				);
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

				ok = true === await this.protocolOp
				(	protocol,
					nAttempt,
					stateId,
					async () =>
					{	if (sqlSet.length != 0)
						{	const resultsetsSet = new ResultsetsDriver;
							await protocol.sendComStmtPrepare(sqlSet+"`=?");
							await protocol.readComStmtPrepareResponse(resultsetsSet);
							await protocol.sendComStmtExecute(resultsetsSet, paramsSet);
							debugAssert(!resultsetsSet.hasMoreSomething);
						}
						await protocol.sendComStmtPrepare(sql);
						await protocol.readComStmtPrepareResponse(resultsets);
						await protocol.sendComStmtExecute(resultsets, []);
						return true;
					}
				);
			}

			if (ok)
			{	this.setCurIdleResultsets(protocol, stateId, resultsets, rowType);
				return resultsets;
			}

			// redo
		}
	}

	private setCurIdleResultsets<Row>(protocol: MyProtocol, origStateId: number, resultsets: ResultsetsDriver<Row>, rowType: RowType)
	{	if (resultsets.hasMoreSomething)
		{	this.curIdleResultsets = resultsets;
			if (rowType != RowType.LAST_COLUMN_READER)
			{	resultsets.fetch = async () =>
				{	if (!resultsets.hasMoreRows)
					{	return undefined;
					}
					const row = await this.protocolOp(protocol, -1, origStateId, () => protocol.fetch(resultsets, rowType));
					if (!resultsets.hasMoreSomething)
					{	this.curIdleResultsets = undefined;
					}
					return row;
				};
			}
			else
			{	let isFetching = false;
				resultsets.fetch = async () =>
				{	if (isFetching)
					{	throw new BusyError(`Please, read previous column reader to the end`);
					}
					if (!resultsets.hasMoreRows)
					{	return undefined;
					}
					isFetching = true;
					const row = await this.protocolOp
					(	protocol,
						-1,
						origStateId,
						() => protocol.fetch
						(	resultsets,
							rowType,
							async () =>
							{	isFetching = false;
								if (this.stateId == origStateId)
								{	this.state = State.IDLE;
									await resultsets.discard();
									this.curIdleResultsets = undefined;
								}
							}
						)
					);
					this.state = State.QUERYING;
					return row;
				};
			}

			resultsets.gotoNextResultset = async () =>
			{	await this.protocolOp(protocol, -1, origStateId, () => protocol.nextResultset(resultsets));
				if (!resultsets.hasMoreSomething)
				{	this.curIdleResultsets = undefined;
					return false;
				}
				else
				{	return true;
				}
			};
		}
	}
}
