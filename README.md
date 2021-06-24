Driver for MySQL and MariahDB.

Features:
- Prepared statements.
- Binary protocol. Query parameters are sent separately from text query.
- Sane connections pooling. Connections are reset after usage (locks are freed).
- Pool for connections to multiple servers.
- Streaming BLOBs.
- Custom handler for LOCAL INFILE.
- Made with CPU and RAM efficiency in mind.

Basic example:

```ts
import {MyPool} from './mod.ts';

let pool = new MyPool('mysql://root:hello@localhost/tests');

pool.forConn
(	async (conn) =>
	{	await conn.query("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, message text)");
		await conn.query("INSERT INTO t_log (message) VALUES ('Message 1'), ('Message 2'), ('Message 3')");

		for await (let row of await conn.query("SELECT * FROM t_log"))
		{	console.log(row);
		}
	}
);

await pool.onEnd();
pool.closeIdle();
```

## Connections

Connections to database servers are managed by `MyPool` object.

```ts
new MyPool(options?: MyPoolOptions|Dsn|string)
```

Options are:

```ts
interface MyPoolOptions
{	dsn?: Dsn|string;
	maxConns?: number;
	onLoadFile?: (filename: string) => Promise<(Deno.Reader & Deno.Closer) | undefined>;
}
```
- `dsn` - Default data source name of this pool.
- `maxConns` - Limit to number of simultaneous connections in this pool. When reached `pool.haveSlots()` returns false, and new connection request will wait.
- `onLoadFile` - Handler for `LOAD DATA LOCAL INFILE` query.

Options can be given just as DSN string, or a `Dsn` object, that contains parsed DSN string.

Data source name is specified in URL format, with "mysql://" protocol.

Format: `mysql://user:password@host:port/schema?param1=value1&param2=value2#INITIAL_SQL`
Or: `mysql://user:password@localhost/path/to/named.pipe/schema`

Example: `mysql://root@localhost/`
Or: `mysql://root:hello@[::1]/?keepAliveTimeout=10000&foundRows`

Possible parameters:
- `keepAliveTimeout` (number) milliseconds - each connection will persist for this period of time, before termination, so it can be reused when someone else asks for the same connection
- `keepAliveMax` (number) - how many times at most to recycle each connection
- `maxColumnLen` (number) bytes - if a column was longer, it's value is skipped, and it will be returned as NULL
- `foundRows` (boolean) - if present, will use "found rows" instead of "affected rows" in resultsets
- `ignoreSpace` (boolean) - if present, parser on server side can ignore spaces before '(' in built-in function names
- `multiStatements` (boolean) - if present, SQL can contain multiple statements separated with ';', so you can upload dumps, but SQL injection attacks become more risky

Connection from the poll can be asked with `pool.forConn()` function:

```ts
MyPool.forConn<T>(callback: (conn: MyConn) => Promise<T>, dsn?: Dsn|string): Promise<T>
```
If `dsn` is not provided, the default DSN of the pool will be used. You can ask connections to different servers.

The requested connection will be available in the provided `callback`, and when it completes, this connection will return back to pool.

Connection state is reset before returning to the pool. This means that incomplete transaction will be rolled back, and all kind of locks will be cleared.
Then this connection can be idle in the pool for at most `keepAliveTimeout` milliseconds, and if nobody was interested in it during this period, it will be terminated.
If somebody killed a connection while it was idle in the pool, and you asked to use this connection again, the first query on this connection can fail.
If this happens, another connection will be tried, and you query will be retried. This process is transparent to you.

In the beginning of `callback`, `conn` may be not connected to the server. It will connect on first requested query.

If you want to deal with multiple simultaneous connections, you can call `pool.session()` to start a cross-server session.

```ts
MyPool.session<T>(callback: (session: MySession) => Promise<T>): Promise<T>
```
During this session you can call `session.conn()` to get a connection. At the end of callback all the connections will return to the pool, if they didn't before.

