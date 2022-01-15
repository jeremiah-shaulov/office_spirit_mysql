MySQL and MariaDB driver for Deno. Tested on: MySQL 5.6, 5.7, 8.0, MariaDB 5.5, 10.0, 10.2, 10.5, 10.7.

Features:
- Sane connections pooling. Connections are reset after usage (locks are freed).
- Pool for connections to multiple servers.
- Auto-retry connection if server is busy.
- Auto-retry queries if "deadlock" in autocommit mode, or if "lock wait timeout".
- Streaming BLOBs and `Deno.Reader`s.
- Custom handler for LOCAL INFILE.
- Advanced transactions manager: regular transactions, readonly, distributed (2-phase commit), savepoints.
- Prepared statements.
- Binary protocol. Query parameters are sent separately from text query.
- Made with CPU and RAM efficiency in mind.

This library is not just a driver, but it's ready to use tool, that covers many MySQL use cases.

Basic example:

```ts
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/main/README.md' | perl -ne '$y=$1 if /^```(ts\\b)?/;  print $_ if $y&&$m;  $m=$y&&($m||m~^// deno .*?/example1.ts~)' > /tmp/example1.ts
// deno run --allow-env --allow-net /tmp/example1.ts

import {MyPool} from 'https://deno.land/x/office_spirit_mysql@v0.7.1/mod.ts';

const pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');

pool.forConn
(	async conn =>
	{	await conn.query("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, message text)");
		await conn.query("INSERT INTO t_log (message) VALUES ('Message 1'), ('Message 2'), ('Message 3')");

		for await (const row of await conn.query("SELECT * FROM t_log"))
		{	console.log(row);
		}
	}
);

await pool.shutdown();
```

## Connections pool

Connections to database servers are managed by `MyPool` object.
You need to create one such object, and ask it to give you a free connection.
Most applications don't need more than one pool, but you can also have several pools, each one with different configuration.

```ts
MyPool.constructor(options?: Dsn | string | MyPoolOptions)
```

When you create a `MyPool` instance, you can give it a default DSN (Data Source Name), that will be used if the DSN is not specified when requesting a new connection.
You can provide the DSN as a string or as `Dsn` object, that contains parsed string.

Or you can specify more options:

```ts
interface MyPoolOptions
{	dsn?: Dsn | string;
	maxConns?: number;
	retryQueryTimes?: number;
	onLoadFile?: (filename: string) => Promise<(Deno.Reader & Deno.Closer) | undefined>;
	onBeforeCommit?: (conns: Iterable<MyConn>) => Promise<void>;
	managedXaDsns?: Dsn | string | (Dsn|string)[];
	xaCheckEach?: number;
	xaInfoTables?: {dsn: Dsn|string, table: string}[];
	logger?:
	{	debug(...args: any[]): unknown;
		info(...args: any[]): unknown;
		log(...args: any[]): unknown;
		warn(...args: any[]): unknown;
		error(...args: any[]): unknown;
	};
}
```
- `dsn` - Default Data Source Name for this pool.
- `maxConns` - (number, default `250`) Limit the number of simultaneous connections in this pool. When reached `pool.haveSlots()` returns false, and new connection requests will wait.
- `onLoadFile` - Handler for `LOAD DATA LOCAL INFILE` query.
- `onBeforeCommit` - Callback that will be called every time a transaction is about to be committed.
- `managedXaDsns` - Will automatically manage distributed transactions on DSNs listed here (will rollback or commit dangling transactions).
- `xaCheckEach` - Check for dangling transactions each this number of milliseconds (default `6000`).
- `xaInfoTables` - You can provide tables (that you need to create), that will improve distributed transactions management (optional).
- `logger` - a `console`-compatible logger, or `globalThis.console`. It will be used to report errors and print log messages.

Data Source Name is specified in URL format, with "mysql://" protocol.

Format: `mysql://user:password@host:port/schema?param1=value1&param2=value2#INITIAL_SQL`
Or: `mysql://user:password@localhost/path/to/named.pipe/schema`

Example: `mysql://root@localhost/`
Or: `mysql://root:hello@[::1]/?keepAliveTimeout=10000&foundRows`

The DSN can contain question mark followed by parameters. Possible parameters are:

- `connectionTimeout` (number, default `5000`) milliseconds - if connection to the server is failing, it will be retried during this period of time, each `reconnectInterval` milliseconds.
- `reconnectInterval` (number, default `1000`) milliseconds - will retry connecting to the server each this number of milliseconds, during the `connectionTimeout`.
- `keepAliveTimeout` (number, default `10000`) milliseconds - each connection will persist for this period of time, before termination, so it can be reused when someone else asks for the same connection
- `keepAliveMax` (number, default `Infinity`) - how many times at most to recycle each connection
- `maxColumnLen` (number, default `10MiB`) bytes - if a column was longer, it's value is skipped, and it will be returned as NULL (this doesn't apply to `conn.makeLastColumnReader()` - see below)
- `foundRows` (boolean, default `false`) - if present, will use "found rows" instead of "affected rows" in resultsets (see [here](https://dev.mysql.com/doc/refman/8.0/en/information-functions.html#function_row-count) how CLIENT_FOUND_ROWS flag affects result of `Row_count()` function)
- `ignoreSpace` (boolean, default `false`) - if present, parser on server side can ignore spaces before '(' in built-in function names (see description [here](https://dev.mysql.com/doc/refman/8.0/en/sql-mode.html#sqlmode_ignore_space))
- `multiStatements` (boolean, default `false`) - if present, SQL can contain multiple statements separated with ';', so you can upload dumps, but SQL injection attacks become more risky
- `retryQueryTimes` - (number, default `0`) Automatically reissue queries this number of attempts, if error was "deadlock" in autocommit mode, or "lock wait timeout" in both modes. Please note, that this will also rerun queries like `CALL`.

## Connections

A new connection from connections pool can be asked with `pool.forConn()` function:

```ts
MyPool.forConn<T>(callback: (conn: MyConn) => Promise<T>, dsn?: Dsn|string): Promise<T>
```
If `dsn` is not provided, the default DSN of the pool will be used. You can ask connections to different servers.

The requested connection will be available in the provided `callback` function, and when the function returns, this connection will come back to the pool.

Connection state is reset before returning to the pool. This means that incomplete transactions are rolled back, and all kind of locks are cleared.
Then this connection can be idle in the pool for at most `keepAliveTimeout` milliseconds, and if nobody was interested in it during this period, it will be terminated.
If somebody killed a connection while it was idle in the pool, and you asked to use this connection again, the first query on this connection can fail.
If this happens, another connection will be tried, and your query will be reissued. This process is transparent to you.

In the beginning of `callback`, `conn` may be not connected to the server. It will connect on first requested query.

If server is busy ("too many connections", "server shutdown in progress", etc.), the connection will be retried during the period of `connectionTimeout` milliseconds (specified in the DSN parameters).
During this period the connection will be retried each `reconnectInterval` milliseconds.

## Cross-server sessions

If you want to deal with multiple simultaneous connections, you can call `pool.session()` to start a cross-server session.

```ts
MyPool.session<T>(callback: (session: MySession) => Promise<T>): Promise<T>
```
During this session you can call `session.conn()` to get a connection. At the end of callback all the connections will return to the pool, if they didn't before.

```ts
MySession.conn(dsn?: Dsn|string, fresh=false): MyConn
```
`MySession.conn()` returns the connection object (`MyConn`) immediately, but actual connection will be established on first SQL query.

With `true` second argument, always new connection is returned. Otherwise, if there's already an active connection to the same DSN in this session, it will be picked up.

```ts
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/main/README.md' | perl -ne '$y=$1 if /^```(ts\\b)?/;  print $_ if $y&&$m;  $m=$y&&($m||m~^// deno .*?/example2.ts~)' > /tmp/example2.ts
// deno run --allow-env --allow-net /tmp/example2.ts

import {MyPool} from 'https://deno.land/x/office_spirit_mysql@v0.7.1/mod.ts';

const pool = new MyPool(Deno.env.get('DSN') || 'mysql://root@localhost');

pool.session
(	async session =>
	{	const conn1 = session.conn(); // default DSN
		const conn2 = session.conn(); // the same object
		const conn3 = session.conn(undefined, true); // another connection to default DSN
		const conn4 = session.conn('mysql://tests@localhost'); // connection to different DSN

		console.log(conn1 == conn2); // prints true
		console.log(conn2 != conn3); // prints true

		const connId2 = conn2.queryCol("SELECT Connection_id()").first();
		const connId3 = conn3.queryCol("SELECT Connection_id()").first();
		const connId4 = conn4.queryCol("SELECT Connection_id()").first();

		console.log(await Promise.all([connId2, connId3, connId4])); // prints 3 different connection ids
	}
);

await pool.shutdown();
```
At the end of callback all active connections will be returned to the pool. However you can call `conn.end()` to free a connection earlier.

## Making queries

To run a query that doesn't return rows, use `queryVoid()`:

```ts
MyConn.queryVoid(sql: SqlSource, params?: Params): Promise<Resultsets>
```

This method executes it's query and discards returned rows.
Returned `Resultsets` object contains `lastInsertId`, `affectedRows`, and more such information about the query.
If there were multiple resultsets, it will contain only information about the last one.

To run a query, and read it's rows, use one of the following methods:

```ts
MyConn.query(sql: SqlSource, params?: Params): ResultsetsPromise
MyConn.queryMap(sql: SqlSource, params?: Params): ResultsetsPromise
MyConn.queryArr(sql: SqlSource, params?: Params): ResultsetsPromise
MyConn.queryCol(sql: SqlSource, params?: Params): ResultsetsPromise
```

These `query*` methods return `ResultsetsPromise` which is subclass of `Promise<Resultsets>`.
Awaiting it gives you `Resultsets` object.
Iterating over `Resultsets` yields rows.

If your query didn't return rows (query like `INSERT`), then these methods work exactly as `queryVoid()`, so zero rows will be yielded, and `resultsets.columns` will be empty array,
and `resultsets.lastInsertId` and `resultsets.affectedRows` will show relevant information.

If there're rows, you need to iterate them to the end, before you can execute another query.
You can read all the rows with `Resultsets.all()` or `ResultsetsPromise.all()`.

```ts
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/main/README.md' | perl -ne '$y=$1 if /^```(ts\\b)?/;  print $_ if $y&&$m;  $m=$y&&($m||m~^// deno .*?/example3.ts~)' > /tmp/example3.ts
// deno run --allow-env --allow-net /tmp/example3.ts

import {MyPool} from 'https://deno.land/x/office_spirit_mysql@v0.7.1/mod.ts';

const pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');

pool.forConn
(	async conn =>
	{	await conn.queryVoid("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, message text)");
		await conn.queryVoid("INSERT INTO t_log (message) VALUES ('Message 1'), ('Message 2'), ('Message 3')");

		// use ResultsetsPromise.all()
		console.log(await conn.query("SELECT * FROM t_log").all());

		// use Resultsets.all()
		const res = await conn.query("SELECT * FROM t_log");
		console.log(res.columns);
		console.log(await res.all());
	}
);

await pool.shutdown();
```
If your query returns single row, you can read it with `Resultsets.first()` or `ResultsetsPromise.first()`.
It returns the first row itself, not an array of rows.
And it skips all further rows, if they exist.

```ts
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/main/README.md' | perl -ne '$y=$1 if /^```(ts\\b)?/;  print $_ if $y&&$m;  $m=$y&&($m||m~^// deno .*?/example4.ts~)' > /tmp/example4.ts
// deno run --allow-env --allow-net /tmp/example4.ts

import {MyPool} from 'https://deno.land/x/office_spirit_mysql@v0.7.1/mod.ts';

const pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');

pool.forConn
(	async conn =>
	{	await conn.queryVoid("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, message text)");
		await conn.queryVoid("INSERT INTO t_log (message) VALUES ('Message 1'), ('Message 2'), ('Message 3')");

		// use ResultsetsPromise.first()
		console.log(await conn.query("SELECT Count(*) FROM t_log").first());

		// use Resultsets.first()
		const res = await conn.query("SELECT Count(*) FROM t_log");
		console.log(res.columns);
		console.log(await res.first());
	}
);

await pool.shutdown();
```
You can iterate the resultset with `for await` loop, or you can call `ResultsetsPromise.forEach()` or `Resultsets.forEach()` method.

```ts
ResultsetsPromise.forEach<T>(callback: (row: any) => T|Promise<T>): Promise<T|undefined>
```

```ts
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/main/README.md' | perl -ne '$y=$1 if /^```(ts\\b)?/;  print $_ if $y&&$m;  $m=$y&&($m||m~^// deno .*?/example5.ts~)' > /tmp/example5.ts
// deno run --allow-env --allow-net /tmp/example5.ts

import {MyPool} from 'https://deno.land/x/office_spirit_mysql@v0.7.1/mod.ts';

const pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');

pool.forConn
(	async conn =>
	{	await conn.queryVoid("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, message text)");
		await conn.queryVoid("INSERT INTO t_log (message) VALUES ('Message 1'), ('Message 2'), ('Message 3')");

		// for await loop
		for await (const row of await conn.query("SELECT * FROM t_log"))
		{	console.log(row);
		}

		// ResultsetsPromise.forEach()
		await conn.query("SELECT * FROM t_log").forEach
		(	row =>
			{	console.log(row);
			}
		);
	}
);

await pool.shutdown();
```

- `MyConn.query()` method iterates over rows as Javascript default objects with fields.
- `MyConn.queryMap()` method iterates over rows as `Map` objects.
- `MyConn.queryArr()` method iterates over rows as `Array`s with column values without column names.
- `MyConn.queryCol()` method iterates over first column values of each row.

For example, using `queryCol().first()` you can get the result of `SELECT Count(*)` as a single number value:

```ts
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/main/README.md' | perl -ne '$y=$1 if /^```(ts\\b)?/;  print $_ if $y&&$m;  $m=$y&&($m||m~^// deno .*?/example6.ts~)' > /tmp/example6.ts
// deno run --allow-env --allow-net /tmp/example6.ts

import {MyPool} from 'https://deno.land/x/office_spirit_mysql@v0.7.1/mod.ts';

const pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');

pool.forConn
(	async conn =>
	{	await conn.queryVoid("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, message text)");
		await conn.queryVoid("INSERT INTO t_log (message) VALUES ('Message 1'), ('Message 2'), ('Message 3')");

		const count = await conn.queryCol("SELECT Count(*) FROM t_log").first();
		console.log(count); // prints 3
	}
);

await pool.shutdown();
```

Here is the complete definition of query functions:

```ts
MyConn.queryVoid(sql: SqlSource, params?: Params): Promise<Resultsets<void>> {...}
MyConn.query<ColumnType=ColumnValue>(sql: SqlSource, params?: Params): ResultsetsPromise<Record<string, ColumnType>> {...}
MyConn.queryMap<ColumnType=ColumnValue>(sql: SqlSource, params?: Params): ResultsetsPromise<Map<string, ColumnType>> {...}
MyConn.queryArr<ColumnType=ColumnValue>(sql: SqlSource, params?: Params): ResultsetsPromise<ColumnType[]> {...}
MyConn.queryCol<ColumnType=ColumnValue>(sql: SqlSource, params?: Params): ResultsetsPromise<ColumnType> {...}

type SqlSource = string | Uint8Array | Deno.Reader&Deno.Seeker | Deno.Reader&{readonly size: number} | ToSqlBytes;
type Params = any[] | Record<string, any> | null;
class ResultsetsPromise<Row> extends Promise<Resultsets<Row>> {...}
type ColumnValue = bigint | Date | Uint8Array | JsonNode;
type JsonNode = null | boolean | number | string | JsonNode[] | {[member: string]: JsonNode};
```

By default `query*()` functions produce rows where each column is of `ColumnValue` type.

```ts
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/main/README.md' | perl -ne '$y=$1 if /^```(ts\\b)?/;  print $_ if $y&&$m;  $m=$y&&($m||m~^// deno .*?/example7.ts~)' > /tmp/example7.ts
// deno run --allow-env --allow-net /tmp/example7.ts

import {MyPool, ColumnValue} from 'https://deno.land/x/office_spirit_mysql@v0.7.1/mod.ts';

const pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');

pool.forConn
(	async conn =>
	{	await conn.queryVoid("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, message text)");
		await conn.queryVoid("INSERT INTO t_log (message) VALUES ('Message 1'), ('Message 2'), ('Message 3')");

		const row = await conn.query("SELECT * FROM t_log WHERE id=1").first();
		if (row)
		{	// The type of `row` here is `Record<string, ColumnValue>`
			let message = '';
			// Remember that the `message` column can also be null
			if (typeof(row.message) == 'string') // Without this check, the error will be: Type 'ColumnValue' is not assignable to type 'string'
			{	message = row.message;
			}
			console.log(message); // Prints 'Message 1'
		}
	}
);

await pool.shutdown();
```

If you're sure about column types, you can override the column type with `any` (or something else), so each column value will be assumed to have this type.

```ts
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/main/README.md' | perl -ne '$y=$1 if /^```(ts\\b)?/;  print $_ if $y&&$m;  $m=$y&&($m||m~^// deno .*?/example8.ts~)' > /tmp/example8.ts
// deno run --allow-env --allow-net /tmp/example8.ts

import {MyPool} from 'https://deno.land/x/office_spirit_mysql@v0.7.1/mod.ts';

const pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');

pool.forConn
(	async conn =>
	{	await conn.queryVoid("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, message text)");
		await conn.queryVoid("INSERT INTO t_log (message) VALUES ('Message 1'), ('Message 2'), ('Message 3')");

		// Use query<any>()
		const row = await conn.query<any>("SELECT * FROM t_log WHERE id=1").first();
		if (row)
		{	// The type of `row` here is `Record<string, any>`
			const message: string = row.message;
			console.log(message); // Prints 'Message 1'
		}
	}
);

await pool.shutdown();
```

## Type conversions

When rows are read, MySQL values are converted to matching Javascript types.

- `NULL` → `null`
- `bit` → `boolean`
- `integer`, `mediumint`, `smallint`, `tinyint`, `year` → `number`
- `bigint` → either `number` or `bigint`
- `float`, `double` → `number`
- `date`, `datetime`, `timestamp` → `Date`
- `time` → `number` of seconds
- `char`, `varchar`, `tinytext`, `smalltext`, `text`, `mediumtext`, `longtext` → `string`
- `binary`, `varbinary`, `tinyblob`, `smallblob`, `blob`, `mediumblob`, `longblob` → `Uint8Array`
- `json` → is deserialized

Type conversions from Javascript to MySQL happen when you pass parameters to SQL queries.

- `null`, `undefined`, `function`, `symbol` → `NULL`
- `boolean` → `0` or `1`
- `number` → `integer` or `double`
- `bigint` → `bigint`
- `string` → `char`
- `Uint8Array` or other typed array → `binary`
- `Deno.Reader` → `binary`
- `Date` → `datetime`
- others → `char` representing JSON serialized value

## Query parameters

There're 3 options to parametrize queries:
- Positional parameters (not encouraged - see below about binary protocol)
- Named parameters
- Use third-party SQL generators

### Positional parameters

You can use `?`-placeholders in SQL query strings, and supply array of parameters to be substituted in place of them.
This library doesn't parse the provided SQL string, but uses MySQL built-in functionality, so the parameters are substituted on MySQL side.
Placeholders can appear only in places where expressions are allowed.

MySQL supports up to 2**16-1 = 65535 placeholders.

```ts
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/main/README.md' | perl -ne '$y=$1 if /^```(ts\\b)?/;  print $_ if $y&&$m;  $m=$y&&($m||m~^// deno .*?/example9.ts~)' > /tmp/example9.ts
// deno run --allow-env --allow-net /tmp/example9.ts

import {MyPool} from 'https://deno.land/x/office_spirit_mysql@v0.7.1/mod.ts';

const pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');

pool.forConn
(	async conn =>
	{	await conn.queryVoid("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, `time` timestamp, message text)");
		await conn.queryVoid("INSERT INTO t_log SET `time`=Now(), message='Message 1'");

		const row = await conn.query("SELECT `time` + INTERVAL ? DAY AS 'time', message FROM t_log WHERE id=?", [3, 1]).first();
		console.log(row);
	}
);

await pool.shutdown();
```

### Named parameters

For named parameters you can use `@name` placeholders, and this library uses MySQL session variables to send parameters data.
To execute such query, another pre-query is sent to the server, like `SET @days=?, @id=?`.
Parameter names will override session variables with the same names.

```ts
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/main/README.md' | perl -ne '$y=$1 if /^```(ts\\b)?/;  print $_ if $y&&$m;  $m=$y&&($m||m~^// deno .*?/example10.ts~)' > /tmp/example10.ts
// deno run --allow-env --allow-net /tmp/example10.ts

import {MyPool} from 'https://deno.land/x/office_spirit_mysql@v0.7.1/mod.ts';

const pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');

pool.forConn
(	async conn =>
	{	await conn.queryVoid("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, `time` timestamp, message text)");
		await conn.queryVoid("INSERT INTO t_log SET `time`=Now(), message='Message 1'");

		const row = await conn.query("SELECT `time` + INTERVAL @days DAY AS 'time', message FROM t_log WHERE id=@`id`", {days: 3, id: 1}).first();
		console.log(row);
	}
);

await pool.shutdown();
```

### Using external SQL generators

Another option for parameters substitution is to use libraries that generate SQL.

Any library that produces SQL queries is alright if it takes into consideration the very important `conn.noBackslashEscapes` flag.
Remember that the value of this flag can change during server session, if user executes a query like `SET sql_mode='no_backslash_escapes'`.

Query functions (`query*()`) can receive SQL queries in several forms:

```ts
type SqlSource = string | Uint8Array | Deno.Reader&Deno.Seeker | Deno.Reader&{readonly size: number} | ToSqlBytes;
```

As `string`, `Uint8Array`, `Deno.Reader` or `ToSqlBytes`.

Internally strings will be converted to `Uint8Array` anyway, so if your SQL generator can produce `Uint8Array`, it's prefered option.

The most optimal performance will be achieved if using `ToSqlBytes` type.
This type exists especially for external SQL generators, to let them add SQL queries right into the internal buffer.

```ts
interface ToSqlBytes
{	toSqlBytesWithParamsBackslashAndBuffer(putParamsTo: any[]|undefined, noBackslashEscapes: boolean, buffer: Uint8Array): Uint8Array;
}
```

Any external SQL generator can implement this function. This library will call it with 3 parameters:

- `putParamsTo` - If an array is passed, the generator is welcome to convert some parameters to `?`-placeholders, and to put the actual value to this array.
- `noBackslashEscapes` - This library will pass the correct value for this flag, and the generator is kindly asked to respect this value.
- `buffer` - The generator can use this buffer to store the resulting query, in case the buffer is big enough. If the generator decides not to use this buffer, it can allocate it's own buffer, and return it. If it uses the passed in buffer, it must return a subarray of it.

Example:

```ts
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/main/README.md' | perl -ne '$y=$1 if /^```(ts\\b)?/;  print $_ if $y&&$m;  $m=$y&&($m||m~^// deno .*?/example11.ts~)' > /tmp/example11.ts
// deno run --allow-env --allow-net /tmp/example11.ts

import {MyPool} from 'https://deno.land/x/office_spirit_mysql@v0.7.1/mod.ts';

// 1. Define the generator

const encoder = new TextEncoder;

/**	Generates SELECT query for demonstrational purposes only
 **/
class SqlSelectGenerator
{	constructor(private table: string, private idValue: number)
	{
	}

	toSqlBytesWithParamsBackslashAndBuffer(putParamsTo: any[]|undefined, noBackslashEscapes: boolean, buffer: Uint8Array)
	{	let sql;
		if (putParamsTo)
		{	putParamsTo.push(this.idValue);
			sql = `SELECT * FROM ${this.table} WHERE id = ?`;
		}
		else
		{	sql = `SELECT * FROM ${this.table} WHERE id = ${this.idValue}`;
		}
		const {read, written} = encoder.encodeInto(sql, buffer);
		if (read == sql.length)
		{	return buffer.subarray(0, written);
		}
		return encoder.encode(sql);
	}
}

// 2. Use the generator

const pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');

pool.forConn
(	async conn =>
	{	await conn.query("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, `time` timestamp, message text)");
		await conn.query("INSERT INTO t_log SET `time`=Now(), message='message'");

		const rows = await conn.query<any>(new SqlSelectGenerator('t_log', 1), []).all();
		console.log(rows);
	}
);

await pool.shutdown();
```

There're the following external libraries that implement `toSqlBytesWithParamsBackslashAndBuffer()` to optimally support `x/office_spirit_mysql`:

- [x/polysql](https://deno.land/x/polysql) - Earlier this library was part of this project.

If you know about another such libraries, or create one, please let me know, and i'll add them to the list.

## MySQL binary protocol

MySQL and MariaDB support 2 ways to execute queries:
1. **Text Protocol.** SQL where all the parameters are serialized to SQL literals is sent to the server.
Then the server sends back resultsets, where all values are also strings, and must be converted to target types (information about target types is also sent).
2. **Binary Protocol.** SQL query is prepared on the server, and then it's possible to execute this query one or many times, referring to the query by it's ID. The query can contain `?`-placeholders. After query execution the server sends resultset in binary form. Later this prepared query must be deallocated.

The second argument in `conn.query*(sql, params)` functions is called `params`.
When the `params` argument is specified, even if it's an empty array, the Binary Protocol is used.

If the `params` is an empty array, and the first argument (sqlSource) implements `ToSqlBytes` interface, then this empty array will be passed to `sqlSource.toSqlBytesWithParamsBackslashAndBuffer()` as the first argument, so the SQL generator can send parameters to the server through binary protocol by adding values to this array and generating `?` in the SQL string (see above about "Using external SQL generators").

`conn.forQuery*()` functions (detailed below) always use the Binary Protocol.

Not all query types can be run in Binary Protocol - see [here](https://dev.mysql.com/worklog/task/?id=2871) what's supported by MySQL.

Also it turned out that on MySQL 8.0.27 (and possibly other versions) the implementation of the Binary Protocol is rather **slow** in my opinion.
In my tests, preparing a query and then executing it was about 15 times slower than executing the same query in Text Protocol.

However, preparing a query once, and executing it 1000 times was slightly faster than just executing it 1000 times in Text Protocol.

Therefore using Binary Protocol to substitute parameters is probably a bad idea with the current MySQL server implementation.
So using `?`-placeholders in `conn.query*()` is **discouraged**.

For the named parameters this library has 1 optimization that makes them perform decently.
Once you execute a query with, for instance, 5 named parameters: `id`, `name`, `value_a`, `value_b` and `value_c`, this library prepares statement like this:

```sql
SET @par1=?, @par2=?, @par3=?, @par4=?, @par5=?, @par6=?, @par7=?, @par8=?
```
(Actual variable names are different.)

And this statement is kept during the current connection.

Then this statement is executed with the 5 parameters that you provided. And then another query is executed in Text Protocol:

```sql
SET @id=@par1, @par1=NULL, @name=@par2, @par2=NULL, @value_a=@par3, @par3=NULL, @value_b=@par4, @par4=NULL, @value_c=@par5, @par5=NULL
```

And finally your SQL query is executed, also in Text Protocol.

So to execute one query with named parameters, there are actually 3 internal queries (they all are sent to the server in 1 round-trip).

Then each time you execute queries with from 1 to 8 named parameters, that prepared statement is reused.
And for query with 9 to 16 named parameters a statement with 16 variables will be prepared and persisted during the connection.

Let's measure how fast is all that.

```ts
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/main/README.md' | perl -ne '$y=$1 if /^```(ts\\b)?/;  print $_ if $y&&$m;  $m=$y&&($m||m~^// deno .*?/example12.ts~)' > /tmp/example12.ts
// deno run --allow-env --allow-net /tmp/example12.ts

import {MyPool} from 'https://deno.land/x/office_spirit_mysql@v0.7.1/mod.ts';

const pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');

const N_ROWS = 100;
const N_QUERIES = 800;

try
{	pool.forConn
	(	async conn =>
		{	// CREATE DATABASE
			await conn.query("DROP DATABASE IF EXISTS test1");
			await conn.query("CREATE DATABASE `test1`");

			// USE
			await conn.query("USE test1");

			// CREATE TABLE
			await conn.query("CREATE TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, val integer)");

			// INSERT
			let sql = "INSERT INTO t_log (val) VALUES (0)";
			for (let i=1; i<N_ROWS; i++)
			{	sql += `,(${i})`;
			}
			await conn.queryVoid(sql);

			// Begin tests
			console.log('Begin tests');

			// Text Protocol
			let since = Date.now();
			let sum = 0;
			for (let i=0; i<N_QUERIES; i++)
			{	const n = 1 + Math.floor(Math.random() * N_ROWS);
				sum += await conn.queryCol("SELECT val FROM t_log WHERE id = "+n).first();
			}
			console.log(`Text Protocol took ${(Date.now()-since) / 1000} sec (random=${sum})`);

			// Named params
			since = Date.now();
			sum = 0;
			for (let i=0; i<N_QUERIES; i++)
			{	const n = 1 + Math.floor(Math.random() * N_ROWS);
				sum += await conn.queryCol("SELECT val FROM t_log WHERE id = @n", {n}).first();
			}
			console.log(`Named params took ${(Date.now()-since) / 1000} sec (random=${sum})`);

			// Positional params
			since = Date.now();
			sum = 0;
			for (let i=0; i<N_QUERIES; i++)
			{	const n = 1 + Math.floor(Math.random() * N_ROWS);
				sum += await conn.queryCol("SELECT val FROM t_log WHERE id = ?", [n]).first();
			}
			console.log(`Positional params took ${(Date.now()-since) / 1000} sec (random=${sum})`);

			// Positional params prepared once
			since = Date.now();
			sum = 0;
			await conn.forQueryCol
			(	"SELECT val FROM t_log WHERE id = ?",
				async stmt =>
				{	for (let i=0; i<N_QUERIES; i++)
					{	const n = 1 + Math.floor(Math.random() * N_ROWS);
						sum += Number(await stmt.exec([n]).first());
					}
				}
			);
			console.log(`Positional params prepared once took ${(Date.now()-since) / 1000} sec (random=${sum})`);

			// Drop database that i created
			await conn.query("DROP DATABASE test1");
		}
	);
}
finally
{	await pool.shutdown();
}
```

On my computer i see the following results:

```
Begin tests
Text Protocol took 0.289 sec (random=39948)
Named params took 0.377 sec (random=39635)
Positional params took 4.278 sec (random=39841)
Positional params prepared once took 0.18 sec (random=38356)
```

## Prepared statements

Function `conn.forQuery()` prepares an SQL statement, that you can execute multiple times, each time with different parameters.

```ts
forQuery<T>(sql: SqlSource, callback: (prepared: Resultsets) => Promise<T>): Promise<T>
```

```ts
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/main/README.md' | perl -ne '$y=$1 if /^```(ts\\b)?/;  print $_ if $y&&$m;  $m=$y&&($m||m~^// deno .*?/example13.ts~)' > /tmp/example13.ts
// deno run --allow-env --allow-net /tmp/example13.ts

import {MyPool} from 'https://deno.land/x/office_spirit_mysql@v0.7.1/mod.ts';

const pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');

pool.forConn
(	async conn =>
	{	// CREATE TABLE
		await conn.query("CREATE TEMPORARY TABLE t_messages (id integer PRIMARY KEY AUTO_INCREMENT, message text)");

		// INSERT
		await conn.forQuery
		(	"INSERT INTO t_messages SET message=?",
			async prepared =>
			{	for (let i=1; i<=3; i++)
				{	await prepared.exec(['Message '+i]);
				}
			}
		);

		// SELECT
		console.log(await conn.query("SELECT * FROM t_messages").all());
	}
);

await pool.shutdown();
```

There's family of functions:

```ts
MyConn.forQueryVoid<T>(sql: SqlSource, callback: (prepared: Resultsets<void>) => Promise<T>): Promise<T>
MyConn.forQuery<ColumnType=ColumnValue, T=unknown>(sql: SqlSource, callback: (prepared: Resultsets<Record<string, ColumnType>>) => Promise<T>): Promise<T>
MyConn.forQueryMap<ColumnType=ColumnValue, T=unknown>(sql: SqlSource, callback: (prepared: Resultsets<Map<string, ColumnType>>) => Promise<T>): Promise<T>
MyConn.forQueryArr<ColumnType=ColumnValue, T=unknown>(sql: SqlSource, callback: (prepared: Resultsets<ColumnType[]>) => Promise<T>): Promise<T>
MyConn.forQueryCol<ColumnType=ColumnValue, T=unknown>(sql: SqlSource, callback: (prepared: Resultsets<ColumnType>) => Promise<T>): Promise<T>
```

The difference between them is result type that `Resultsets.exec()` returns.

```ts
Resultsets<Row>.exec(params: any[]): ResultsetsPromise<Row>
```

## Reading long BLOBs

This library tries to have everything needed in real life usage. It's possible to read long data without storing it in memory.

```ts
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/main/README.md' | perl -ne '$y=$1 if /^```(ts\\b)?/;  print $_ if $y&&$m;  $m=$y&&($m||m~^// deno .*?/example14.ts~)' > /tmp/example14.ts
// deno run --allow-env --allow-net /tmp/example14.ts

import {MyPool} from 'https://deno.land/x/office_spirit_mysql@v0.7.1/mod.ts';
import {copy} from 'https://deno.land/std@0.117.0/streams/conversion.ts';

const pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');

pool.forConn
(	async conn =>
	{	await conn.query("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, `time` timestamp, message text)");
		await conn.query("INSERT INTO t_log SET `time`=Now(), message='long long message'");

		const row = await conn.makeLastColumnReader<any>("SELECT `time`, message FROM t_log WHERE id=1");
		await copy(row!.message, Deno.stdout);
	}
);

await pool.shutdown();
```

## Writing long BLOBS

Query parameter values can be of various types, including `Deno.Reader`. If some parameter is `Deno.Reader`, the parameter value will be read from this reader (without storing the whole BLOB in memory).

```ts
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/main/README.md' | perl -ne '$y=$1 if /^```(ts\\b)?/;  print $_ if $y&&$m;  $m=$y&&($m||m~^// deno .*?/example15.ts~)' > /tmp/example15.ts
// deno run --allow-env --allow-net /tmp/example15.ts

import {MyPool} from 'https://deno.land/x/office_spirit_mysql@v0.7.1/mod.ts';
import {copy} from 'https://deno.land/std@0.117.0/streams/conversion.ts';

const pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');

pool.forConn
(	async conn =>
	{	await conn.queryVoid("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, `time` timestamp, message text)");

		const file = await Deno.open('/etc/passwd', {read: true});
		try
		{	// Write the file to db
			await conn.queryVoid("INSERT INTO t_log SET `time`=Now(), message=?", [file]);
		}
		finally
		{	file.close();
		}

		// Read the contents back from db
		const row = await conn.makeLastColumnReader<any>("SELECT `time`, message FROM t_log WHERE id=1");
		await copy(row!.message, Deno.stdout);
	}
);

await pool.shutdown();
```

## Importing big dumps

Functions like `MyConn.query*()` allow to provide SQL query in several forms, including `Deno.Reader`.

```ts
MyConn.query(sql: SqlSource, params?: object|null): ResultsetsPromise;

type SqlSource = string | Uint8Array | Deno.Reader&Deno.Seeker | Deno.Reader&{readonly size: number} | ToSqlBytes;
```
This allows to read SQL from files.

```ts
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests?multiStatements'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/main/README.md' | perl -ne '$y=$1 if /^```(ts\\b)?/;  print $_ if $y&&$m;  $m=$y&&($m||m~^// deno .*?/example16.ts~)' > /tmp/example16.ts
// deno run --allow-env --allow-net /tmp/example16.ts

import {MyPool} from 'https://deno.land/x/office_spirit_mysql@v0.7.1/mod.ts';

// Don't forget `?multiStatements`
const pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests?multiStatements');

pool.forConn
(	async conn =>
	{	const filename = await Deno.makeTempFile();
		try
		{	await Deno.writeTextFile
			(	filename,
				`	CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, c_time timestamp, message text);

					INSERT INTO t_log SET c_time=Now(), message='long long message';
				`
			);

			const file = await Deno.open(filename, {read: true});
			try
			{	await conn.queryVoid(file);
			}
			finally
			{	file.close();
			}

			console.log(await conn.query("SELECT c_time, message FROM t_log").all());
		}
		finally
		{	await Deno.remove(filename);
		}
	}
);

await pool.shutdown();
```

## LOAD DATA LOCAL INFILE

If this feature is enabled on your server, you can register a custom handler that will take `LOAD DATA LOCAL INFILE` requests.

```ts
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/main/README.md' | perl -ne '$y=$1 if /^```(ts\\b)?/;  print $_ if $y&&$m;  $m=$y&&($m||m~^// deno .*?/example17.ts~)' > /tmp/example17.ts
// deno run --allow-env --allow-net /tmp/example17.ts

import {MyPool, sql} from 'https://deno.land/x/office_spirit_mysql@v0.7.1/mod.ts';
import {dirname} from "https://deno.land/std@0.117.0/path/mod.ts";

const pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');

// Set handler for LOAD DATA LOCAL INFILE queries
const ALLOWED_DIRS = ['/tmp'];
pool.options
(	{	onLoadFile(filename: string)
		{	if (ALLOWED_DIRS.includes(dirname(filename)))
			{	return Deno.open(filename, {read: true});
			}
			else
			{	return Promise.resolve(undefined);
			}
		}
	}
);

// Download some public example CSV file from github
const data = await fetch('https://raw.githubusercontent.com/lukes/ISO-3166-Countries-with-Regional-Codes/master/all/all.csv');
const filename = await Deno.makeTempFile();
await Deno.writeTextFile(filename, await data.text());

// Create temporary table, load the data to it, and then select it back
pool.forConn
(	async conn =>
	{	// CREATE TABLE
		await conn.queryVoid
		(	`	CREATE TEMPORARY TABLE t_countries
				(	country_code char(2) CHARACTER SET latin1 NOT NULL PRIMARY KEY,
					country_name varchar(128) NOT NULL
				)
			`
		);

		// SQL-quote filename, because `LOAD DATA LOCAL INFILE` doesn't accept parameters
		const filenameSql = await conn.queryCol("SELECT Quote(?)", [filename]).first();

		// LOAD DATA
		const res = await conn.queryVoid
		(	`	LOAD DATA LOCAL INFILE ${filenameSql}
				INTO TABLE t_countries
				FIELDS TERMINATED BY ','
				ENCLOSED BY '"'
				IGNORE 1 LINES
				(@name, @code)
				SET
					country_code = @code,
					country_name = @name
			`
		);
		console.log(res.statusInfo);

		// SELECT
		console.log(await conn.query("SELECT * FROM t_countries LIMIT 3").all());
	}
);

await pool.shutdown();
```

## Connection status

`MyConn` object has several status variables:

- `conn.serverVersion: string` - remote server version, as it reports (for example my server reports "8.0.25-0ubuntu0.21.04.1").
- `conn.connectionId: number` - thread ID of the connection, that `SHOW PROCESSLIST` shows.
- `conn.autocommit: boolean` - true if the connection is currently in autocommit mode. Queries like `SET autocommit=0` will affect this flag.
- `conn.inTrx: boolean` - true if a transaction was started. Queries like `START TRANSACTION` and `ROLLBACK` will affect this flag.
- `conn.inTrxReadonly: boolean` - true if a readonly transaction was started. Queries like `START TRANSACTION READ ONLY` and `ROLLBACK` will affect this flag.
- `conn.noBackslashEscapes: boolean` - true, if the server is configured not to use backslash escapes in string literals. Queries like `SET sql_mode='NO_BACKSLASH_ESCAPES'` will affect this flag.
- `conn.schema: string` - if your server version supports change schema notifications, this will be current default schema (database) name. Queries like `USE new_schema` will affect this value. With old servers this will always remain empty string.

Initially these variables can be empty. They are set after actual connection to the server, that happens after issuing the first query. Or you can call `await conn.connect()`.

## Resultsets

`conn.query*()` methods all return `Resultsets` object, that contains information about your query result.
Also this object allows to iterate over rows that the query returned.

If your query returned multiple resultsets, `conn.queryVoid()` skips them, and returns only the status of the last one.

`conn.query*()` functions except `conn.queryVoid()` don't skip resultsets, and `await resultsets.nextResultset()` will advance to the next result, and return true.
If there are no more resultsets, `await resultsets.nextResultset()` returns false.
And you must read or discard all the resultsets before being able to issue next queries.

```ts
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests?multiStatements'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/main/README.md' | perl -ne '$y=$1 if /^```(ts\\b)?/;  print $_ if $y&&$m;  $m=$y&&($m||m~^// deno .*?/example18.ts~)' > /tmp/example18.ts
// deno run --allow-env --allow-net /tmp/example18.ts

import {MyPool} from 'https://deno.land/x/office_spirit_mysql@v0.7.1/mod.ts';

// Don't forget `?multiStatements`
const pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests?multiStatements');

pool.forConn
(	async conn =>
	{	const resultsets = await conn.query
		(	`	CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, message text);

				INSERT INTO t_log (message) VALUES ('Message 1'), ('Message 2'), ('Message 3');

				SELECT * FROM t_log;
			`
		);

		console.log(resultsets.affectedRows); // prints 0

		await resultsets.nextResultset();
		console.log(resultsets.affectedRows); // prints 3

		await resultsets.nextResultset();
		console.log(resultsets.columns.length); // prints 2

		for await (const row of resultsets)
		{	console.log(row);
		}
	}
);

await pool.shutdown();
```

`Resultsets` object has the following properties and methods:

- `Resultsets.lastInsertId: number|bigint` - In INSERT queries this is last generated AUTO_INCREMENT ID
- `Resultsets.affectedRows: number|bigint` - In modifying queries, like INSERT, UPDATE and DELETE this shows how many rows were affected by the query
- `Resultsets.foundRows: number|bigint` - If "foundRows" connection attribute is set, will ask the server to report about "found rows" (matched by the WHERE clause), instead of affected, and "affectedRows" will not be used. See [this page](https://dev.mysql.com/doc/c-api/5.7/en/mysql-affected-rows.html) for more information.
- `Resultsets.warnings: number` - Number of warnings produced by the last query. To see the warning messages you can use `SHOW WARNINGS` query.
- `Resultsets.statusInfo: string` - Human-readable information about last query result, if sent by server.
- `Resultsets.noGoodIndexUsed: boolean` - Server can report about nonoptimal queries.
- `Resultsets.noIndexUsed: boolean`
- `Resultsets.isSlowQuery: boolean`
- `Resultsets.columns: Column[]` - Information about columns in resultset.
- `Resultsets.nPlaceholders: number` - Number of `?`-placeholders in the SQL query.
- `Resultsets.hasMore: boolean` - True if there are more rows or resultsets to read.
- `Resultsets.exec(params: any[]): Promise<void>` - If this is a prepared query, this function executes it again.
- `Resultsets.all(): Promise<any[]>` - Reads all rows in current resultset to an array.
- `Resultsets.first(): Promise<any>` - Reads all rows in current resultset, and returns the first row.
- `Resultsets.forEach<T>(callback: (row: any) => T | Promise<T>): Promise<T | undefined>` - Reads all rows, and calls the provided callback for each of them.
- `Resultsets.nextResultset(): Promise<boolean>` - Advances to the next resultset of this query, if there is one. Returns true if moved to the next resultset.
- `Resultsets.discard(): Promise<void>` - Reads and discards all the rows in all the resultsets of this query.

## SQL logging

You can use different API functions to execute queries (`conn.query*()`, `conn.forQuery*()`, etc.), and some queries are generated internally.
Also query SQL can be provided in various forms. Not only as string, but even `Deno.Reader` is possible.
To understand what's going on in your transaction, it's convenient to have a callback function, that catches all the queries.

This library allows you to enable SQL logging in specific connection, or session:

```ts
function MyConn.setSqlLogger(sqlLogger?: SqlLogger|true): void;
function MySession.setSqlLogger(sqlLogger?: SqlLogger|true): void;
```
By default no SQL is logged. If you set `sqlLogger` to `true`, a default logger will be used, that logs to `Deno.stderr`.

```ts
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/main/README.md' | perl -ne '$y=$1 if /^```(ts\\b)?/;  print $_ if $y&&$m;  $m=$y&&($m||m~^// deno .*?/example19.ts~)' > /tmp/example19.ts
// deno run --allow-env --allow-net /tmp/example19.ts

import {MyPool} from 'https://deno.land/x/office_spirit_mysql@v0.7.1/mod.ts';

const pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');

let result;

try
{	pool.forConn
	(	async conn =>
		{	// Enable SQL logger
			conn.setSqlLogger(true);

			// CREATE DATABASE
			await conn.query("DROP DATABASE IF EXISTS test1");
			await conn.query("CREATE DATABASE `test1`");

			// USE
			await conn.query("USE test1");

			// CREATE TABLE
			await conn.query("CREATE TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, message text)");

			// INSERT
			await conn.query("INSERT INTO t_log SET message = 'Message 1'");

			result = await conn.queryCol("SELECT message FROM t_log WHERE id = @n", {n: 1}).first();

			// Drop database that i created
			await conn.query("DROP DATABASE test1");
		}
	);
}
finally
{	await pool.shutdown();
}

console.log(`Result: ${result}`);
```

![image](./readme-assets/sql-logger-1.png)

The default logger truncates long queries to maximum 10,000 bytes, and long query parameters to 3,000 bytes.

This library allows you to provide your own custom logger.
This can be any object that implements `SqlLogger` interface:

```ts
interface SqlLogger
{	/**	A new connection established.
	 **/
	connect?: (dsn: Dsn, connectionId: number) => Promise<unknown>;

	/**	Connection state reset (before returning this connection to it's pool).
	 **/
	resetConnection?: (dsn: Dsn, connectionId: number) => Promise<unknown>;

	/**	Disconnected.
	 **/
	disconnect?: (dsn: Dsn, connectionId: number) => Promise<unknown>;

	/**	Started to send a new query to the server.
		`isPrepare` means that this is query preparation operation, and following `queryEnd()` will receive `stmtId` that server returned.
		`previousResultNotRead` means that i'm sending queries batch without reading results. `queryEnd()` of previous query will be called later, but before the `queryEnd()` of this query.
		In other words, i can call the sequence of `queryNew()`, `querySql()`, `queryStart()` several times, and then call `queryEnd()` corresponding number of times.
	 **/
	queryNew?: (dsn: Dsn, connectionId: number, isPrepare: boolean, previousResultNotRead: boolean) => Promise<unknown>;

	/**	After `queryNew()` called, i can call `querySql()` one or several times (in case of error even 0 times).
		Each call to `querySql()` appends more bytes to current SQL query.
		`data` is SQL query serialized to bytes (you can use `TextDecoder` to restore the original SQL string).
		The query SQL always comes as bytes, no matter what you passed to `conn.query()` function (bytes, string, `Deno.Reader`, etc).
		Since `data` is a pointer to internal buffer (that is changing all the time), you need to use the `data` immediately (without await), or to copy it to another variable.
	 **/
	querySql?: (dsn: Dsn, connectionId: number, data: Uint8Array, noBackslashEscapes: boolean) => Promise<unknown>;

	/**	After `queryNew()` and one or more `querySql()` called, i call `queryStart()`.
		At this point the query is sent to the server.
	 **/
	queryStart?: (dsn: Dsn, connectionId: number) => Promise<unknown>;

	/**	Query completed (it's result status is read from the server, but rows, if any, are not yet read).
		The query can either complete with success or with error.
		If this was query preparation, the `stmtId` will be the numeric ID of this prepared statement.
	 **/
	queryEnd?: (dsn: Dsn, connectionId: number, result: Resultsets<unknown>|Error, stmtId?: number) => Promise<unknown>;

	/**	Started executing a prepared statement.
	 **/
	execNew?: (dsn: Dsn, connectionId: number, stmtId: number) => Promise<unknown>;

	/**	After `execNew()` called, i can call `execParam()` zero or more times to bind parameter values.
		I can call `execParam()` for the same parameter several times - each time appends data to the parameter.
		If i don't call `execParam()` for some parameter, this means that it's value is NULL.
		Strings and `Deno.Reader`s always come as `Uint8Array`.
		Since `data` is a pointer to internal buffer (that is changing all the time), you need to use the `data` immediately (without await), or to copy it to another variable.
	 **/
	execParam?: (dsn: Dsn, connectionId: number, nParam: number, data: Uint8Array|number|bigint|Date) => Promise<unknown>;

	/**	After `execNew()` and zero or more `execParam()` called, i call `execStart()`.
		At this point the query parameters are sent to the server.
	 **/
	execStart?: (dsn: Dsn, connectionId: number) => Promise<unknown>;

	/**	Query completed (it's result status is read from the server, but rows, if any, are not yet read).
		The query can either complete with success or with error.
		`result` can be undefined for internal queries.
	 **/
	execEnd?: (dsn: Dsn, connectionId: number, result: Resultsets<unknown>|Error|undefined) => Promise<unknown>;

	/**	Prepared query deallocated (unprepared).
	 **/
	deallocatePrepare?: (dsn: Dsn, connectionId: number, stmtId: number) => Promise<unknown>;

	/**	I'll call this function at the end of `MyPool.forConn()` or `MyPool.session()`.
	 **/
	dispose?: () => Promise<unknown>;
}
```
This library provides a base class called `SqlLogToWriter` that you can use to implement a logger that logs to any `Deno.Writer`.

The default logger (that is used if you specify `sqlLogger == true`) is also implemented through `SqlLogToWriter`:

```ts
conn.setSqlLogger(true);

// Is the same as:

conn.setSqlLogger(new SqlLogToWriter(Deno.stderr, !Deno.noColor, 10_000, 3_000));
```

Here is how to subclass `SqlLogToWriter` to log to a file:

```ts
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/main/README.md' | perl -ne '$y=$1 if /^```(ts\\b)?/;  print $_ if $y&&$m;  $m=$y&&($m||m~^// deno .*?/example20.ts~)' > /tmp/example20.ts
// deno run --allow-env --allow-net --allow-write /tmp/example20.ts

import {MyPool, SqlLogToWriter} from 'https://deno.land/x/office_spirit_mysql@v0.7.1/mod.ts';

const pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');

const LOG_FILE = '/tmp/sql.log';

class SqlLogToFile extends SqlLogToWriter
{	protected closer: Deno.Closer;

	private constructor(writer: Deno.Writer&Deno.Closer, withColor=false)
	{	super(writer, withColor);
		this.closer = writer;
	}

	static async inst(path: string|URL, withColor=false)
	{	const fd = await Deno.open(path, {write: true, create: true, truncate: true});
		return new SqlLogToFile(fd, withColor);
	}

	async dispose()
	{	await super.dispose();
		this.closer.close();
	}
}

let result;

try
{	pool.forConn
	(	async conn =>
		{	// Enable SQL logger
			conn.setSqlLogger(await SqlLogToFile.inst(LOG_FILE, !Deno.noColor));

			// CREATE DATABASE
			await conn.query("DROP DATABASE IF EXISTS test1");
			await conn.query("CREATE DATABASE `test1`");

			// USE
			await conn.query("USE test1");

			// CREATE TABLE
			await conn.query("CREATE TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, message text)");

			// INSERT
			await conn.query("INSERT INTO t_log SET message = 'Message 1'");

			result = await conn.queryCol("SELECT message FROM t_log WHERE id = @n", {n: 1}).first();

			// Drop database that i created
			await conn.query("DROP DATABASE test1");
		}
	);
}
finally
{	await pool.shutdown();
}

console.log(`Result: ${result}`);
```

To view the color-highlighted file we can do:

```ts
less -r /tmp/sql.log
```

You can see [here](https://github.com/jeremiah-shaulov/office_spirit_mysql/blob/main/private/sql_log_to_writer.ts) how `SqlLogToWriter` class is implemented,
and you can override it's public and protected methods to customize it's behavior.

## Transactions

`MyConn` class has the following functions to work with transactions:

```ts
/**	Commit current transaction (if any), and start new.
	This is lazy operation. The corresponding command will be sent to the server later (however commit of the current transaction will happen immediately).
	To start regular transaction, call `startTrx()` without parameters.
	To start READONLY transaction, pass `{readonly: true}`.
	To start distributed transaction, pass `{xaId: '...'}`.
	If you want `conn.connectionId` to be automatically appended to XA identifier, pass `{xaId1: '...'}`, where `xaId1` is the first part of the `xaId`.
	If connection to server was not yet established, the `conn.connectionId` is not known (and `startTrx()` will not connect), so `conn.connectionId` will be appended later on first query.
 **/
function MyConn.startTrx(options?: {readonly?: boolean, xaId?: string, xaId1?: string}): Promise<void>;

/**	Creates transaction savepoint, and returns ID number of this new savepoint.
	Then you can call `conn.rollback(pointId)`.
	This is lazy operation. The corresponding command will be sent to the server later.
	Calling `savepoint()` immediately followed by `rollback(pointId)` to this point will send no commands.
 **/
function MyConn.savepoint(): number;

/**	If the current transaction is of distributed type, this function prepares the 2-phase commit.
	Else does nothing.
	If this function succeeds, the transaction will be saved on the server till you call `commit()`.
	The saved transaction can survive server restart and unexpected halt.
	You need to commit it as soon as possible, to release all the locks that it holds.
	Usually, you want to prepare transactions on all servers, and immediately commit them if `prepareCommit()` succeeded, or rollback them if it failed.
 **/
function MyConn.prepareCommit(): Promise<void>;

/**	Rollback to a savepoint, or all.
	If `toPointId` is not given or undefined - rolls back the whole transaction (XA transactions can be rolled back before `prepareCommit()` called, or after that).
	If `toPointId` is a number returned from `savepoint()` call, rolls back to that point (also works with XAs).
	If `toPointId` is `0`, rolls back to the beginning of transaction, and doesn't end this transaction (doesn't work with XAs).
	If rollback (not to savepoint) failed, will disconnect from server and throw ServerDisconnectedError.
	If `toPointId` was `0` (not for XAs), the transaction will be restarted after the disconnect if rollback failed.
 **/
function MyConn.rollback(toPointId?: number): Promise<void>;

/**	Commit.
	If the current transaction is XA, and you didn't call `prepareCommit()` i'll throw error.
	With `andChain` parameter will commit and then restart the same transaction (doesn't work with XAs).
	If commit fails will rollback and throw error. If rollback also fails, will disconnect from server and throw ServerDisconnectedError.
 **/
function MyConn.commit(andChain=false): Promise<void>;
```

To start a regular transaction call `startTrx()` without parameters. Then you can create savepoints, rollback to a savepoint, or rollback the whole transaction, or commit.

```ts
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/main/README.md' | perl -ne '$y=$1 if /^```(ts\\b)?/;  print $_ if $y&&$m;  $m=$y&&($m||m~^// deno .*?/example21.ts~)' > /tmp/example21.ts
// deno run --allow-env --allow-net /tmp/example21.ts

import {MyPool} from 'https://deno.land/x/office_spirit_mysql@v0.7.1/mod.ts';

const pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');

await pool.forConn
(	async conn =>
	{	// CREATE DATABASE
		await conn.query("DROP DATABASE IF EXISTS test1");
		await conn.query("CREATE DATABASE `test1`");

		// USE
		await conn.query("USE test1");

		// CREATE TABLE
		await conn.query("CREATE TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, a int)");

		// Start transaction
		await conn.startTrx();

		// Insert a row
		await conn.query("INSERT INTO t_log SET a = 123");

		// Ensure that the row is present
		console.log(await conn.queryCol("SELECT a FROM t_log WHERE id=1").first()); // prints: 123

		// Rollback
		await conn.rollback();

		// The inserted row not persisted
		console.log(await conn.queryCol("SELECT Count(*) FROM t_log").first()); // prints: 0

		// Drop database that i created
		await conn.query("DROP DATABASE test1");
	}
);

await pool.shutdown();
```

It's also possible to start a READONLY transaction:

```ts
await conn.startTrx({readonly: true});
```

Or a distributed transaction:

```ts
await conn.startTrx({xaId: Math.random()+''});
// OR
await conn.startTrx({xaId1: Math.random()+'-'});
```

If you specify `xaId1`, the XA ID will consist of 2 parts: the string you provided (`xaId1`) and `conn.connectionId` (the latter may be not known at this point if there's no connection to the server yet, so it will be appended later).

Transaction-related functions are also present in `MySession` object.
If you start a stransaction on the session level, all the connections in this session will have this transaction, and when you ask new connections, the current transaction with all the savepoints will be started there automatically.

```ts
/**	Commit current transaction (if any), and start new.
	If there're active transactions, they will be properly (2-phase if needed) committed.
	Then new transaction will be started on all connections in this session.
	If then you'll ask a new connection, it will join the transaction.
	If commit fails, this function does rollback, and throws the Error.
 **/
function MySession.startTrx(options?: {readonly?: boolean, xa?: boolean}): Promise<void>;

/**	Create session-level savepoint, and return it's ID number.
	Then you can call `session.rollback(pointId)`.
	This is lazy operation. The corresponding command will be sent to the server later.
	Calling `savepoint()` immediately followed by `rollback(pointId)` to this point will send no commands.
	Using `MySession.savepoint()` doesn't interfere with `MyConn.savepoint()`, so it's possible to use both.
 **/
function MySession.savepoint(): number;

/**	Rollback all the active transactions in this session.
	If `toPointId` is not given or undefined - rolls back the whole transaction.
	If `toPointId` is a number returned from `savepoint()` call, rolls back all the transactions to that point.
	If `toPointId` is `0`, rolls back to the beginning of transaction, and doesn't end this transaction (also works with XAs).
	If rollback (not to savepoint) failed, will disconnect from server and throw ServerDisconnectedError.
	If `toPointId` was `0`, the transaction will be restarted after the disconnect if rollback failed.
 **/
function MySession.rollback(toPointId?: number): Promise<void>;

/**	Commit all the active transactions in this session.
	If the session transaction was started with `{xa: true}`, will do 2-phase commit.
	If failed will rollback. If failed and `andChain` was true, will rollback and restart the same transaction (also XA).
	If rollback failed, will disconnect (and restart the transaction in case of `andChain`).
 **/
function MySession.commit(andChain=false): Promise<void>;
```

## Distributed (aka global) transactions

Distributed transactions feature offers atomic operations across several servers.

We can start transactions on multiple servers.
Then we'll want to avoid the situation when some of them succeeded to commit, and some failed.
Distributed transactions have special PREPARE COMMIT operation. If this operation succeeds, it's likely that COMMIT will then succeed as well.
So the strategy is to PREPARE COMMIT on all servers, and then to COMMIT in case of success, or to ROLLBACK if PREPARE COMMIT failed on one of the servers.

PREPARE COMMIT saves the transaction on the server permanently till COMMIT or ROLLBACK.
Such saved transaction can survive server restart or unexpected halt.
Transactions lock all table rows that they touched, so it's important to COMMIT or ROLLBACK them as soon as possible.
If your application prepared some commit, and stumbled on an exception, or somebody terminated the application, or restarted the server on which it ran,
such transaction becomes dangling. Dangling transactions can block database server and cause application failure.

[Read more about distributed transactions](https://dev.mysql.com/doc/refman/8.0/en/xa.html).

Some kind of transactions manager is needed when working with distributed transactions.

This library provides transactions manager that you can use, or you can use your own one.

When calling `MyConn.startTrx()` on a connection, this creates non-managed transaction. To use the distributed transactions manager, you need to:

- create session (`pool.session()`), and call `MySession.startTrx({xa: true})` on session object
- specify `managedXaDsns` in pool options
- optionally specify `xaInfoTables` in pool options, and create in your database tables dedicated to the transactions manager

Let's consider the following situation.
We have 2 databases on 2 servers. But in dev environment and in this example they both will reside on the same server.
In both databases we have table called `t_log`, and we want to replicate inserts to this table.
We will also have 4 tables dedicated to the transactions manager: `test1.t_xa_info_1`, `test1.t_xa_info_2`, `test2.t_xa_info_1`, `test2.t_xa_info_2`.

MySQL user for the application will be called `app`, and the manager user will be `manager`, and it will have permission to execute `XA RECOVER` as well as permission to work with info tables.

```sql
CREATE DATABASE test1;
CREATE DATABASE test2;

CREATE TABLE test1.t_log (id integer PRIMARY KEY AUTO_INCREMENT, message text);
CREATE TABLE test2.t_log (id integer PRIMARY KEY AUTO_INCREMENT, message text);

-- XA Info tables
CREATE TABLE test1.t_xa_info_1 (xa_id char(40) PRIMARY KEY);
CREATE TABLE test1.t_xa_info_2 (xa_id char(40) PRIMARY KEY);
CREATE TABLE test2.t_xa_info_1 (xa_id char(40) PRIMARY KEY);
CREATE TABLE test2.t_xa_info_2 (xa_id char(40) PRIMARY KEY);

-- CREATE USER app
CREATE USER app@localhost IDENTIFIED BY 'app';
GRANT ALL ON test1.* TO app@localhost;
GRANT ALL ON test2.* TO app@localhost;

-- CREATE USER manager
CREATE USER manager@localhost IDENTIFIED BY 'manager';
GRANT ALL ON test1.* TO manager@localhost;
GRANT ALL ON test2.* TO manager@localhost;
GRANT XA_RECOVER_ADMIN ON *.* TO manager@localhost;
```

Transactions manager tables are not required, but they will improve the management quality.
There can be any number of such tables, and they can reside on one of the hosts where you issue queries (`test1`), or on several or all of them (`test1`, `test2`), or even on different host(s).
For each transaction the manager will pick one random info table.
Having multiple info tables distributes (balances) load between them.
Single table under heavy load can be bottleneck.

Transactions manager tables must have one column called `xa_id`, as defined above.
If you wish you can add a timestamp column for your own use (transactions manager will ignore it).

```ts
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/main/README.md' | perl -ne '$y=$1 if /^```(ts\\b)?/;  print $_ if $y&&$m;  $m=$y&&($m||m~^// deno .*?/example22.ts~)' > /tmp/example22.ts
// deno run --allow-env --allow-net /tmp/example22.ts

import {MyPool, Dsn} from 'https://deno.land/x/office_spirit_mysql@v0.7.1/mod.ts';

const dsn1 = new Dsn('mysql://app:app@localhost/test1');
const dsn2 = new Dsn('mysql://app:app@localhost/test2');

const pool = new MyPool
(	{	managedXaDsns:
		[	'mysql://manager:manager@localhost/test1',
			'mysql://manager:manager@localhost/test2',
		],
		xaInfoTables:
		[	{dsn: 'mysql://manager:manager@localhost/test1', table: 't_xa_info_1'},
			{dsn: 'mysql://manager:manager@localhost/test1', table: 't_xa_info_2'},
			{dsn: 'mysql://manager:manager@localhost/test2', table: 't_xa_info_1'},
			{dsn: 'mysql://manager:manager@localhost/test2', table: 't_xa_info_2'},
		]
	}
);

try
{	await pool.session
	(	async session =>
		{	// Enable SQL logger
			session.setSqlLogger(true);

			// Start distributed transaction
			await session.startTrx({xa: true});

			// Get connection objects (actual connection will be established on first query)
			const conn1 = session.conn(dsn1);
			const conn2 = session.conn(dsn2);

			// Query
			await conn1.query("INSERT INTO t_log SET message = 'Msg 1'");
			await conn2.query("INSERT INTO t_log SET message = 'Msg 1'");

			// 2-phase commit
			await session.commit();
		}
	);
}
finally
{	await pool.shutdown();
}
```

When you start a managed transaction (`MySession.startTrx({xa: true})`), the manager generates XA ID for it.
This ID encodes in itself several pieces of data: timestamp of when the transaction started, `Deno.pid` of the application that started the transaction, ID of chosen info table, and MySQL connection ID.

When you call `session.commit()`, the 2-phase commit takes place on all the connections in this session.
After the 1st phase succeeded, current XA ID is inserted to the chosen info table (in parallel connection in autocommit mode).
And after successful 2nd phase, this record is deleted from the info table.

Transactions manager periodically monitors `managedXaDsns` for dangling transactions - those whose MySQL connection is dead.
If a dangling transaction found, it's either committed or rolled back.
If a corresponding record is found in the corresponding info table, the transaction will be committed.
If no record found, or there were no info tables, the transaction will be rolled back.
If you want the transactions manager to always roll back transactions in such situation, don't provide info tables to the pool options.
