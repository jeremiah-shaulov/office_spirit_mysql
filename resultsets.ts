import {FieldType, Charset} from './constants.ts';
import {CanceledError} from "./errors.ts";

export type ColumnValue = null | boolean | number | bigint | Date | string | Uint8Array;
export type Param = any;
export type Params = Param[] | Record<string, Param> | null | undefined;

export class ResultsetsPromise<Row> extends Promise<Resultsets<Row>>
{	async all()
	{	let resultsets = await this;
		let rows = [];
		for await (let row of resultsets)
		{	rows[rows.length] = row;
		}
		return rows;
	}

	async first()
	{	let resultsets = await this;
		let it = resultsets[Symbol.asyncIterator]();
		let {value, done} = await it.next();
		if (!done)
		{	while (!(await it.next()).done);
			return value===undefined ? undefined : value; // void -> undefined
		}
	}

	async forEach<T>(callback: (row: Row) => T|Promise<T>): Promise<T|undefined>
	{	let resultsets = await this;
		let result: T|undefined;
		for await (let row of resultsets)
		{	result = await callback(row);
		}
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

	get hasMore(): boolean
	{	return this instanceof ResultsetsDriver ? this.has_more : false;
	}

	exec(params: Param[])
	{	if (this instanceof ResultsetsDriver)
		{	return this.stmt_execute(params);
		}
		else
		{	return Promise.resolve();
		}
	}

	async *[Symbol.asyncIterator]()
	{	if (this instanceof ResultsetsDriver)
		{	while (true)
			{	let row: Row = await this.fetch();
				if (row == undefined)
				{	break;
				}
				yield row;
			}
		}
	}

	async all()
	{	let rows = [];
		for await (let row of this)
		{	rows[rows.length] = row;
		}
		return rows;
	}

	async first()
	{	let it = this[Symbol.asyncIterator]();
		let {value, done} = await it.next();
		if (!done)
		{	while (!(await it.next()).done);
			return value as Row;
		}
	}

	async forEach<T>(callback: (row: Row) => T|Promise<T>): Promise<T|undefined>
	{	let result: T|undefined;
		for await (let row of this)
		{	result = await callback(row);
		}
		return result;
	}

	nextResultset()
	{	if (this instanceof ResultsetsDriver)
		{	return this.next_resultset();
		}
		else
		{	return Promise.resolve(false);
		}
	}

	async discard()
	{	if (this instanceof ResultsetsDriver)
		{	if (this.has_more)
			{	try
				{	while (await this.next_resultset());
				}
				catch (e)
				{	if (!(e instanceof CanceledError))
					{	throw e;
					}
				}
			}
			this.stmt_execute = () => Promise.resolve();
			this.fetch = () => Promise.resolve(undefined);
			this.next_resultset = () => Promise.resolve(false);
		}
		else
		{	while (await this.nextResultset());
		}
	}
}

export class ResultsetsDriver<Row> extends Resultsets<Row>
{	stmt_id = -1;
	has_more_rows = false;
	has_more = false;
	stmt_execute: (params: Param[]) => Promise<void> = () => Promise.resolve();
	fetch: () => Promise<Row | undefined> = () => Promise.resolve(undefined);
	next_resultset: () => Promise<boolean> = () => Promise.resolve(false);

	reset_fields()
	{	this.lastInsertId = 0;
		this.affectedRows = 0;
		this.foundRows = 0;
		this.warnings = 0;
		this.statusInfo = '';
		this.noGoodIndexUsed = false;
		this.noIndexUsed = false;
		this.isSlowQuery = false;
		this.stmt_id = -1;
	}
}

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