```ts
MySession.conn(dsn?: Dsn|string, fresh=false): MyConn
```
The connection object (`MyConn`) is returned immediately, but actual connection will be established on first SQL query.

With `true` second argument, always new connection is returned. Otherwise, if there's already a connection to the same DSN in this session, it will be picked up.

```ts
import {MyPool} from './mod.ts';

let pool = new MyPool('mysql://root@localhost');

pool.session
(	async (session) =>
	{	let conn1 = session.conn(); // default DSN
		let conn2 = session.conn(); // the same object
		let conn3 = session.conn(undefined, true); // another connection to default DSN
		let conn4 = session.conn('mysql://tests@localhost'); // connection to different DSN

		console.log(conn1 == conn2); // prints true

		let connId2 = conn2.queryCol("SELECT Connection_id()").first();
		let connId3 = conn3.queryCol("SELECT Connection_id()").first();
		let connId4 = conn4.queryCol("SELECT Connection_id()").first();

		console.log(await Promise.all([connId2, connId3, connId4])); // prints 3 different connection ids
	}
);

await pool.onEnd();
pool.closeIdle();
```
At the end of callback all active connections will be returned to the pool. However you can call `conn.end()` to free a connection earlier.

## Making queries

`MyConn` object has the following methods for making simple queries:

```ts
MyConn.execute(sql: SqlSource, params?: object|null): Promise<Resultsets>
MyConn.query(sql: SqlSource, params?: object|null): ResultsetsPromise
MyConn.queryMap(sql: SqlSource, params?: object|null): ResultsetsPromise
MyConn.queryArr(sql: SqlSource, params?: object|null): ResultsetsPromise
MyConn.queryCol(sql: SqlSource, params?: object|null): ResultsetsPromise
```
`execute` method executes it's query and discards returned rows.
Returned `Resultsets` object contains `lastInsertId`, `affectedRows`, and more such information about the query.
If there were multiple resultsets, it will contain only information about the last one.

`query*` methods return `ResultsetsPromise` which is subclass of `Promise<Resultsets>`.
Awaiting it gives you `Resultsets` object.
Iterating over `Resultsets` yields rows.

If the query you executed didn't return rows (query like `INSERT`), then zero rows will be yielded, and `resultsets.columns` will be empty array.
`resultsets.lastInsertId` and `resultsets.affectedRows` will show relevant information.

If there're rows, you need to iterate them to the end, before you can execute another query.
You can read all the rows with `Resultsets.all()` or `ResultsetsPromise.all()`.

```ts
import {MyPool} from './mod.ts';

let pool = new MyPool('mysql://root:hello@localhost/tests');

pool.forConn
(	async (conn) =>
	{	await conn.execute("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, message text)");
		await conn.execute("INSERT INTO t_log (message) VALUES ('Message 1'), ('Message 2'), ('Message 3')");

		console.log(await conn.query("SELECT * FROM t_log").all()); // ResultsetsPromise.all()

		let res = await conn.query("SELECT * FROM t_log");
		console.log(res.columns);
		console.log(await res.all()); // Resultsets.all()
	}
);

await pool.onEnd();
pool.closeIdle();
```
If your query returns single row, you can read it with `Resultsets.first()` or `ResultsetsPromise.first()`.
It returns the first row itself, not an array of rows.
And it skips all further rows, if they exist.

```ts
import {MyPool} from './mod.ts';

let pool = new MyPool('mysql://root:hello@localhost/tests');

pool.forConn
(	async (conn) =>
	{	await conn.execute("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, message text)");
		await conn.execute("INSERT INTO t_log (message) VALUES ('Message 1'), ('Message 2'), ('Message 3')");

		console.log(await conn.query("SELECT Count(*) FROM t_log").first()); // ResultsetsPromise.all()

		let res = await conn.query("SELECT Count(*) FROM t_log");
		console.log(res.columns);
		console.log(await res.first()); // Resultsets.all()
	}
);

await pool.onEnd();
pool.closeIdle();
```
You can iterate the resultset with `for await` loop, or you can call `ResultsetsPromise.forEach()` or `Resultsets.forEach()` method.

