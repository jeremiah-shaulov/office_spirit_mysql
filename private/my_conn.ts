import {debugAssert} from './debug_assert.ts';
import {StatusFlags} from './constants.ts';
import {MyProtocol, RowType} from './my_protocol.ts';
import {SqlSource} from './my_protocol_reader_writer.ts';
import {BusyError, CanceledError} from './errors.ts';
import {Resultsets, ResultsetsProtocol, ResultsetsPromise} from './resultsets.ts';
import type {Param, Params, ColumnValue} from './resultsets.ts';
import {Dsn} from './dsn.ts';

export class MyConn
{	private protocol: MyProtocol|undefined;

	private isConnecting = false;

	constructor
	(	private dsn: Dsn,
		private maxConns: number,
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

	/**	If end() called during connection process, the connection will not be established after this function returns.
	 **/
	async connect()
	{	if (this.isConnecting)
		{	throw new BusyError(`Previous operation is still in progress`);
		}
		if (!this.protocol)
		{	this.isConnecting = true;
			try
			{	const protocol = await this.onbegin(this.dsn);
				if (!this.isConnecting) // end() called
				{	this.onend(this.dsn, protocol);
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
	{	const {protocol} = this;
		this.isConnecting = false;
		this.protocol = undefined;
		if (protocol)
		{	this.onend(this.dsn, protocol);
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

	private async doQuery<Row>(sql: SqlSource, params: Params|true, rowType: RowType): Promise<ResultsetsProtocol<Row>>
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
