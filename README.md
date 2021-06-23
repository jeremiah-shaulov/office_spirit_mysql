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
MyConn.query(sql: SqlSource, params?: object|null): ResultsetsPromise
MyConn.queryMap(sql: SqlSource, params?: object|null): ResultsetsPromise
MyConn.queryArr(sql: SqlSource, params?: object|null): ResultsetsPromise
MyConn.queryCol(sql: SqlSource, params?: object|null): ResultsetsPromise
```
These methods return `ResultsetsPromise` which is subclass of `Promise<Resultsets>`.
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
	{	await conn.query("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, message text)");
		await conn.query("INSERT INTO t_log (message) VALUES ('Message 1'), ('Message 2'), ('Message 3')");

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
	{	await conn.query("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, message text)");
		await conn.query("INSERT INTO t_log (message) VALUES ('Message 1'), ('Message 2'), ('Message 3')");

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
	{	await conn.query("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, message text)");
		await conn.query("INSERT INTO t_log (message) VALUES ('Message 1'), ('Message 2'), ('Message 3')");

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
	{	await conn.query("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, message text)");
		await conn.query("INSERT INTO t_log (message) VALUES ('Message 1'), ('Message 2'), ('Message 3')");

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
	{	await conn.query("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, `time` timestamp, message text)");
		await conn.query("INSERT INTO t_log SET `time`=Now(), message='Message 1'");

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
	{	await conn.query("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, `time` timestamp, message text)");
		await conn.query("INSERT INTO t_log SET `time`=Now(), message='Message 1'");

		let row = await conn.query("SELECT `time` + INTERVAL @days DAY AS 'time', message FROM t_log WHERE id=@`id`", {days: 3, id: 1}).first();
		console.log(row);
	}
);

await pool.onEnd();
pool.closeIdle();
```

## Reading long BLOBs

This library tries to has everything needed in real life usage. It's possible to read long data without storing it to memory.

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
	{	await conn.query("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, `time` timestamp, message text)");

		let file = await Deno.open('/etc/passwd', {read: true});
		try
		{	await conn.query("INSERT INTO t_log SET `time`=Now(), message=?", [file]);
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

let pool = new MyPool('mysql://root:hello@localhost/tests');

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
			{	await conn.query(file);
			}
			finally
			{	file.close();
			}

			console.log(await conn.query("SELECT `time`, message FROM t_log").all());
		}
		finally
		{	await Deno.remove(filename);
		}
	}
);

await pool.onEnd();
pool.closeIdle();
```