```ts
ResultsetsPromise.forEach<T>(callback: (row: any) => T|Promise<T>): Promise<T|undefined>
```

```ts
import {MyPool} from './mod.ts';

let pool = new MyPool('mysql://root:hello@localhost/tests');

pool.forConn
(	async (conn) =>
	{	await conn.execute("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, message text)");
		await conn.execute("INSERT INTO t_log (message) VALUES ('Message 1'), ('Message 2'), ('Message 3')");

		// for await loop
		for await (let row of await conn.query("SELECT * FROM t_log"))
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

await pool.onEnd();
pool.closeIdle();
```

- `MyConn.query()` method iterates over rows as Javascript default objects with fields.
- `MyConn.queryMap()` method iterates over rows as `Map` objects.
- `MyConn.queryArr()` method iterates over rows as `Array`s with column values without column names.
- `MyConn.queryCol()` method iterates over first column values of each row.

```ts
import {MyPool} from './mod.ts';

let pool = new MyPool('mysql://root:hello@localhost/tests');

pool.forConn
(	async (conn) =>
	{	await conn.execute("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, message text)");
		await conn.execute("INSERT INTO t_log (message) VALUES ('Message 1'), ('Message 2'), ('Message 3')");

		console.log(await conn.queryCol("SELECT Count(*) FROM t_log").first()); // prints 3
	}
);

await pool.onEnd();
pool.closeIdle();
```

## Query parameters

It's possible to substitute parameters inside SQL query.

This library doesn't know to parse SQL. To parse SQL correctly, need to take into account `conn.charset` and `conn.noBackslashEscapes` values.
This is complicated task for me. Inspirations can be sniffed from source code of MySQL driver for PHP, especially files `php-7.4.14/ext/mysqlnd/mysqlnd_charset.c` and `php-7.4.14/ext/mysqlnd/mysqlnd_structs.h`. But i'm not sure that even that implementation covers all possible cases.

Anyway parsing SQL wastes CPU and memory resources. Much easier is just let MySQL server to substitute the parameters. It knows to do so.

### Positional parameters

Values are substituted in place of `?` marks. Placeholders can appear only in places in SQL where expression is allowed.

```ts
import {MyPool} from './mod.ts';

let pool = new MyPool('mysql://root:hello@localhost/tests');

pool.forConn
(	async (conn) =>
	{	await conn.execute("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, `time` timestamp, message text)");
		await conn.execute("INSERT INTO t_log SET `time`=Now(), message='Message 1'");

		let row = await conn.query("SELECT `time` + INTERVAL ? DAY AS 'time', message FROM t_log WHERE id=?", [3, 1]).first();
		console.log(row);
	}
);

await pool.onEnd();
pool.closeIdle();
```

### Named parameters

For named parameters i utilize MySQL variables. Values are expressed as `@` sign followed by variable name, where name can be backtick-quoted.

To execute such query, another pre-query is needed, that sends `SET @days=3, @id=1`. Parameter names will override session variables with the same name.

```ts
import {MyPool} from './mod.ts';

let pool = new MyPool('mysql://root:hello@localhost/tests');

pool.forConn
(	async (conn) =>
	{	await conn.execute("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, `time` timestamp, message text)");
		await conn.execute("INSERT INTO t_log SET `time`=Now(), message='Message 1'");

		let row = await conn.query("SELECT `time` + INTERVAL @days DAY AS 'time', message FROM t_log WHERE id=@`id`", {days: 3, id: 1}).first();
		console.log(row);
	}
);

await pool.onEnd();
pool.closeIdle();
```

## Reading long BLOBs

This library tries to have everything needed in real life usage. It's possible to read long data without storing it in memory.

