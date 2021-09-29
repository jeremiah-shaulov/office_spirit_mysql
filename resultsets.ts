import {FieldType, Charset} from './constants.ts';
import {CanceledError} from "./errors.ts";

export type ColumnValue = null | boolean | number | bigint | Date | string | Uint8Array;
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
	get hasMore(): boolean
	{	return this instanceof ResultsetsDriver ? this.hasMoreSomething : false;
	}

	/**	Execute (again) a prepared statement.
	 **/
	exec(params: Param[])
	{	if (this instanceof ResultsetsDriver)
		{	return this.stmtExecute(params);
		}
		else
		{	return Promise.resolve();
		}
	}

	/**	Iterates over rows in current resultset.
	 **/
	async *[Symbol.asyncIterator]()
	{	if (this instanceof ResultsetsDriver)
		{	while (true)
			{	const row: Row = await this.fetch();
				if (row == undefined)
				{	break;
				}
				yield row;
			}
		}
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
	{	if (this instanceof ResultsetsDriver)
		{	return this.gotoNextResultset();
		}
		else
		{	return Promise.resolve(false);
		}
	}

	/**	Reads and discards all the rows in all the resultsets of this query.
	 **/
	async discard()
	{	if (this instanceof ResultsetsDriver)
		{	if (this.hasMoreSomething)
			{	try
				{	while (await this.gotoNextResultset());
				}
				catch (e)
				{	if (!(e instanceof CanceledError))
					{	throw e;
					}
				}
			}
			this.stmtExecute = () => Promise.resolve();
			this.fetch = () => Promise.resolve(undefined);
			this.gotoNextResultset = () => Promise.resolve(false);
		}
		else
		{	while (await this.nextResultset());
		}
	}
}

export class ResultsetsDriver<Row> extends Resultsets<Row>
{	stmtId = -1;
	hasMoreRows = false;
	hasMoreSomething = false;
	stmtExecute: (params: Param[]) => Promise<void> = () => Promise.resolve();
	fetch: () => Promise<Row | undefined> = () => Promise.resolve(undefined);
	gotoNextResultset: () => Promise<boolean> = () => Promise.resolve(false);

	resetFields()
	{	this.lastInsertId = 0;
		this.affectedRows = 0;
		this.foundRows = 0;
		this.warnings = 0;
		this.statusInfo = '';
		this.noGoodIndexUsed = false;
		this.noIndexUsed = false;
		this.isSlowQuery = false;
		this.stmtId = -1;
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
