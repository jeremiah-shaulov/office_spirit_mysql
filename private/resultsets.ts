import {MysqlType, Charset, ColumnFlags, CHARSET_NAMES} from './constants.ts';
import {CanceledError} from './errors.ts';
import {MyProtocol, RowType} from './my_protocol.ts';
import {MyProtocolReaderWriterSerializer} from './my_protocol_reader_writer_serializer.ts';

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

	/**	Reads all rows in the first resultset, and stores them either in memory or on disk.
		Other resultsets will be skipped (discarded).
		The threshold for storing on disk is set in DSN parameter `storeResultsetIfBigger`.
		Use this function if you want to read a large resultset, and iterate over it later,
		and being able to perform other queries in the meantime.
	 **/
	async *allStored(): AsyncIterable<Row>
	{	const resultsets: Resultsets<Row> = await this;
		try
		{	yield *resultsets.allStored();
		}
		finally
		{	await resultsets.discard();
		}
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
	(	/**	Information about columns in resultset.
		 **/
		public columns: Column[] = [],

		/**	In INSERT queries this is last generated AUTO_INCREMENT ID
		 **/
		public lastInsertId: number|bigint = 0,

		/**	In modifying queries, like INSERT, UPDATE and DELETE this shows how many rows were affected by the query
		 **/
		public affectedRows: number|bigint = 0,

		/**	If "foundRows" connection attribute is set, will ask the server to report about "found rows" (matched by the WHERE clause), instead of affected, and "affectedRows" will not be used. See [this page](https://dev.mysql.com/doc/c-api/5.7/en/mysql-affected-rows.html) for more information.
		 **/
		public foundRows: number|bigint = 0,

		/**	Number of warnings produced by the last query. To see the warning messages you can use `SHOW WARNINGS` query.
		 **/
		public warnings: number = 0,

		/**	Human-readable information about last query result, if sent by server.
		 **/
		public statusInfo = '',

		/**	Server can report about nonoptimal queries.
		 **/
		public noGoodIndexUsed = false,

		public noIndexUsed = false,
		public isSlowQuery = false,

		/**	Number of `?`-placeholders in the SQL query.
		 **/
		public nPlaceholders = 0
	)
	{
	}

	/**	This variable is updated after reading each row from the server.
		It is set to the number of raw (not interpreted) bytes sent from the server for this row.
		The value depends on the MySQL protocol used for the query: either text or binary.
	 **/
	lastRowByteLength = 0;

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

	/**	If this is a prepared query, this function executes it again.
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

	/**	Reads all rows in current resultset, and stores them either in memory or on disk.
		The threshold for storing on disk is set in DSN parameter `storeResultsetIfBigger`.
		Use this function if you want to read a large resultset, and iterate over it later,
		and being able to perform other queries in the meantime.
	 **/
	allStored(): AsyncIterable<Row>
	{	if (!(this instanceof ResultsetsInternal))
		{	throw new Error('Not implemented');
		}
		return this.allStored();
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
	override [Symbol.asyncDispose]()
	{	if (this.stmtId != -1)
		{	this.disposePreparedStmt();
		}
		return this.discard();
	}

	override get hasMore()
	{	return this.hasMoreInternal;
	}

	override exec(params: Param[])
	{	return new ResultsetsPromise<Row>
		(	(y, n) =>
			{	if (params.length != this.nPlaceholders)
				{	throw new Error(`Number of passed parameters (${params.length}) doesn't match the number of query placeholders (${this.nPlaceholders})`);
				}
				if (!this.protocol)
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

	override async *[Symbol.asyncIterator](): AsyncGenerator<Row>
	{	if (this.hasMoreInternal)
		{	try
			{	while (true)
				{	if (!this.protocol)
					{	throw new CanceledError(`Connection terminated`);
					}
					this.protocol.totalBytesInPacket = 0;
					const row: Row|undefined = await this.protocol.fetch(this.rowType);
					this.lastRowByteLength = this.protocol?.totalBytesInPacket ?? 0;
					if (row === undefined)
					{	break;
					}
					yield row;
				}
			}
			finally
			{	if (this.hasMoreInternal)
				{	while (this.protocol)
					{	const row: Row|undefined = await this.protocol.fetch(this.rowType);
						if (row === undefined)
						{	break;
						}
					}
				}
			}
		}
	}

	override nextResultset()
	{	if (!this.hasMoreInternal)
		{	return Promise.resolve(false);
		}
		if (!this.protocol)
		{	throw new CanceledError(`Connection terminated`);
		}
		return this.protocol.nextResultset();
	}

	override async discard()
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

	override async *allStored(): AsyncIterable<Row>
	{	const {rowType} = this;
		if (rowType!=RowType.OBJECT && rowType!=RowType.ARRAY && rowType!=RowType.MAP)
		{	throw new Error('Invalid use of allStored() method. This row type must be an object, an array or a map.');
		}
		const rows = new Array<Row>;
		const {protocol, columns} = this;
		if (!protocol)
		{	throw new CanceledError(`Connection terminated`);
		}
		const {storeResultsetIfBigger} = protocol.dsn;
		let size = 0;
		let file: Deno.FsFile | undefined;
		let writer: WritableStreamDefaultWriter<Uint8Array<ArrayBufferLike>> | undefined;
		let reader: ReadableStreamBYOBReader | undefined;
		let serializer: MyProtocolReaderWriterSerializer | undefined;
		let nRows = 0;
		try
		{	for await (const row of this)
			{	nRows++;
				size += this.lastRowByteLength;
				if (size <= storeResultsetIfBigger)
				{	rows[rows.length] = row;
				}
				else if (!serializer)
				{	rows[rows.length] = row;
					const fileName = await Deno.makeTempFile({prefix: `rows-${protocol.dsn.hash}-${protocol.connectionId}-`, suffix: '.dat'});
					file = await Deno.open(fileName, {create: true, truncate: true, write: true, read: true});
					writer = file.writable.getWriter();
					reader = file.readable.getReader({mode: 'byob'});
					serializer = new MyProtocolReaderWriterSerializer(writer, reader, new TextDecoder, undefined);
					serializer.serializeBegin();
					for (const row of rows)
					{	const rowArr = Array.isArray(row) ? row : row instanceof Map ? [...row.values()] : typeof(row)=='object' && row ? Object.values(row) : [];
						await serializer.serializeRowBinary(rowArr, columns, protocol.dsn.datesAsString, protocol);
					}
					rows.length = 0;
				}
				else
				{	const rowArr = Array.isArray(row) ? row : row instanceof Map ? [...row.values()] : typeof(row)=='object' && row ? Object.values(row) : [];
					await serializer.serializeRowBinary(rowArr, columns, protocol.dsn.datesAsString, protocol);
				}
			}
			if (file && serializer)
			{	await serializer.serializeEnd();
				await file.seek(0, Deno.SeekMode.Start);
				for (let i=0; i<nRows; i++)
				{	const {row} = await serializer.deserializeRowBinary(rowType, columns, protocol.dsn.datesAsString, protocol, Number.MAX_SAFE_INTEGER);
					yield row;
				}
			}
		}
		finally
		{	try
			{	writer?.releaseLock();
			}
			catch
			{	// ignore
			}
			try
			{	reader?.releaseLock();
			}
			catch
			{	// ignore
			}
			file?.close();
		}
		for (const row of rows)
		{	yield row;
		}
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
	{	return CHARSET_NAMES[this.charsetId] ?? '';
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