```ts
import {MyPool} from './mod.ts';

let pool = new MyPool('mysql://root:hello@localhost/tests');

pool.forConn
(	async (conn) =>
	{	await conn.query("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, `time` timestamp, message text)");
		await conn.query("INSERT INTO t_log SET `time`=Now(), message='long long message'");

		let row = await conn.makeLastColumnReader("SELECT `time`, message FROM t_log WHERE id=1");
		await Deno.copy(row.message, Deno.stdout);
	}
);

await pool.onEnd();
pool.closeIdle();
```

## Writing long BLOBS

Query parameter values can be of various types, including `Deno.Reader`. If some parameter is `Deno.Reader`, the parameter value will be read from this reader (without storing the whole BLOB in memory).

```ts
import {MyPool} from './mod.ts';

let pool = new MyPool('mysql://root:hello@localhost/tests');

pool.forConn
(	async (conn) =>
	{	await conn.execute("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, `time` timestamp, message text)");

		let file = await Deno.open('/etc/passwd', {read: true});
		try
		{	await conn.execute("INSERT INTO t_log SET `time`=Now(), message=?", [file]);
		}
		finally
		{	file.close();
		}

		let row = await conn.makeLastColumnReader("SELECT `time`, message FROM t_log WHERE id=1");
		await Deno.copy(row.message, Deno.stdout);
	}
);

await pool.onEnd();
pool.closeIdle();
```

## Importing big dumps

Functions like `MyConn.query()`, `MyConn.queryCol()`, etc. allow to provide SQL query in several forms.

```ts
type SqlSource = string | Uint8Array | Deno.Reader&Deno.Seeker | Deno.Reader&{readonly size: number};

MyConn.query(sql: SqlSource, params?: object|null): ResultsetsPromise;
```
This allows to read SQL from files.

```ts
import {MyPool} from './mod.ts';

let pool = new MyPool('mysql://root:hello@localhost/tests?multiStatements');

pool.forConn
(	async (conn) =>
	{	let filename = await Deno.makeTempFile();
		try
		{	await Deno.writeTextFile
			(	filename,
				`	CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, c_time timestamp, message text);

					INSERT INTO t_log SET c_time=Now(), message='long long message';
				`
			);

			let file = await Deno.open(filename, {read: true});
			try
			{	await conn.execute(file);
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

await pool.onEnd();
pool.closeIdle();
```

## Prepared statements

Function `conn.forQuery()` prepares an SQL statement with parameters, that you can execute multiple times, each time with different parameters.

```ts
forQuery<T>(sql: SqlSource, callback: (prepared: Resultsets) => Promise<T>): Promise<T>
```

```ts
import {MyPool} from './mod.ts';

let pool = new MyPool('mysql://root:hello@localhost/tests');

pool.forConn
(	async (conn) =>
	{	// CREATE TABLE
		await conn.query("CREATE TEMPORARY TABLE t_messages (id integer PRIMARY KEY AUTO_INCREMENT, message text)");

		// INSERT
		await conn.forQuery
		(	"INSERT INTO t_messages SET message=?",
			async (prepared) =>
			{	for (let i=1; i<=3; i++)
				{	await prepared.exec(['Message '+i]);
				}
			}
		);

		// SELECT
		console.log(await conn.query("SELECT * FROM t_messages").all());
	}
);

await pool.onEnd();
pool.closeIdle();
```

## LOAD DATA LOCAL INFILE

If this feature is enabled on your server, you can register a custom handler that will take `LOAD DATA LOCAL INFILE` requests.

