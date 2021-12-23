import {FieldType, Charset} from './constants.ts';
import {CanceledError} from "./errors.ts";
import {MyProtocol, RowType} from "./my_protocol.ts";

export type JsonNode = null | boolean | number | string | JsonNode[] | {[member: string]: JsonNode};
export type ColumnValue = bigint | Date | Uint8Array | JsonNode;

// deno-lint-ignore no-explicit-any
export type Param = any;
export type Params = Param[] | Record<string, Param> | null | undefined;

export class ResultsetsPromise<Row> extends Promise<Resultsets<Row>>
{	/**	Reads all rows in the first resultset to an array.
		And if there're more resultsets, they will be skipped (discarded).
	 **/
	async all()
	{	const resultsets = await this;
		const rows = [];
		for await (const row of resultsets)
		{	rows[rows.length] = row;
		}
		await resultsets.discard();
		return rows;
	}

	/**	Returns the first row of the first resultset.
		And if there're more rows or resultsets, they all will be skipped (discarded).
	 **/
	async first()
	{	const resultsets = await this;
		const it = resultsets[Symbol.asyncIterator]();
		const {value, done} = await it.next();
		await resultsets.discard();
		return done || value===undefined ? undefined : value; // void -> undefined
	}

	/**	Reads all rows in the first resultset, and calls the provided callback for each of them.
		If there're more resultsets, they will be skipped (discarded).
	 **/
	async forEach<T>(callback: (row: Row) => T|Promise<T>): Promise<T|undefined>
	{	const resultsets = await this;
		let result: T|undefined;
		for await (const row of resultsets)
		{	result = await callback(row);
		}
		await resultsets.discard();
		return result;
	}
}

export class Resultsets<Row>
{	constructor
	(	public columns: Column[] = [],
		public lastInsertId: number|bigint = 0,
		public affectedRows: number|bigint = 0,
		public foundRows: number|bigint = 0,
		public warnings: number = 0,
		public statusInfo = '',
		public noGoodIndexUsed = false,
		public noIndexUsed = false,
		public isSlowQuery = false,
		public nPlaceholders = 0
	)
	{
	}

	/**	True if there are more rows or resultsets to read.
	 **/
	get hasMore()
	{	return false;
	}

	/**	Execute (again) a prepared statement.
	 **/
	exec(_params: Param[])
	{	return Promise.resolve();
	}

	/**	Iterates over rows in current resultset.
	 **/
	async *[Symbol.asyncIterator](): AsyncGenerator<Row>
	{
	}

	/**	Reads all rows in current resultset to an array.
	 **/
	async all()
	{	const rows = [];
		for await (const row of this)
		{	rows[rows.length] = row;
		}
		return rows;
	}

	/**	Reads all rows in current resultset, and returns the first row.
	 **/
	async first()
	{	const it = this[Symbol.asyncIterator]();
		const {value, done} = await it.next();
		if (!done)
		{	while (!(await it.next()).done);
			return value as Row;
		}
	}

	/**	Reads all rows in current resultset, and calls the provided callback for each of them.
	 **/
	async forEach<T>(callback: (row: Row) => T|Promise<T>): Promise<T|undefined>
	{	let result: T|undefined;
		for await (const row of this)
		{	result = await callback(row);
		}
		return result;
	}

	/**	Advances to the next resultset of this query, if there is one. Returns true if moved to the next resultset.
	 **/
	nextResultset()
	{	return Promise.resolve(false);
	}

	/**	Reads and discards all the rows in all the resultsets of this query.
	 **/
	async discard()
	{	while (await this.nextResultset());
	}
}

export class ResultsetsProtocol<Row> extends Resultsets<Row>
{	protocol: MyProtocol | undefined;
	isPreparedStmt = false; // `stmtId` can be reset to -1 when the stmt is disposed, but `isPreparedStmt` must remain true, because the stmt can be disposed before resultsets are read, and prepared stmts have different packet format
	stmtId = -1;
	hasMoreProtocol = false;

	constructor(public rowType: RowType)
	{	super();
	}

	get hasMore(): boolean
	{	return this.hasMoreProtocol;
	}

	exec(params: Param[]): Promise<void>
	{	if (!this.protocol)
		{	throw new CanceledError(`Connection terminated`);
		}
		return this.protocol.sendComStmtExecute(this, params);
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<Row>
	{	if (this.hasMoreProtocol)
		{	if (!this.protocol)
			{	throw new CanceledError(`Connection terminated`);
			}
			while (true)
			{	const row: Row|undefined = await this.protocol.fetch(this.rowType);
				if (row === undefined)
				{	break;
				}
				yield row;
			}
		}
	}

	nextResultset(): Promise<boolean>
	{	if (!this.hasMoreProtocol)
		{	return Promise.resolve(false);
		}
		if (!this.protocol)
		{	throw new CanceledError(`Connection terminated`);
		}
		return this.protocol.nextResultset();
	}

	async discard()
	{	if (this.hasMoreProtocol)
		{	while (this.protocol && await this.protocol.nextResultset(true));
		}
	}

	disposePreparedStmt()
	{	const {protocol, stmtId} = this;
		if (protocol)
		{	this.stmtId = -1;
			if (!this.hasMoreProtocol)
			{	this.protocol = undefined;
			}
			return protocol.disposePreparedStmt(stmtId);
		}
		else
		{	return Promise.resolve();
		}
	}

	resetFields()
	{	this.lastInsertId = 0;
		this.affectedRows = 0;
		this.foundRows = 0;
		this.warnings = 0;
		this.statusInfo = '';
		this.noGoodIndexUsed = false;
		this.noIndexUsed = false;
		this.isSlowQuery = false;
	}
}

/**	Array of such objects is found on `Resultsets.columns`.
	For SELECT queries MySQL server reports various information about each returned column.
 **/
export class Column
{	constructor
	(	public catalog: string,
		public schema: string,
		public table: string,
		public orgTable: string,
		public name: string,
		public orgName: string,
		public charset: Charset,
		public length: number,
		public type: FieldType,
		public flags: number,
		public decimals: number
	)
	{
	}
}
