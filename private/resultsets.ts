import {MysqlType, Charset, ColumnFlags, CHARSET_NAMES} from './constants.ts';
import {CanceledError} from './errors.ts';
import {MyProtocol, RowType} from './my_protocol.ts';
import {MyProtocolReaderWriterSerializer} from './my_protocol_reader_writer_serializer.ts';

const DEFAULT_STORE_RESULTSET_IF_BIGGER = 64*1024; // 64KiB

export type JsonNode = null | boolean | number | string | JsonNode[] | {[member: string]: JsonNode};
export type ColumnValue = bigint | Date | Uint8Array | JsonNode;

// deno-lint-ignore no-explicit-any
export type Param = any;
export type Params = Param[] | Record<string, Param> | null | undefined;

// deno-lint-ignore no-explicit-any
type Any = any;

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

	/**	Reads all rows of the first resultset (if `allResultsets` is false)
		or of all resultsets (if `allResultsets` is true), and stores them either in memory or on disk.
		Other resultsets will be discarded (if `allResultsets` is false).

		This method returns `Resultsets` object, which is detached from the connection,
		so you can perform other queries while you iterate over this object.

		The threshold for storing on disk is set in DSN parameter {@link Dsn.storeResultsetIfBigger}.

		You need to read this object to the end to release the file resource.
		Or you can call `await resultsets.discard()` or to bind this `Resultsets` object to an `await using` variable.
	 **/
	async store(allResultsets=false): Promise<Resultsets<Row>>
	{	const resultsets: Resultsets<Row> = await this;
		return await resultsets.store(allResultsets);
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
		public columns = new Array<Column>,

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
		public warnings = 0,

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

	/**	Reads all rows of the first resultset in this object (if `allResultsets` is false)
		or of all resultsets in this object (if `allResultsets` is true), and stores them either in memory or on disk.
		Other resultsets will be discarded (if `allResultsets` is false).

		After the call this `Resultsets` object is detached from the connection,
		so you can perform other queries while you iterate over this object.

		The threshold for storing on disk is set in DSN parameter {@link Dsn.storeResultsetIfBigger}.

		You need to read this object to the end to release the file resource.
		Or you can call `await resultsets.discard()` or to bind this `Resultsets` object to an `await using` variable.

		@returns `this` object, which is now detached from the connection.
	 **/
	store(_allResultsets=false): Promise<this>
	{	throw new Error('Not implemented');
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
	storedResultsets: StoredResultsets<Row> | undefined;

	constructor(readonly rowType: RowType, readonly maxColumnLen: number, readonly jsonAsString: boolean, readonly datesAsString: boolean, readonly correctDates: boolean)
	{	super();
	}

	/**	Calls `this.discard()` and if this is a prepared statement, deallocates it.
	 **/
	override [Symbol.asyncDispose]()
	{	if (this.stmtId != -1)
		{	this.disposePreparedStmt();
		}
		return this.storedResultsets ? this.storedResultsets[Symbol.asyncDispose]() : this.discard();
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
				let promise = this.protocol.execStmt(this, params, this.correctDates);
				if (this.rowType == RowType.VOID)
				{	promise = promise.then(() => this.discard());
				}
				return promise.then(() => {y(this)}, n);
			}
		);
	}

	override async *[Symbol.asyncIterator](): AsyncGenerator<Row>
	{	const {storedResultsets, maxColumnLen, jsonAsString, datesAsString} = this;
		if (storedResultsets)
		{	if (storedResultsets.hasMore)
			{	yield *storedResultsets[Symbol.asyncIterator]();
			}
		}
		else
		{	if (this.hasMoreInternal)
			{	try
				{	while (true)
					{	if (!this.protocol)
						{	throw new CanceledError(`Connection terminated`);
						}
						this.protocol.totalBytesInPacket = 0;
						const row: Row|undefined = await this.protocol.fetch(this.rowType, maxColumnLen, jsonAsString, datesAsString);
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
						{	const row: Row|undefined = await this.protocol.fetch(this.rowType, maxColumnLen, jsonAsString, datesAsString);
							if (row === undefined)
							{	break;
							}
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

	override async store(allResultsets=false): Promise<this>
	{	if (!this.storedResultsets)
		{	const {rowType, protocol, maxColumnLen, jsonAsString, datesAsString} = this;
			if (rowType!=RowType.OBJECT && rowType!=RowType.ARRAY && rowType!=RowType.MAP)
			{	throw new Error('Invalid use of store() method. This row type must be an object, an array or a map.');
			}
			if (protocol) // if there are resultsets to read
			{	const storedRows = new Array<ColumnValue[]>; // read rows to here
				const storeResultsetIfBigger = protocol.dsn.storeResultsetIfBigger>=0 ? protocol.dsn.storeResultsetIfBigger : DEFAULT_STORE_RESULTSET_IF_BIGGER;
				const {decoder} = protocol;
				protocol.totalBytesInPacket = 0;
				let curResultsetsInfo = {nRows: 0, columns: this.columns, lastInsertId: this.lastInsertId, affectedRows: this.affectedRows, foundRows: this.foundRows, warnings: this.warnings, statusInfo: this.statusInfo, noGoodIndexUsed: this.noGoodIndexUsed, noIndexUsed: this.noIndexUsed, isSlowQuery: this.isSlowQuery, nPlaceholders: this.nPlaceholders};
				const resultsetsInfo = [curResultsetsInfo];
				let serializer: MyProtocolReaderWriterSerializer | undefined;
				let error: Error | undefined;
				const storedResultsets = new StoredResultsets(this, rowType, jsonAsString, datesAsString, protocol, decoder, resultsetsInfo, storedRows);
				this.storedResultsets = storedResultsets;
				try
				{	while (true)
					{	const row: ColumnValue[]|undefined = await protocol.fetch(RowType.ARRAY, maxColumnLen, jsonAsString, datesAsString, true);
						if (row === undefined)
						{	if (!allResultsets || !this.hasMoreInternal)
							{	break;
							}
							await protocol.nextResultset();
							curResultsetsInfo = {nRows: 0, columns: this.columns, lastInsertId: this.lastInsertId, affectedRows: this.affectedRows, foundRows: this.foundRows, warnings: this.warnings, statusInfo: this.statusInfo, noGoodIndexUsed: this.noGoodIndexUsed, noIndexUsed: this.noIndexUsed, isSlowQuery: this.isSlowQuery, nPlaceholders: this.nPlaceholders};
							resultsetsInfo.push(curResultsetsInfo);
							continue;
						}
						curResultsetsInfo.nRows++;
						if (serializer)
						{	await serializer.serializeRowBinary(row, curResultsetsInfo.columns, datesAsString, protocol);
						}
						else
						{	storedRows[storedRows.length] = row;
							if (protocol.totalBytesInPacket > storeResultsetIfBigger)
							{	storedResultsets.fileName = await Deno.makeTempFile({prefix: `rows-${protocol.dsn.hash}-${protocol.connectionId}-`, suffix: '.dat'});
								storedResultsets.file = await Deno.open(storedResultsets.fileName, {create: true, truncate: true, write: true, read: true});
								storedResultsets.writer = storedResultsets.file.writable.getWriter();
								storedResultsets.reader = storedResultsets.file.readable.getReader({mode: 'byob'});
								serializer = new MyProtocolReaderWriterSerializer(storedResultsets.writer, storedResultsets.reader, decoder, undefined);
								storedResultsets.serializer = serializer;
								serializer.serializeBegin();
								let i = 0;
								for (const {nRows, columns} of resultsetsInfo)
								{	for (const end=i+nRows; i<end; i++)
									{	const row = storedRows[i];
										await serializer.serializeRowBinary(row, columns, datesAsString, protocol);
									}
								}
								storedRows.length = 0;
							}
						}
					}
				}
				catch (e)
				{	error = e instanceof Error ? e : new Error(e+'');
				}
				try
				{	await this.discard();
				}
				catch (e)
				{	error ??= e instanceof Error ? e : new Error(e+'');
				}
				if (error)
				{	await this.storedResultsets[Symbol.asyncDispose]();
					throw error;
				}
			}
		}
		return this;
	}
}

class StoredResultsets<Row>
{	nResultset = 0;
	nRow = 0;

	get hasMore()
	{	return this.nResultset < this.resultsetsInfo.length;
	}

	constructor
	(	public resultsets: ResultsetsInternal<Row>,
		public rowType: RowType,
		public jsonAsString: boolean,
		public datesAsString: boolean,
		public tz: {getTimezoneMsecOffsetFromSystem: () => number},
		public decoder: TextDecoder,
		public resultsetsInfo: Array<{nRows: number, columns: Column[], lastInsertId: number|bigint, affectedRows: number|bigint, foundRows: number|bigint, warnings: number, statusInfo: string, noGoodIndexUsed: boolean, noIndexUsed: boolean, isSlowQuery: boolean, nPlaceholders: number}>,
		public storedRows: ColumnValue[][],
		public fileName = '',
		public file?: Deno.FsFile,
		public writer?: WritableStreamDefaultWriter<Uint8Array<ArrayBufferLike>>,
		public reader?: ReadableStreamBYOBReader,
		public serializer?: MyProtocolReaderWriterSerializer,
	){}

	async [Symbol.asyncDispose]()
	{	let error: Error | undefined;
		try
		{	this.writer?.releaseLock();
			this.writer = undefined;
		}
		catch (e)
		{	error = e instanceof Error ? e : new Error(e+'');
		}
		try
		{	this.reader?.releaseLock();
			this.reader = undefined;
		}
		catch (e)
		{	error ??= e instanceof Error ? e : new Error(e+'');
		}
		try
		{	this.file?.close();
			this.file = undefined;
		}
		catch (e)
		{	error ??= e instanceof Error ? e : new Error(e+'');
		}
		if (this.fileName)
		{	try
			{	await Deno.remove(this.fileName);
				this.fileName = '';
			}
			catch (e)
			{	error ??= e instanceof Error ? e : new Error(e+'');
			}
		}
		if (error)
		{	throw error;
		}
	}

	nextResultset()
	{	const {resultsets, resultsetsInfo} = this;
		const r = resultsetsInfo[this.nResultset++];
		resultsets.columns = r.columns;
		resultsets.lastInsertId = r.lastInsertId;
		resultsets.affectedRows = r.affectedRows;
		resultsets.foundRows = r.foundRows;
		resultsets.warnings = r.warnings;
		resultsets.statusInfo = r.statusInfo;
		resultsets.noGoodIndexUsed = r.noGoodIndexUsed;
		resultsets.noIndexUsed = r.noIndexUsed;
		resultsets.isSlowQuery = r.isSlowQuery;
		resultsets.nPlaceholders = r.nPlaceholders;
		return r;
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<Row>
	{	const {rowType, jsonAsString, datesAsString, tz, decoder, storedRows, file, serializer} = this;
		if (file && serializer)
		{	if (this.nResultset == 0)
			{	await serializer.serializeEnd();
				await file.seek(0, Deno.SeekMode.Start);
			}
			try
			{	const {nRows, columns} = this.nextResultset();
				for (let i=0; i<nRows; i++)
				{	const {row} = await serializer.deserializeRowBinary(rowType, columns, jsonAsString, datesAsString, tz, Number.MAX_SAFE_INTEGER);
					yield row;
				}
			}
			finally
			{	if (this.nResultset == this.resultsetsInfo.length)
				{	await this[Symbol.asyncDispose]();
				}
			}
		}
		else
		{	const {nRows, columns} = this.nextResultset();
			const begin = this.nRow;
			const end = begin + nRows;
			this.nRow = end;
			for (let r=begin; r<end; r++)
			{	const rowArr = storedRows[r];
				const row: Any = rowType==RowType.OBJECT ? {} : rowType==RowType.MAP ? new Map : rowArr;
				for (let i=0; i<columns.length; i++)
				{	const {typeId, charsetId, name} = columns[i];
					let value = rowArr[i];
					switch (typeId)
					{	case MysqlType.MYSQL_TYPE_VARCHAR:
						case MysqlType.MYSQL_TYPE_ENUM:
						case MysqlType.MYSQL_TYPE_SET:
						case MysqlType.MYSQL_TYPE_VAR_STRING:
						case MysqlType.MYSQL_TYPE_STRING:
						case MysqlType.MYSQL_TYPE_TINY_BLOB:
						case MysqlType.MYSQL_TYPE_MEDIUM_BLOB:
						case MysqlType.MYSQL_TYPE_LONG_BLOB:
						case MysqlType.MYSQL_TYPE_BLOB:
						case MysqlType.MYSQL_TYPE_GEOMETRY:
							if (charsetId!=Charset.BINARY && value instanceof Uint8Array)
							{	value = decoder.decode(value);
							}
							break;
						case MysqlType.MYSQL_TYPE_DECIMAL:
						case MysqlType.MYSQL_TYPE_NEWDECIMAL:
							if (value instanceof Uint8Array)
							{	value = decoder.decode(value);
							}
							break;
						case MysqlType.MYSQL_TYPE_JSON:
							if (value instanceof Uint8Array)
							{	value = jsonAsString ? decoder.decode(value) : JSON.parse(decoder.decode(value));
							}
					}
					switch (rowType)
					{	case RowType.OBJECT:
							row[name] = value;
							break;
						case RowType.MAP:
							row.set(name, value);
							break;
						case RowType.ARRAY:
							rowArr[i] = value;
					}
				}
				yield row;
			}
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