```ts
import {MyPool} from './mod.ts';
import {dirname} from "https://deno.land/std@0.97.0/path/mod.ts";

let pool = new MyPool('mysql://root:hello@localhost/tests');

// Set handler for LOAD DATA LOCAL INFILE queries
const ALLOWED_DIRS = ['/tmp'];
pool.options
(	{	async onLoadFile(filename: string)
		{	if (ALLOWED_DIRS.includes(dirname(filename)))
			{	return Deno.open(filename, {read: true});
			}
		}
	}
);

// Download some public example CSV file from github
let data = await fetch('https://raw.githubusercontent.com/lukes/ISO-3166-Countries-with-Regional-Codes/master/all/all.csv');
let filename = await Deno.makeTempFile();
await Deno.writeTextFile(filename, await data.text());

// Create temporary table, load the data to it, and then select it back
pool.forConn
(	async (conn) =>
	{	// CREATE TABLE
		await conn.execute
		(	`	CREATE TEMPORARY TABLE t_countries
				(	country_code char(2) CHARACTER SET latin1 NOT NULL PRIMARY KEY,
					country_name varchar(128) NOT NULL
				)
			`
		);

		// Quote filename for use in an SQL query
		let filename_sql = await conn.queryCol("SELECT Quote(?)", [filename]).first();

		// LOAD DATA
		let res = await conn.execute
		(	`	LOAD DATA LOCAL INFILE ${filename_sql}
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

await pool.onEnd();
pool.closeIdle();
```

## Connection status

`MyConn` object has several status variables:

`conn.serverVersion: string` - remote server version, as it reports (for example my server reports "8.0.25-0ubuntu0.21.04.1").
`conn.connectionId: number` - thread ID of the connection, that `SHOW PROCESSLIST` shows.
`conn.autocommit: boolean` - true if the connection is currently in autocommit mode. Queries like `SET autocommit=0` will affect this flag.
`conn.inTrx: boolean` - true if a transaction was started. Queries like `START TRANSACTION` and `ROLLBACK` will affect this flag.
`conn.inTrxReadonly: boolean` - true if a readonly transaction was started. Queries like `START TRANSACTION READ ONLY` and `ROLLBACK` will affect this flag.
`conn.noBackslashEscapes: boolean` - true, if the server is configured not to use backslash escapes in string literals. Queries like `SET sql_mode='NO_BACKSLASH_ESCAPES'` will affect this flag.
`conn.charset: Charset` - collation ID, as appears in `SELECT * FROM information_schema.collations`.
`conn.schema: string` - current default schema (database) name. Queries like `USE new_schema` will affect this value, if your server supports change schema notifications.

Initially these variables can be empty. They are set after actual connection to the server, that happens after issuing the first query. Or you can call `await conn.connect()`.

## Resultsets

`conn.execute()`, and `conn.query*()` methods all return `Resultsets` object, that contains information about your query result.
Also this object allows to iterate over rows that the query returned.

If your query returned multiple resultsets, `conn.execute()` skips them, and returns only the last one.

`conn.query*()` functions don't skip resultsets, and `await resultsets.nextResultset()` will advance to the next result, and return true.
If there are no more resultsets, `await resultsets.nextResultset()` returns false.
And you must read or discard all the resultsets before being able to issue next queries.

```ts
import {MyPool} from './mod.ts';

let pool = new MyPool('mysql://root:hello@localhost/tests?multiStatements');

pool.forConn
(	async (conn) =>
	{	let resultsets = await conn.query
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

		for await (let row of resultsets)
		{	console.log(row);
		}
	}
);

await pool.onEnd();
pool.closeIdle();
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
- `Resultsets.placeholders: Column[]` - Information about `?` placeholders in the SQL query.
- `Resultsets.hasMore: boolean` - True if there are more rows or resultsets to read.
- `Resultsets.exec(params: any[]): Promise<void>` - If this is a prepared query, this function executes it again.
- `Resultsets.all(): Promise<any[]>` - Reads all rows in current resultset to an array.
- `Resultsets.first(): Promise<any>` - Reads all rows in current resultset, and returns the first row.
- `Resultsets.forEach<T>(callback: (row: any) => T | Promise<T>): Promise<T | undefined>` - Reads all rows, and calls the provided callback for each of them.
- `Resultsets.nextResultset(): Promise<boolean>` - Advances to the next resultset of this query, if there is one. Returns true if moved to the next resultset.
- `Resultsets.discard(): Promise<void>` - Reads and discards all the rows in all the resultsets of this query.
