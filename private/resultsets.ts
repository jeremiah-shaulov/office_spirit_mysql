import {MysqlType, Charset, ColumnFlags, CharsetNames} from './constants.ts';
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
	{	const resultsets: Resultsets<Row> = await this;
		const rows = new Array<Row>;
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
	{	const resultsets: Resultsets<Row> = await this;
		const it = resultsets[Symbol.asyncIterator]();
		const item = await it.next();
		await resultsets.discard();
		return item.done ? undefined : item.value; // void -> undefined
	}

	/**	Reads all rows in the first resultset, and calls the provided callback for each of them.
		If there're more resultsets, they will be skipped (discarded).
	 **/
	async forEach<T>(callback: (row: Row) => T|Promise<T>): Promise<T|undefined>
	{	const resultsets: Resultsets<Row> = await this;
		let result: T|undefined;
		for await (const row of resultsets)
		{	result = await callback(row);
		}
		await resultsets.discard();
		return result;
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<Row>
	{	const resultsets = await this;
		yield *resultsets[Symbol.asyncIterator]();
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

	/**	Calls `this.discard()` and if this is a prepared statement, deallocates it.
	 **/
	[Symbol.asyncDispose]()
	{	return this.discard();
	}

	/**	True if there are more rows or resultsets to read.
	 **/
	get hasMore()
	{	return false;
	}

	/**	Execute (again) a prepared statement.
	 **/
	exec(_params: Param[]): ResultsetsPromise<Row>
	{	throw new Error('Not implemented');
	}

	/**	Iterates over rows in current resultset.
	 **/
	async *[Symbol.asyncIterator](): AsyncGenerator<Row>
	{
	}

	/**	Reads all rows in current resultset to an array.
	 **/
	async all()
	{	const rows = new Array<Row>;
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

/**	This library creates resultsets as ResultsetsInternal object, but exposes them as Resultsets.
	Methods that don't exist on Resultsets are for internal use.
 **/
export class ResultsetsInternal<Row> extends Resultsets<Row>
{	protocol: MyProtocol | undefined;
	isPreparedStmt = false; // `stmtId` can be reset to -1 when the stmt is disposed, but `isPreparedStmt` must remain true, because the stmt can be disposed before resultsets are read, and prepared stmts have different packet format
	stmtId = -1;
	hasMoreInternal = false;

	constructor(public rowType: RowType)
	{	super();
	}

	/**	Calls `this.discard()` and if this is a prepared statement, deallocates it.
	 **/
	[Symbol.asyncDispose]()
	{	if (this.stmtId != -1)
		{	this.disposePreparedStmt();
		}
		return this.discard();
	}

	get hasMore()
	{	return this.hasMoreInternal;
	}

	exec(params: Param[])
	{	return new ResultsetsPromise<Row>
		(	(y, n) =>
			{	if (!this.protocol)
				{	throw new CanceledError(`Connection terminated`);
				}
				let promise = this.protocol.execStmt(this, params);
				if (this.rowType == RowType.VOID)
				{	promise = promise.then(() => this.discard());
				}
				return promise.then(() => {y(this)}, n);
			}
		);
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<Row>
	{	if (this.hasMoreInternal)
		{	while (true)
			{	if (!this.protocol)
				{	throw new CanceledError(`Connection terminated`);
				}
				const row: Row|undefined = await this.protocol.fetch(this.rowType);
				if (row === undefined)
				{	break;
				}
				yield row;
			}
		}
	}

	nextResultset()
	{	if (!this.hasMoreInternal)
		{	return Promise.resolve(false);
		}
		if (!this.protocol)
		{	throw new CanceledError(`Connection terminated`);
		}
		return this.protocol.nextResultset();
	}

	async discard()
	{	if (this.hasMoreInternal)
		{	while (this.protocol && await this.protocol.nextResultset(true));
		}
	}

	disposePreparedStmt()
	{	const {protocol, stmtId} = this;
		if (protocol)
		{	this.stmtId = -1;
			if (!this.hasMoreInternal)
			{	this.protocol = undefined;
			}
			protocol.disposePreparedStmt(stmtId);
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
		public charsetId: Charset,
		public length: number,
		public typeId: MysqlType,
		public flags: ColumnFlags,
		public decimals: number
	)
	{
	}

	get charset()
	{	return CharsetNames[this.charsetId] ?? '';
	}

	/**	Get MySQL type of the column as string, like "varchar", "integer unsigned", "enum", etc.
		If cannot determine the type, returns empty string.
	 **/
	get type()
	{	switch (this.typeId)
		{	case MysqlType.MYSQL_TYPE_DECIMAL: return 'decimal';
			case MysqlType.MYSQL_TYPE_TINY: return this.flags & ColumnFlags.UNSIGNED ? 'tinyint unsigned' : 'tinyint';
			case MysqlType.MYSQL_TYPE_SHORT: return this.flags & ColumnFlags.UNSIGNED ? 'smallint unsigned' : 'smallint';
			case MysqlType.MYSQL_TYPE_LONG: return this.flags & ColumnFlags.UNSIGNED ? 'integer unsigned' : 'integer';
			case MysqlType.MYSQL_TYPE_FLOAT: return 'float';
			case MysqlType.MYSQL_TYPE_DOUBLE: return 'double';
			case MysqlType.MYSQL_TYPE_NULL: return 'NULL';
			case MysqlType.MYSQL_TYPE_TIMESTAMP: return 'timestamp';
			case MysqlType.MYSQL_TYPE_LONGLONG: return this.flags & ColumnFlags.UNSIGNED ? 'bigint unsigned' : 'bigint';
			case MysqlType.MYSQL_TYPE_INT24: return this.flags & ColumnFlags.UNSIGNED ? 'mediumint unsigned' : 'mediumint';
			case MysqlType.MYSQL_TYPE_DATE: return 'date';
			case MysqlType.MYSQL_TYPE_TIME: return 'time';
			case MysqlType.MYSQL_TYPE_DATETIME: return 'datetime';
			case MysqlType.MYSQL_TYPE_YEAR: return 'year';
			case MysqlType.MYSQL_TYPE_VARCHAR: return 'varchar';
			case MysqlType.MYSQL_TYPE_BIT: return 'bit';
			case MysqlType.MYSQL_TYPE_JSON: return 'json';
			case MysqlType.MYSQL_TYPE_NEWDECIMAL: return 'decimal';
			case MysqlType.MYSQL_TYPE_ENUM: return 'enum';
			case MysqlType.MYSQL_TYPE_SET: return 'set';
			case MysqlType.MYSQL_TYPE_TINY_BLOB: return this.flags & ColumnFlags.BINARY ? 'tinyblob' : 'tinytext';
			case MysqlType.MYSQL_TYPE_MEDIUM_BLOB: return this.flags & ColumnFlags.BINARY ? 'mediumblob' : 'mediumtext';
			case MysqlType.MYSQL_TYPE_LONG_BLOB: return this.flags & ColumnFlags.BINARY ? 'longblob' : 'longtext';
			case MysqlType.MYSQL_TYPE_BLOB:
				if (this.length==0xFF || this.length==0xFF*2 || this.length==0xFF*3 || this.length==0xFF*4) // there can be 1, 2, 3 and 4 bytes per char
				{	return this.flags & ColumnFlags.BINARY ? 'tinyblob' : 'tinytext';
				}
				else if (this.length==0xFFFFFF || this.length==0xFFFFFF*2 || this.length==0xFFFFFF*3 || this.length==0xFFFFFF*4) // there can be 1, 2, 3 and 4 bytes per char
				{	return this.flags & ColumnFlags.BINARY ? 'mediumblob' : 'mediumtext';
				}
				else if (this.length > 0xFFFFFF*4)
				{	return this.flags & ColumnFlags.BINARY ? 'longblob' : 'longtext';
				}
				else
				{	return this.flags & ColumnFlags.BINARY ? 'blob' : 'text';
				}
			case MysqlType.MYSQL_TYPE_VAR_STRING: return this.flags & ColumnFlags.BINARY ? 'varbinary' : 'varchar';
			case MysqlType.MYSQL_TYPE_STRING: return this.flags & ColumnFlags.BINARY ? 'binary' : 'char';
			case MysqlType.MYSQL_TYPE_GEOMETRY: return 'geometry';
		}
		return '';
	}

	get isNotNull()
	{	return (this.flags & ColumnFlags.NOT_NULL) != 0;
	}

	get isPrimaryKey()
	{	return (this.flags & ColumnFlags.PRI_KEY) != 0;
	}

	get isUniqueKey()
	{	return (this.flags & ColumnFlags.UNIQUE_KEY) != 0;
	}

	get isKey()
	{	return (this.flags & (ColumnFlags.PRI_KEY | ColumnFlags.UNIQUE_KEY | ColumnFlags.MULTIPLE_KEY)) != 0;
	}

	get isAutoIncrement()
	{	return (this.flags & ColumnFlags.AUTO_INCREMENT) != 0;
	}

	get isUnsigned()
	{	return (this.flags & ColumnFlags.UNSIGNED) != 0;
	}

	get isZeroFill()
	{	return (this.flags & ColumnFlags.ZEROFILL) != 0;
	}
}
