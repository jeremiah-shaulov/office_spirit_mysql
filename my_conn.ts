import {debug_assert} from './debug_assert.ts';
import {StatusFlags, Charset, CapabilityFlags} from './constants.ts';
import {MyProtocol, RowType} from './my_protocol.ts';
import {SqlSource} from './my_protocol_reader_writer.ts';
import {SqlError, BusyError, CanceledError, SendWithDataError} from './errors.ts';
import {Resultsets, ResultsetsDriver, ResultsetsPromise} from './resultsets.ts';
import {Dsn} from './dsn.ts';
import {Sql} from './sql.ts';
import {AllowedSqlIdents} from './allowed_sql_idents.ts';

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
	private state_id = 1;
	private cur_idle_resultsets: ResultsetsDriver|undefined;
	private cur_stmt_id = -1;
	private want_close_cur_stmt = false;

	constructor
	(	private dsn: Dsn,
		private onbegin: (dsn: Dsn) => Promise<MyProtocol>,
		private onend: (dsn: Dsn, protocol: MyProtocol) => void,
		private allowed_sql_idents: AllowedSqlIdents
	)
	{
	}

	get serverVersion()
	{	return this.protocol?.server_version ?? '';
	}

	get connectionId()
	{	return this.protocol?.connection_id ?? 0;
	}

	get autocommit()
	{	return ((this.protocol?.status_flags ?? 0) & StatusFlags.SERVER_STATUS_AUTOCOMMIT) != 0;
	}

	get inTrx()
	{	return ((this.protocol?.status_flags ?? 0) & StatusFlags.SERVER_STATUS_IN_TRANS) != 0;
	}

	get inTrxReadonly()
	{	return ((this.protocol?.status_flags ?? 0) & StatusFlags.SERVER_STATUS_IN_TRANS_READONLY) != 0;
	}

	get noBackslashEscapes()
	{	return ((this.protocol?.status_flags ?? 0) & StatusFlags.SERVER_STATUS_NO_BACKSLASH_ESCAPES) != 0;
	}

	get schema()
	{	return this.protocol?.schema ?? '';
	}

	/**	Can return undefined, if end() called during connection process.
	 **/
	private async get_protocol()
	{	if (this.state==State.QUERYING || this.state==State.CONNECTING)
		{	throw new BusyError(`Previous operation is still in progress`);
		}
		debug_assert(this.state==State.IDLE_FRESH || this.state==State.IDLE);
		debug_assert(!this.cur_idle_resultsets);
		if (!this.protocol)
		{	let {state_id} = this;
			this.state = State.CONNECTING;
			let protocol = await this.onbegin(this.dsn);
			if (this.state_id != state_id)
			{	this.onend(this.dsn, protocol);
				throw new CanceledError(`Operation cancelled: end() called during connection process`);
			}
			this.state = State.IDLE_FRESH;
			this.protocol = protocol;
			if (this.dsn.initSql)
			{	let resultsets = await this.do_query(this.dsn.initSql, undefined, RowType.FIRST_COLUMN);
				if (resultsets.has_more)
				{	while (await resultsets.next_resultset());
				}
			}
		}
		return this.protocol;
	}

	async connect()
	{	if (!this.protocol)
		{	await this.get_protocol();
		}
	}

	end()
	{	this.state_id = (this.state_id + 1) & 0x7FFFFFFF;
		let {state, protocol, cur_idle_resultsets} = this;
		this.state = State.IDLE_FRESH;
		this.protocol = undefined;
		this.cur_idle_resultsets = undefined;
		this.cur_stmt_id = -1;
		this.want_close_cur_stmt = false;
		if (protocol)
		{	switch (state)
			{	case State.IDLE_FRESH:
				case State.IDLE:
					if (cur_idle_resultsets)
					{	let the_protocol = protocol;
						cur_idle_resultsets.discard().then
						(	() =>
							{	this.onend(this.dsn, the_protocol);
							},
							e =>
							{	console.error(e);
								the_protocol.is_broken_connection = true;
								this.onend(this.dsn, the_protocol);
							}
						);
						return;
					}
					this.onend(this.dsn, protocol);
					return;
				case State.QUERYING:
					return; // fetch routine must call onend()
				default:
					debug_assert(false); // in CONNECTING, protocol is undefined
			}
		}
	}

	private async protocol_op<T>(protocol: MyProtocol, can_redo_n_attempt: number, orig_state_id: number, callback: () => Promise<T>): Promise<T|boolean>
	{	let {state} = this;
		if (this.state==State.QUERYING || this.state==State.CONNECTING)
		{	throw new BusyError(`Previous operation is still in progress`);
		}
		debug_assert(state==State.IDLE_FRESH || state==State.IDLE);
		let result: T;
		try
		{	this.state = State.QUERYING;
			result = await callback();
		}
		catch (e)
		{	debug_assert(this.state == State.QUERYING);
			if (!(e instanceof SqlError))
			{	protocol.is_broken_connection = true;
			}
			if (this.state_id != orig_state_id)
			{	this.onend(this.dsn, protocol);
				throw e;
			}
			this.state = State.IDLE;
			if (!(e instanceof SqlError))
			{	this.end();
				if (state==State.IDLE_FRESH && can_redo_n_attempt!=-1 && can_redo_n_attempt<DO_QUERY_ATTEMPTS && (e instanceof SendWithDataError))
				{	// maybe connection was killed while it was idle in pool
					return false; // redo COM_QUERY or COM_STMT_PREPARE
				}
			}
			if (this.want_close_cur_stmt)
			{	await this.protocol_op(protocol, can_redo_n_attempt, orig_state_id, () => protocol.send_com_stmt_close(this.cur_stmt_id));
				this.cur_stmt_id = -1;
				this.want_close_cur_stmt = false;
			}
			throw e;
		}
		if (this.state_id != orig_state_id)
		{	this.onend(this.dsn, protocol);
			throw new CanceledError(`Operation cancelled: end() called during query`);
		}
		this.state = State.IDLE;
		if (this.want_close_cur_stmt)
		{	await this.protocol_op(protocol, can_redo_n_attempt, orig_state_id, () => protocol.send_com_stmt_close(this.cur_stmt_id));
			this.cur_stmt_id = -1;
			this.want_close_cur_stmt = false;
		}
		return can_redo_n_attempt==-1 ? result : true;
	}

	query(sql: SqlSource, params?: object|null)
	{	return new ResultsetsPromise
		(	(y, n) =>
			{	this.do_query(sql, params, RowType.OBJECT).then(y, n);
			}
		);
	}

	queryMap(sql: SqlSource, params?: object|null)
	{	return new ResultsetsPromise
		(	(y, n) =>
			{	this.do_query(sql, params, RowType.MAP).then(y, n);
			}
		);
	}

	queryArr(sql: SqlSource, params?: object|null)
	{	return new ResultsetsPromise
		(	(y, n) =>
			{	this.do_query(sql, params, RowType.ARRAY).then(y, n);
			}
		);
	}

	queryCol(sql: SqlSource, params?: object|null)
	{	return new ResultsetsPromise
		(	(y, n) =>
			{	this.do_query(sql, params, RowType.FIRST_COLUMN).then(y, n);
			}
		);
	}

	async makeLastColumnReader(sql: SqlSource, params?: object|null)
	{	let resultsets = await this.do_query(sql, params, RowType.LAST_COLUMN_READER);
		let it = resultsets[Symbol.asyncIterator]();
		let {value} = await it.next();
		return value;
	}

	async forQuery<T>(sql: SqlSource, callback: (prepared: Resultsets) => Promise<T>): Promise<T>
	{	if (this.cur_stmt_id != -1)
		{	throw new BusyError(`Another prepared statement is active`);
		}
		let {state_id} = this;
		let prepared = await this.do_query(sql, true, RowType.OBJECT);
		try
		{	if (this.state_id == state_id)
			{	this.cur_stmt_id = prepared.stmt_id;
				return await callback(prepared);
			}
		}
		finally
		{	if (this.state_id == state_id)
			{	if (this.state == State.QUERYING)
				{	this.want_close_cur_stmt = true;
				}
				else
				{	this.cur_stmt_id = -1;
					if (prepared.has_more)
					{	await prepared.discard();
					}
					await this.protocol?.send_com_stmt_close(prepared.stmt_id);
				}
			}
		}
		throw new CanceledError(`Operation cancelled: end() called during query`);
	}

	async execute(sql: SqlSource, params?: object|null): Promise<Resultsets>
	{	let resultsets = await this.do_query(sql, params, RowType.FIRST_COLUMN);
		await resultsets.discard();
		return resultsets;
	}

	private async do_query(sql: SqlSource, params: object|true|null|undefined, row_type: RowType): Promise<ResultsetsDriver>
	{	if (this.cur_idle_resultsets)
		{	throw new BusyError(`Please, read previous resultsets first`);
		}
		if (sql instanceof Sql)
		{	sql.allowedSqlIdents = this.allowed_sql_idents;
		}
		for (let n_attempt=1; true; n_attempt++)
		{	let protocol = this.protocol ?? await this.get_protocol();
			let {state_id} = this;
			let resultsets = new ResultsetsDriver;
			let ok = false;

			if (!params)
			{	// Text protocol query
				ok = true === await this.protocol_op
				(	protocol,
					n_attempt,
					state_id,
					async () =>
					{	await protocol.send_com_query(sql);
						await protocol.read_com_query_response(resultsets);
					}
				);
			}
			else if (params === true)
			{	// Prepare for later execution
				resultsets.stmt_execute = async (params: any[]) =>
				{	await this.protocol_op(protocol, -1, state_id, () => protocol.send_com_stmt_execute(resultsets, params));
					this.set_cur_idle_resultsets(protocol, state_id, resultsets, row_type);
				};

				ok = true === await this.protocol_op
				(	protocol,
					n_attempt,
					state_id,
					async () =>
					{	await protocol.send_com_stmt_prepare(sql);
						await protocol.read_com_stmt_prepare_response(resultsets);
					}
				);
			}
			else if (Array.isArray(params))
			{	// Prepare to execute immediately: positional parameters
				ok = true === await this.protocol_op
				(	protocol,
					n_attempt,
					state_id,
					async () =>
					{	await protocol.send_com_stmt_prepare(sql);
						await protocol.read_com_stmt_prepare_response(resultsets);
						await protocol.send_com_stmt_execute(resultsets, params);
					}
				);
			}
			else
			{	// Prepare to execute immediately: named parameters
				let sql_set = "";
				let params_set: any[] = [];
				for (let [n, v] of Object.entries(params))
				{	sql_set += !sql_set.length ? "SET @`" : "`=?,@`";
					sql_set += n.replaceAll('`', '``');
					params_set[params_set.length] = v;
				}

				ok = true === await this.protocol_op
				(	protocol,
					n_attempt,
					state_id,
					async () =>
					{	if (sql_set.length != 0)
						{	let resultsets_set = new ResultsetsDriver;
							await protocol.send_com_stmt_prepare(sql_set+"`=?");
							await protocol.read_com_stmt_prepare_response(resultsets_set);
							await protocol.send_com_stmt_execute(resultsets_set, params_set);
							debug_assert(!resultsets_set.has_more);
						}
						await protocol.send_com_stmt_prepare(sql);
						await protocol.read_com_stmt_prepare_response(resultsets);
						await protocol.send_com_stmt_execute(resultsets, []);
					}
				);
			}

			if (ok)
			{	this.set_cur_idle_resultsets(protocol, state_id, resultsets, row_type);
				return resultsets;
			}

			// redo
		}
	}

	private set_cur_idle_resultsets(protocol: MyProtocol, orig_state_id: number, resultsets: ResultsetsDriver, row_type: RowType)
	{	if (resultsets.has_more)
		{	this.cur_idle_resultsets = resultsets;
			if (row_type != RowType.LAST_COLUMN_READER)
			{	resultsets.fetch = async () =>
				{	if (!resultsets.has_more_rows)
					{	return undefined;
					}
					let row = await this.protocol_op(protocol, -1, orig_state_id, () => protocol.fetch(resultsets, row_type));
					if (!resultsets.has_more)
					{	this.cur_idle_resultsets = undefined;
					}
					return row;
				};
			}
			else
			{	let is_fetching = false;
				resultsets.fetch = async () =>
				{	if (is_fetching)
					{	throw new BusyError(`Please, read previous column reader to the end`);
					}
					if (!resultsets.has_more_rows)
					{	return undefined;
					}
					is_fetching = true;
					let row = await this.protocol_op
					(	protocol,
						-1,
						orig_state_id,
						() => protocol.fetch
						(	resultsets,
							row_type,
							async () =>
							{	is_fetching = false;
								if (this.state_id == orig_state_id)
								{	this.state = State.IDLE;
									await resultsets.discard();
									this.cur_idle_resultsets = undefined;
								}
							}
						)
					);
					this.state = State.QUERYING;
					return row;
				};
			}

			resultsets.next_resultset = async () =>
			{	await this.protocol_op(protocol, -1, orig_state_id, () => protocol.next_resultset(resultsets));
				if (!resultsets.has_more)
				{	this.cur_idle_resultsets = undefined;
					return false;
				}
				else
				{	return true;
				}
			};
		}
	}
}
