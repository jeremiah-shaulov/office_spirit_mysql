/**	MySQL and MariaDB driver for Deno. Tested on: MySQL 5.6, 5.7, 8.0, 9.0, MariaDB 5.5, 10.0, 10.2, 10.5, 10.7, 11.5.

	Features:
	- Sane connections pooling. Connections are reset after usage (locks are freed).
	- Pool for connections to multiple servers.
	- Auto-retry connection if server is busy.
	- Auto-retry queries if "deadlock" in autocommit mode.
	- Streaming BLOBs and `ReadableStream`s.
	- Custom handler for LOCAL INFILE.
	- Advanced transactions manager: regular transactions, readonly, distributed (2-phase commit), savepoints.
	- Prepared statements.
	- Binary protocol. Query parameters are sent separately from query text.
	- Made with CPU and RAM efficiency in mind.

	This library is not just a driver, but it's ready to use tool, that covers many MySQL use cases.

	Basic example:

	```ts
	// To run this example:
	// export DSN='mysql://root:hello@localhost/tests'
	// deno run --allow-env --allow-net example.ts

	import {MyPool} from './mod.ts';

	// Create a connections pool. This is the only way in this library to create server connections
	await using pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');

	// Get a connection object. The actual TCP connection will be established on the first query
	using conn = pool.getConn();

	// Execute queries that don't return rows
	await conn.query("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, message text)");
	await conn.query("INSERT INTO t_log (message) VALUES ('Message 1'), ('Message 2'), ('Message 3')");

	// Execute query that returns rows
	for await (const row of conn.query("SELECT * FROM t_log"))
	{	console.log(row);
	}
	```

	## Connections pool

	Connections to database servers are managed by {@link MyPool} object.
	You need to create one such object, and ask it to give you a free connection.
	Most applications don't need more than one pool, but you can also have several pools, each one with different configuration.

	{@linkcode MyPool.constructor}

	When you create a {@link MyPool} instance, you can give it a default DSN (Data Source Name), that will be used if the DSN is not specified when requesting a new connection.
	You can provide the DSN as a string or as {@link Dsn} object, that contains parsed string.

	Or you can specify more options:

	{@linkcode MyPoolOptions}

	- `dsn` - Default Data Source Name for this pool.
	- `maxConnsWaitQueue` - (number, default 50) When `maxConns` exceeded, new connection requests will enter waiting queue (like backlog). This is the queue maximum size.
	- `onLoadFile` - Handler for `LOAD DATA LOCAL INFILE` query.
	- `onBeforeCommit` - Callback that will be called every time a transaction is about to be committed.
	- `managedXaDsns` - Will automatically manage distributed transactions on DSNs listed here (will rollback or commit dangling transactions).
	- `xaCheckEach` - (number, default `6000`) Check for dangling transactions each this number of milliseconds.
	- `xaInfoTables` - You can provide tables (that you need to create), that will improve distributed transactions management (optional).
	- `logger` - a `console`-compatible logger, or `globalThis.console`. It will be used to report errors and print log messages.

	Data Source Name is specified in URL format with "mysql://" protocol.

	Format: `mysql://user:password@host:port/schema?param1=value1&param2=value2#INITIAL_SQL`
	Or: `mysql://user:password@localhost/path/to/named.pipe/schema`

	Example: `mysql://root@localhost/`
	Or: `mysql://root:hello@[::1]/?keepAliveTimeout=10000&foundRows`

	The DSN can contain question mark followed by parameters. Possible parameters are:

	- `connectionTimeout` (number, default `5000`) milliseconds - if connection to the server is failing, it will be retried during this period of time, each `reconnectInterval` milliseconds.
	- `reconnectInterval` (number, default `500`) milliseconds - will retry connecting to the server each this number of milliseconds, during the `connectionTimeout`.
	- `keepAliveTimeout` (number, default `10000`) milliseconds - each connection will persist for this period of time, before termination, so it can be reused when someone else asks for the same connection
	- `keepAliveMax` (number, default `Infinity`) - how many times at most to recycle each connection
	- `maxConns` - (number, default `250`) Limit number of simultaneous connections to this DSN in pool
	- `maxColumnLen` (number, default `10MiB`) bytes - if a column was longer, it's value is skipped, and it will be returned as NULL (this doesn't apply to [conn.makeLastColumnReadable()]{@link MyConn.makeLastColumnReadable} - see below)
	- `foundRows` (boolean, default `false`) - if present, will use "found rows" instead of "affected rows" in resultsets (see [here]{@link https://dev.mysql.com/doc/refman/8.0/en/information-functions.html#function_row-count} how CLIENT_FOUND_ROWS flag affects result of `Row_count()` function)
	- `ignoreSpace` (boolean, default `false`) - if present, parser on server side can ignore spaces before '(' in built-in function names (see description [here]{@link https://dev.mysql.com/doc/refman/8.0/en/sql-mode.html#sqlmode_ignore_space})
	- `retryLockWaitTimeout` (boolean, default `false`) - if set, and `retryQueryTimes` is also set, will retry query that failed with "lock wait timeout" error. The query will be retried `retryQueryTimes` times.
	- `retryQueryTimes` - (number, default `0`) Automatically reissue queries this number of attempts, if error was "deadlock" in autocommit mode, or (if `retryLockWaitTimeout` was set) "lock wait timeout" in both modes. Please note, that this will also rerun queries like `CALL`.
	- `datesAsString` (boolean, default `false`) - if present, date, datetime and timestamp columns will not be converted to `Date` objects when selected from MySQL, so they'll be returned as strings
	- `correctDates` (boolean, default `false`) - enables timezone correction when converting between Javascript `Date` objects and MySQL date, datetime and timestamp types. This feature is supported on MySQL 5.7+, and MariaDB 10.3+.

	The DSN can contain `#` sign followed by SQL statement or several statements separated with semicolons.
	This SQL will be executed before first query in each connection.

	## Connections

	A new connection from connections pool can be asked with [pool.getConn()]{@link MyPool.getConn} function:

	{@linkcode MyPool.getConn}

	If `dsn` is not provided, the default DSN of the pool will be used. You can provide different `dsn` to ask a connection to different server.

	The returned {@link MyConn} object is disposable. Usually you will want to bind it to an owned variable through `using` keyword.
	When {@link MyConn."[Symbol.dispose]"|conn[Symbol.dispose]()} is called, the connection comes back to it's pool.

	Another way of using connections is by calling [pool.forConn()]{@link MyPool.forConn} giving it an async callback, and the connection can be used within this callback, and when it returns the connection will be returned to the pool.

	{@linkcode MyPool.forConn}

	The following is essentially the same:

	```ts
	import {MyPool} from './mod.ts';

	await using pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');
	using conn = pool.getConn();
	const version = await conn.queryCol("SELECT Version()").first();
	console.log(version);
	```
	And:
	```ts
	import {MyPool} from './mod.ts';

	await using pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');
	const version = await pool.forConn
	(	async conn =>
		{	const version = await conn.queryCol("SELECT Version()").first();
			return version;
		}
	);
	console.log(version);
	```

	If the promise that [pool.forConn()]{@link MyPool.forConn} returns is not explicitly awaited for, it will be awaited for when the pool is disposed, so the following is also equivalent:
	```ts
	import {MyPool} from './mod.ts';

	await using pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');
	pool.forConn
	(	async conn =>
		{	const version = await conn.queryCol("SELECT Version()").first();
			console.log(version);
		}
	);
	```

	Before the connection is returned to the pool, its state is reset. This means that incomplete transactions are rolled back, and all kind of locks are cleared.
	Then this connection can be idle in the pool for at most [keepAliveTimeout]{@link Dsn.keepAliveTimeout} milliseconds, and if nobody was interested in it during this period, it will be terminated.
	If somebody killed a connection while it was idle in the pool, and you asked to use this connection again, the first query on this connection can fail.
	If this happens, another connection will be tried, and your query will be reissued. This process is transparent to you.

	In the beginning of `callback`, the `conn` is not connected to the server. It will connect on first requested query.
	To force connection call [await conn.connect()]{@link MyConn.connect}.

	If server is busy ("too many connections", "server shutdown in progress", etc.), the connection will be retried during the period of [connectionTimeout]{@link Dsn.connectionTimeout} milliseconds (specified in the DSN parameters).
	During this period the connection will be retried each [reconnectInterval]{@link Dsn.reconnectInterval} milliseconds.
	There will be only one retrying connection. Till it's resolved new connections will be tried once, and if not successful they will enter waiting queue.

	If `maxConns` number of connections in pool reached, a new connection will enter waiting queue without trying to connect.

	If there was no free slot during the [connectionTimeout]{@link Dsn.connectionTimeout} period, or if the waiting queue is full ([maxConnsWaitQueue]{@link MyPoolOptions.maxConnsWaitQueue} items long), exception is thrown.

	## Cross-server sessions

	If you want to deal with multiple simultaneous connections, you can call [pool.getSession()]{@link MyPool.getSession} to start a cross-server session.

	{@linkcode MyPool.getSession}

	The returned {@link MySession} object is disposable. Usually you will want to bind it to an owned variable through `using` keyword.
	When {@link MySession."[Symbol.dispose]"|session[Symbol.dispose]()} is called, all the connections in this session are disposed.

	Another way of using sessions is by calling [pool.forSession()]{@link MyPool.forSession} giving it an async callback, and the session can be used within this callback.

	{@linkcode MyPool.forSession}

	During this session you can call [session.conn()]{@link MySession.conn} to get a connection. At the end of callback all the connections will return to the pool, if they didn't before.

	{@linkcode MySession.conn}

	`MySession.conn()` returns the connection object ({@link MyConn}) immediately, but actual connection will be established on first SQL query.

	With `true` second argument, always new connection is returned. Otherwise, if there's already an active connection to the same DSN in this session, it will be picked up.

	```ts
	// To run this example:
	// export DSN='mysql://root:hello@localhost/tests'
	// deno run --allow-env --allow-net example.ts

	import {MyPool, Dsn} from './mod.ts';
	import {assert} from 'jsr:@std/assert@1.0.7/assert';
	import {assertEquals} from 'jsr:@std/assert@1.0.7/equals';

	const dsn1 = new Dsn(Deno.env.get('DSN') || 'mysql://root:hello@localhost');
	const dsn2 = new Dsn(dsn1); // copy
	dsn2.schema = 'information_schema'; // change schema

	await using pool = new MyPool(dsn1); // `dsn1` will be the default DSN for this pool
	using session = pool.getSession();

	const conn1 = session.conn(); // default DSN
	const conn2 = session.conn(); // the same object
	const conn3 = session.conn(undefined, true); // another connection to default DSN
	const conn4 = session.conn(dsn2); // connection to different DSN

	assert(conn1 == conn2);
	assert(conn2 != conn3);

	const connId2 = conn2.queryCol("SELECT Connection_id()").first();
	const connId3 = conn3.queryCol("SELECT Connection_id()").first();
	const connId4 = conn4.queryCol("SELECT Connection_id()").first();

	const connIds = await Promise.all([connId2, connId3, connId4]);
	console.log(connIds); // prints 3 different connection ids
	assertEquals(new Set(connIds).size, 3);
	```
	At the end of callback all active connections will be returned to the pool. However you can call [conn.end()]{@link MyConn.end} to free a connection earlier.

	## Executing queries

	To run a query that doesn't return rows, use [queryVoid()]{@link MyConn.queryVoid}:

	{@linkcode MyConn.queryVoid}

	This method executes it's query and discards returned rows.
	Returned `Resultsets` object contains `lastInsertId`, `affectedRows`, and more such information about the query.
	If there were multiple resultsets, it will contain only information about the last one.

	To run a query, and read it's rows, use one of the following methods:

	{@linkcode MyConn.query}
	{@linkcode MyConn.queryMap}
	{@linkcode MyConn.queryArr}
	{@linkcode MyConn.queryCol}

	These `query*` methods return {@link ResultsetsPromise} which is subclass of `Promise<Resultsets>`.
	Awaiting it gives you {@link Resultsets} object.
	Iterating over {@link ResultsetsPromise} or {@link Resultsets} yields rows.

	If your query didn't return rows (query like `INSERT`), then these methods work exactly as [queryVoid()]{@link MyConn.queryVoid}, so zero rows will be yielded, and [resultsets.columns]{@link Resultsets.columns} will be empty array,
	and [resultsets.lastInsertId]{@link Resultsets.lastInsertId} and [resultsets.affectedRows]{@link Resultsets.affectedRows} will show relevant information.

	If there're rows, you need to iterate them to the end, before you can execute another query.
	Executing another query while there're unread resultsets throws {@link BusyError}.
	You can read all the rows with {@link Resultsets.all()} or {@link ResultsetsPromise.all()}.

	```ts
	// To run this example:
	// export DSN='mysql://root:hello@localhost/tests'
	// deno run --allow-env --allow-net example.ts

	import {MyPool} from './mod.ts';

	await using pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');
	using conn = pool.getConn();

	await conn.queryVoid("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, message text)");
	await conn.queryVoid("INSERT INTO t_log (message) VALUES ('Message 1'), ('Message 2'), ('Message 3')");

	// use ResultsetsPromise.all()
	console.log(await conn.query("SELECT * FROM t_log").all());

	// use Resultsets.all()
	const res = await conn.query("SELECT * FROM t_log");
	console.log(res.columns);
	console.log(await res.all());
	```

	If your query returns single row, you can read it with {@link Resultsets.first()} or {@link ResultsetsPromise.first()}.
	It returns the first row itself, not an array of rows.
	And it skips all further rows, if they exist.

	```ts
	// To run this example:
	// export DSN='mysql://root:hello@localhost/tests'
	// deno run --allow-env --allow-net example.ts

	import {MyPool} from './mod.ts';

	await using pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');
	using conn = pool.getConn();

	await conn.queryVoid("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, message text)");
	await conn.queryVoid("INSERT INTO t_log (message) VALUES ('Message 1'), ('Message 2'), ('Message 3')");

	// use ResultsetsPromise.first()
	console.log(await conn.query("SELECT Count(*) FROM t_log").first());

	// use Resultsets.first()
	const res = await conn.query("SELECT Count(*) FROM t_log");
	console.log(res.columns);
	console.log(await res.first());
	```

	You can iterate the resultset ({@link ResultsetsPromise} or {@link Resultsets}) with `for await` loop, or you can call {@link ResultsetsPromise.forEach()} or {@link Resultsets.forEach()} method.

	{@linkcode ResultsetsPromise.forEach}

	```ts
	// To run this example:
	// export DSN='mysql://root:hello@localhost/tests'
	// deno run --allow-env --allow-net example.ts

	import {MyPool} from './mod.ts';

	await using pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');
	using conn = pool.getConn();

	await conn.queryVoid("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, message text)");
	await conn.queryVoid("INSERT INTO t_log (message) VALUES ('Message 1'), ('Message 2'), ('Message 3')");

	// for await loop
	for await (const row of conn.query("SELECT * FROM t_log"))
	{	console.log(row);
	}

	// ResultsetsPromise.forEach()
	await conn.query("SELECT * FROM t_log").forEach
	(	row =>
		{	console.log(row);
		}
	);
	```

	- {@link MyConn.query()} method iterates over rows as Javascript default objects with fields.
	- {@link MyConn.queryMap()} method iterates over rows as `Map` objects.
	- {@link MyConn.queryArr()} method iterates over rows as `Array`s with column values without column names.
	- {@link MyConn.queryCol()} method iterates over first column values of each row.

	For example, using `queryCol().first()` you can get the result of `SELECT Count(*)` as a single number value:

	```ts
	// To run this example:
	// export DSN='mysql://root:hello@localhost/tests'
	// deno run --allow-env --allow-net example.ts

	import {MyPool} from './mod.ts';
	import {assertEquals} from 'jsr:@std/assert@1.0.7/equals';

	await using pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');
	using conn = pool.getConn();

	await conn.queryVoid("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, message text)");
	await conn.queryVoid("INSERT INTO t_log (message) VALUES ('Message 1'), ('Message 2'), ('Message 3')");

	const count = await conn.queryCol("SELECT Count(*) FROM t_log").first();
	console.log(count); // prints 3
	assertEquals(count, 3);
	```

	Here is the complete definition of query functions:

	```ts
	MyConn.queryVoid(sql: SqlSource, params?: Params): Promise<Resultsets<void>> {...}
	MyConn.query<ColumnType=ColumnValue>(sql: SqlSource, params?: Params): ResultsetsPromise<Record<string, ColumnType>> {...}
	MyConn.queryMap<ColumnType=ColumnValue>(sql: SqlSource, params?: Params): ResultsetsPromise<Map<string, ColumnType>> {...}
	MyConn.queryArr<ColumnType=ColumnValue>(sql: SqlSource, params?: Params): ResultsetsPromise<ColumnType[]> {...}
	MyConn.queryCol<ColumnType=ColumnValue>(sql: SqlSource, params?: Params): ResultsetsPromise<ColumnType> {...}

	type SqlSource =
		string |
		Uint8Array |
		({readonly readable: ReadableStream<Uint8Array>} | Deno.Reader) & ({readonly size: number} | Deno.Seeker) |
		ToSqlBytes;
	type Params = any[] | Record<string, any> | null;
	class ResultsetsPromise<Row> extends Promise<Resultsets<Row>> {...}
	type ColumnValue = bigint | Date | Uint8Array | JsonNode;
	type JsonNode = null | boolean | number | string | JsonNode[] | {[member: string]: JsonNode};
	```

	By default `query*()` functions produce rows where each column is of `ColumnValue` type.

	```ts
	// To run this example:
	// export DSN='mysql://root:hello@localhost/tests'
	// deno run --allow-env --allow-net example.ts

	import {MyPool, ColumnValue} from './mod.ts';
	import {assertEquals} from 'jsr:@std/assert@1.0.7/equals';

	await using pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');
	using conn = pool.getConn();

	await conn.queryVoid("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, message text)");
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
		assertEquals(message, 'Message 1');
	}
	```

	If you're sure about column types, you can override the column type with `any` (or something else), so each column value will be assumed to have this type.

	```ts
	// To run this example:
	// export DSN='mysql://root:hello@localhost/tests'
	// deno run --allow-env --allow-net example.ts

	import {MyPool} from './mod.ts';
	import {assertEquals} from 'jsr:@std/assert@1.0.7/equals';

	await using pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');
	using conn = pool.getConn();

	await conn.queryVoid("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, message text)");
	await conn.queryVoid("INSERT INTO t_log (message) VALUES ('Message 1'), ('Message 2'), ('Message 3')");

	// Use query<any>()
	const row = await conn.query<any>("SELECT * FROM t_log WHERE id=1").first();
	if (row)
	{	// The type of `row` here is `Record<string, any>`
		const message: string = row.message;
		console.log(message); // Prints 'Message 1'
		assertEquals(message, 'Message 1');
	}
	```

	## Executing multiple statements in a single query

	`query*()` functions described above can execute single statement. The statement can end with a semicolon.
	However multiple statements separated with semicolons will throw error.

	This library has another set of functions called `queries*()` that works like `query*()`, but allows to execute multiple statements separated with semicolons:

	{@linkcode MyConn.queriesVoid}
	{@linkcode MyConn.queries}
	{@linkcode MyConn.queriesMap}
	{@linkcode MyConn.queriesArr}
	{@linkcode MyConn.queriesCol}

	If the provided SQL contained only one statement, there's no difference in how they work.
	For multiple statements they return only resultset for the last statement.

	Use these functions with care, because SQL injections become more risky.

	## Type conversions

	When rows are read, MySQL values are converted to matching Javascript types.

	- `NULL` → `null`
	- `bit` → `boolean`
	- `integer`, `mediumint`, `smallint`, `tinyint`, `year` → `number`
	- `bigint` → either `number` or `bigint`
	- `float`, `double` → `number`
	- `date`, `datetime`, `timestamp` → `Date` if `datesAsString` parameter is not set in the connection string, and `string` if it's set
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
	- `ReadableStream<Uint8Array>` → `binary`
	- `Deno.Reader` → `binary`
	- `Date` → `datetime`
	- others → `char` representing JSON serialized value

	## Timezone

	There're 2 DSN parameters that affect conversion between Javascript `Date` objects and MySQL date, datetime and timestamp types.

	- [datesAsString]{@link Dsn.datesAsString} (boolean, default `false`)
	- [correctDates]{@link Dsn.correctDates} (boolean, default `false`)

	```ts
	const dsn1 =  new Dsn('mysql://app:app@localhost');
	const dsn2 =  new Dsn('mysql://app:app@localhost/?datesAsString');
	const dsn3 =  new Dsn(`mysql://app:app@localhost/?correctDates#SET NAMES utf8mb4, collation_connection='utf8mb4_unicode_ci', sql_mode='', time_zone='UTC'`);
	```

	- If you pass a `Date` object to query parameters it will be converted to `YYYY-MM-DD HH:MM:SS.mmm` string.
	- If you select rows containing date, datetime and timestamp columns, they're converted from `YYYY-MM-DD[ HH:MM:SS[.mmm]]` form to `Date` objects (if `datesAsString` is not set).

	Setting `datesAsString` disables the `YYYY-MM-DD[ HH:MM:SS[.mmm]]` → `Date` conversion.

	By default `YYYY-MM-DD[ HH:MM:SS[.mmm]]` ⇆ `Date` conversion is made in Deno timezone. Technically this means that:

	```ts
	const objectDate = new Date(YYYY, MM, DD, HH, MM, SS, mmm);
	const stringDate = `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()} ${d.getHours()}:${d.getMinutes()}:${d.getSeconds()}.${(d.getMilliseconds()+'').padStart(3, '0')}`;
	```

	If MySQL timezone is different than the Deno one this can lead to dates distortion.

	This library can correct dates by adding and subtracting the difference between Deno and MySQL timezones. For this feature to work you need to:

	- Set the [correctDates]{@link Dsn.correctDates} parameter.
	- Explicitly execute `SET` SQL statement that sets `time_zone` system variable, like `SET time_zone='UTC'` or equivalent. You can include it in `Dsn.initSql`, or execute through `conn.query()` before dates conversion is needed. The value that you provide to the `time_zone` variable must be recognizeable by both MySQL and Javascript `Intl.DateTimeFormat` object.
	- Use MySQL 5.7+ or MariaDB 10.3+

	Consider the following example:

	```ts
	// To run this example:
	// export DSN='mysql://root:hello@localhost/tests'
	// deno run --allow-env --allow-net example.ts

	import {MyPool} from './mod.ts';

	await using pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');
	using conn = pool.getConn();

	await conn.query("SET time_zone = 'UTC'");

	const refDate = new Date(2022, 2, 17, 10, 0, 0);
	const dateBack = await conn.queryCol("SELECT From_unixtime(@t / 1000)", {t: refDate.getTime()}).first();

	console.log(refDate);
	console.log(dateBack);
	```

	If your MySQL server is configured to use different timezone than the Deno app, this example prints 2 different dates.
	But with `correctDates` parameter set 2 equal dates are always printed, because the returned `Date` object gets corrected:

	```ts
	// To run this example:
	// export DSN='mysql://root:hello@localhost/tests'
	// deno run --allow-env --allow-net example.ts

	import {Dsn, MyPool} from './mod.ts';

	const dsn = new Dsn(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');
	dsn.correctDates = true; // THE DIFFERENCE IS HERE
	await using pool = new MyPool(dsn);
	using conn = pool.getConn();

	await conn.query("SET time_zone = 'UTC'");

	const refDate = new Date(2022, 2, 17, 10, 0, 0);
	const dateBack = await conn.queryCol("SELECT From_unixtime(@t / 1000)", {t: refDate.getTime()}).first();

	console.log(refDate);
	console.log(dateBack);
	```

	## Query parameters

	There're 3 options to parametrize queries:
	- Positional parameters (`?`-placeholders, and array of values)
	- Named parameters (`@name`-placeholders, and object with values)
	- Use third-party SQL generators (that produce final SQL string)

	### Positional parameters

	You can use `?`-placeholders in SQL query strings, and supply array of parameters to be substituted in place of them.
	This library doesn't parse the provided SQL string, but uses MySQL built-in functionality, so the parameters are substituted on MySQL side.
	Placeholders can appear only in places where expressions are allowed.

	MySQL supports up to 2**16-1 = 65535 placeholders.

	```ts
	// To run this example:
	// export DSN='mysql://root:hello@localhost/tests'
	// deno run --allow-env --allow-net example.ts

	import {MyPool} from './mod.ts';

	await using pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');
	using conn = pool.getConn();

	await conn.queryVoid("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, `time` timestamp, message text)");
	await conn.queryVoid("INSERT INTO t_log SET `time`=Now(), message='Message 1'");

	const row = await conn.query("SELECT `time` + INTERVAL ? DAY AS 'time', message FROM t_log WHERE id=?", [3, 1]).first();
	console.log(row);
	```

	### Named parameters

	For named parameters you can use `@name` placeholders, and this library uses MySQL session variables to send parameters data.
	To execute such query, another pre-query is sent to the server, like `SET @days=?, @id=?`.
	Parameter names will override session variables with the same names.

	```ts
	// To run this example:
	// export DSN='mysql://root:hello@localhost/tests'
	// deno run --allow-env --allow-net example.ts

	import {MyPool} from './mod.ts';

	await using pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');
	using conn = pool.getConn();

	await conn.queryVoid("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, `time` timestamp, message text)");
	await conn.queryVoid("INSERT INTO t_log SET `time`=Now(), message='Message 1'");

	const row = await conn.query("SELECT `time` + INTERVAL @days DAY AS 'time', message FROM t_log WHERE id=@`id`", {days: 3, id: 1}).first();
	console.log(row);
	```

	### Using external SQL generators

	Another option for parameters substitution is to use libraries that generate SQL.

	Any library that produces SQL queries is alright if it takes into consideration the very important [conn.noBackslashEscapes]{@link MyConn.noBackslashEscapes} flag.
	Remember that the value of this flag can change during server session, if user executes a query like `SET sql_mode='no_backslash_escapes'`.

	Query functions (`query*()`) can receive SQL queries in several forms:

	{@linkcode SqlSource}

	As `string`, `Uint8Array`, `ReadableStream<Uint8Array>` or `ToSqlBytes`.

	Internally strings will be converted to `Uint8Array` anyway, so if your SQL generator can produce `Uint8Array`, it's prefered option.

	The most optimal performance will be achieved if using `ToSqlBytes` type.
	This type exists especially for external SQL generators, to let them add SQL queries right into the internal buffer.

	```ts
	interface ToSqlBytes
	{	toSqlBytesWithParamsBackslashAndBuffer(putParamsTo: unknown[]|undefined, noBackslashEscapes: boolean, buffer: Uint8Array): Uint8Array;
	}
	```

	Any external SQL generator can implement this function. This library will call it with 3 parameters:

	- `putParamsTo` - If an array is passed, the generator is welcome to convert some parameters to `?`-placeholders, and to put the actual value to this array.
	- `noBackslashEscapes` - This library will pass the correct value for this flag, and the generator is kindly asked to respect this value.
	- `buffer` - The generator can use this buffer to store the resulting query, in case the buffer is big enough. If the generator decides not to use this buffer, it can allocate it's own buffer, and return it. If it uses the passed in buffer, it must return a subarray of it.

	Example:

	```ts
	// To run this example:
	// export DSN='mysql://root:hello@localhost/tests'
	// deno run --allow-env --allow-net example.ts

	import {MyPool} from './mod.ts';

	// 1. Define the generator

	const encoder = new TextEncoder;

	// Generates SELECT query for demonstrational purposes only
	class SqlSelectGenerator
	{	constructor(private table: string, private idValue: number)
		{
		}

		toSqlBytesWithParamsBackslashAndBuffer(putParamsTo: unknown[]|undefined, noBackslashEscapes: boolean, buffer: Uint8Array)
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

	await using pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');
	using conn = pool.getConn();

	await conn.query("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, `time` timestamp, message text)");
	await conn.query("INSERT INTO t_log SET `time`=Now(), message='message'");

	const rows = await conn.query<any>(new SqlSelectGenerator('t_log', 1), []).all();
	console.log(rows);
	```

	There're the following external libraries that implement `toSqlBytesWithParamsBackslashAndBuffer()` to optimally support `x/office_spirit_mysql`:

	- [x/polysql]{@link https://deno.land/x/polysql} - Earlier this library was part of this project.

	If you know about another such libraries, or create one, please let me know, and i'll add them to the list.

	## Performance of parameters substitution

	So we have 3 options:
	- Positional parameters
	- Named parameters
	- Text query (produced by an SQL generator)

	Which one works faster?

	The example below shows, that named parameters (session variables with pre-query under the hood) works slightly faster than positional parameters.
	And sending text query works even faster than both.
	However preparing SQL statement once (see [MySQL binary protocol](#mysql-binary-protocol), and then executing it many times is the fastest.

	```ts
	// To run this example:
	// export DSN='mysql://root:hello@localhost/tests'
	// deno run --allow-env --allow-net example.ts

	import {MyPool} from './mod.ts';

	const N_ROWS = 100;
	const N_QUERIES = 800;

	await using pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');
	using conn = pool.getConn();

	// CREATE DATABASE
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
		sum += Number(await conn.queryCol("SELECT val FROM t_log WHERE id = "+n).first());
	}
	console.log(`Text Protocol took ${(Date.now()-since) / 1000} sec (random=${sum})`);

	// Named params
	since = Date.now();
	sum = 0;
	for (let i=0; i<N_QUERIES; i++)
	{	const n = 1 + Math.floor(Math.random() * N_ROWS);
		sum += Number(await conn.queryCol("SELECT val FROM t_log WHERE id = @n", {n}).first());
	}
	console.log(`Named params took ${(Date.now()-since) / 1000} sec (random=${sum})`);

	// Positional params
	since = Date.now();
	sum = 0;
	for (let i=0; i<N_QUERIES; i++)
	{	const n = 1 + Math.floor(Math.random() * N_ROWS);
		sum += Number(await conn.queryCol("SELECT val FROM t_log WHERE id = ?", [n]).first());
	}
	console.log(`Positional params took ${(Date.now()-since) / 1000} sec (random=${sum})`);

	// Positional params prepared once
	since = Date.now();
	sum = 0;
	await using stmt = await conn.prepareCol("SELECT val FROM t_log WHERE id = ?");
	for (let i=0; i<N_QUERIES; i++)
	{	const n = 1 + Math.floor(Math.random() * N_ROWS);
		sum += Number(await stmt.exec([n]).first());
	}
	console.log(`Positional params prepared once took ${(Date.now()-since) / 1000} sec (random=${sum})`);

	// Drop database that i created
	await conn.query("DROP DATABASE test1");
	```

	On my computer i see the following results:

	```
	Begin tests
	Text Protocol took 0.281 sec (random=39308)
	Named params took 0.387 sec (random=38258)
	Positional params took 0.433 sec (random=39652)
	Positional params prepared once took 0.221 sec (random=38693)
	```

	## MySQL binary protocol

	MySQL and MariaDB support 2 ways to execute queries:
	1. **Text Protocol.** SQL where all the parameters are serialized to SQL literals is sent to the server.
	Then the server sends back resultsets, where all values are also strings, and must be converted to target types (information about target types is also sent).
	2. **Binary Protocol.** SQL query is prepared on the server, and then it's possible to execute this query one or many times, referring to the query by it's ID. The query can contain `?`-placeholders. After query execution the server sends resultset in binary form. Later this prepared query must be deallocated.

	The second argument in `conn.query*(sql, params)` functions is called `params`.
	When the `params` argument is specified, even if it's an empty array, the Binary Protocol is used.

	If the `params` is an empty array, and the first argument (sqlSource) implements `ToSqlBytes` interface, then this empty array will be passed to `sqlSource.toSqlBytesWithParamsBackslashAndBuffer()` as the first argument, so the SQL generator can send parameters to the server through binary protocol by adding values to this array and generating `?` in the SQL string (see above about "Using external SQL generators").

	`conn.prepare*()` functions (detailed below) always use the Binary Protocol.

	Not all query types can be run in Binary Protocol - see [here]{@link https://dev.mysql.com/worklog/task/?id=2871} what's supported by MySQL.

	## Prepared statements

	Function `conn.prepare()` prepares an SQL statement, that you can execute multiple times, each time with different parameters.

	{@linkcode MyConn.prepare}

	The returned object must be asynchronously disposed to free the prepared statement on the server.

	```ts
	// To run this example:
	// export DSN='mysql://root:hello@localhost/tests'
	// deno run --allow-env --allow-net example.ts

	import {MyPool} from './mod.ts';
	import {assertEquals} from 'jsr:@std/assert@1.0.7/equals';

	await using pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');
	using conn = pool.getConn();

	// CREATE TABLE
	await conn.query("CREATE TEMPORARY TABLE t_messages (id integer PRIMARY KEY AUTO_INCREMENT, message text)");

	// INSERT
	await using prepared = await conn.prepare("INSERT INTO t_messages SET message=?");
	for (let i=1; i<=3; i++)
	{	await prepared.exec(['Message '+i]);
	}

	// SELECT
	const rows = await conn.query("SELECT * FROM t_messages").all();
	console.log(rows);
	assertEquals
	(	rows,
		[	{id: 1, message: 'Message 1'},
			{id: 2, message: 'Message 2'},
			{id: 3, message: 'Message 3'},
		]
	);
	```

	There's family of functions:

	{@linkcode MyConn.prepareVoid}
	{@linkcode MyConn.prepare}
	{@linkcode MyConn.prepareMap}
	{@linkcode MyConn.prepareArr}
	{@linkcode MyConn.prepareCol}

	The difference between them is the result type that {@link Resultsets.exec()} returns.

	```ts
	Resultsets<Row>.exec(params: any[]): ResultsetsPromise<Row>
	```

	The same functions exist in variant with callbacks. They call your callback with the object that represents the prepared statement, and at the end of the callback they dispose the object.

	{@linkcode MyConn.forPreparedVoid}
	{@linkcode MyConn.forPrepared}
	{@linkcode MyConn.forPreparedMap}
	{@linkcode MyConn.forPreparedArr}
	{@linkcode MyConn.forPreparedCol}

	## Reading long BLOBs

	This library tries to have everything needed in real life usage. It's possible to read long data without storing it in memory.

	```ts
	// To run this example:
	// export DSN='mysql://root:hello@localhost/tests'
	// deno run --allow-env --allow-net example.ts

	import {MyPool} from './mod.ts';

	await using pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');
	using conn = pool.getConn();

	await conn.query("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, `time` timestamp, message text)");
	await conn.query("INSERT INTO t_log SET `time`=Now(), message='long long message'");

	const row = await conn.makeLastColumnReadable("SELECT `time`, message FROM t_log WHERE id=1");
	if (row?.message instanceof ReadableStream)
	{	await row.message.pipeTo(Deno.stdout.writable, {preventClose: true});
	}
	```

	## Writing long BLOBS

	Query parameter values can be of various types, including `ReadableStream<Uint8Array>` (and `Deno.Reader`). If some parameter is such, the parameter value will be read from this reader (without storing the whole BLOB in memory).

	```ts
	// To run this example:
	// export DSN='mysql://root:hello@localhost/tests'
	// deno run --allow-env --allow-net example.ts

	import {MyPool} from './mod.ts';

	await using pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');
	using conn = pool.getConn();

	await conn.queryVoid("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, `time` timestamp, message text)");

	using file = await Deno.open('/etc/passwd', {read: true});
	// Write the file to db
	await conn.queryVoid("INSERT INTO t_log SET `time`=Now(), message=?", [file.readable]);

	// Read the contents back from db
	const row = await conn.makeLastColumnReadable("SELECT `time`, message FROM t_log WHERE id=1");
	if (row?.message instanceof ReadableStream)
	{	await row.message.pipeTo(Deno.stdout.writable, {preventClose: true});
	}
	```

	## Importing big dumps

	Functions like `MyConn.query*()` allow to provide SQL query in several forms, including `ReadableStream<Uint8Array>`.

	```ts
	MyConn.query(sql: SqlSource, params?: object|null): ResultsetsPromise;

	type SqlSource =
		string |
		Uint8Array |
		({readonly readable: ReadableStream<Uint8Array>} | Deno.Reader) & ({readonly size: number} | Deno.Seeker) |
		ToSqlBytes;
	```
	This allows to read SQL from files.

	```ts
	// To run this example:
	// export DSN='mysql://root:hello@localhost/tests'
	// deno run --allow-env --allow-net example.ts

	import {MyPool} from './mod.ts';

	await using pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');
	using conn = pool.getConn();

	const filename = await Deno.makeTempFile();
	try
	{	await Deno.writeTextFile
		(	filename,
			`	CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, c_time timestamp, message text);

				INSERT INTO t_log SET c_time=Now(), message='long long message';
			`
		);

		using file = await Deno.open(filename, {read: true});
		await conn.queriesVoid(file);

		console.log(await conn.query("SELECT c_time, message FROM t_log").all());
	}
	finally
	{	await Deno.remove(filename);
	}
	```

	## LOAD DATA LOCAL INFILE

	If this feature is enabled on your server, you can register a custom handler that will take `LOAD DATA LOCAL INFILE` requests.

	```ts
	// To run this example:
	// export DSN='mysql://root:hello@localhost/tests'
	// deno run --allow-env --allow-net example.ts

	import {MyPool} from './mod.ts';
	import {dirname} from "https://deno.land/std@0.224.0/path/mod.ts";

	await using pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');

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
	const filename = await Deno.makeTempFile();
	const data = await fetch('https://raw.githubusercontent.com/lukes/ISO-3166-Countries-with-Regional-Codes/master/all/all.csv');
	await Deno.writeFile(filename, data.body ?? new Uint8Array);

	using conn = pool.getConn();

	// Create temporary table, load the data to it, and then select it back:

	// CREATE TABLE
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
	```

	## Connection status

	{@link MyConn} object has several status variables:

	- [conn.serverVersion: string]{@link MyConn.serverVersion} - remote server version, as it reports (for example my server reports "8.0.25-0ubuntu0.21.04.1").
	- [conn.connectionId: number]{@link MyConn.connectionId} - thread ID of the connection, that `SHOW PROCESSLIST` shows.
	- [conn.autocommit: boolean]{@link MyConn.autocommit} - true if the connection is currently in autocommit mode. Queries like `SET autocommit=0` will affect this flag.
	- [conn.inTrx: boolean]{@link MyConn.inTrx} - true if a transaction was started. Queries like `START TRANSACTION` and `ROLLBACK` will affect this flag.
	- [conn.inTrxReadonly: boolean]{@link MyConn.inTrxReadonly} - true if a readonly transaction was started. Queries like `START TRANSACTION READ ONLY` and `ROLLBACK` will affect this flag.
	- [conn.noBackslashEscapes: boolean]{@link MyConn.noBackslashEscapes} - true, if the server is configured not to use backslash escapes in string literals. Queries like `SET sql_mode='NO_BACKSLASH_ESCAPES'` will affect this flag.
	- [conn.schema: string]{@link MyConn.schema} - if your server version supports change schema notifications, this will be current default schema (database) name. Queries like `USE new_schema` will affect this value. With old servers this will always remain empty string.

	Initially these variables can be empty. They are set after actual connection to the server, that happens after issuing the first query. Or you can call [await conn.connect()]{@link MyConn.connect}.

	## Resultsets

	`conn.query*()` methods all return {@link Resultsets} object, that contains information about your query result.
	Also this object allows to iterate over rows that the query returned.

	If your query returned multiple resultsets, [conn.queryVoid()]{@link MyConn.queryVoid} skips them, and returns only the status of the last one.

	`conn.query*()` functions except [conn.queryVoid()]{@link MyConn.queryVoid} don't skip resultsets, and [await resultsets.nextResultset()]{@link Resultsets.nextResultset} will advance to the next result, and return true.
	If there are no more resultsets, [await resultsets.nextResultset()]{@link Resultsets.nextResultset} returns false.
	And you must read or discard all the resultsets before being able to issue next queries.

	```ts
	// To run this example:
	// export DSN='mysql://root:hello@localhost/tests'
	// deno run --allow-env --allow-net example.ts

	import {MyPool} from './mod.ts';
	import {assertEquals} from 'jsr:@std/assert@1.0.7/equals';

	await using pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');
	using conn = pool.getConn();

	const resultsets = await conn.queries
	(	`	CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, message text);

			INSERT INTO t_log (message) VALUES ('Message 1'), ('Message 2'), ('Message 3');

			SELECT * FROM t_log;
		`
	);

	assertEquals(resultsets.affectedRows, 0);

	await resultsets.nextResultset();
	assertEquals(resultsets.affectedRows, 3);

	await resultsets.nextResultset();
	assertEquals(resultsets.columns.length, 2);

	for await (const row of resultsets)
	{	console.log(row);
	}
	```

	{@link Resultsets} object has the following properties and methods:

	- `Resultsets.lastInsertId: number|bigint` - In INSERT queries this is last generated AUTO_INCREMENT ID
	- `Resultsets.affectedRows: number|bigint` - In modifying queries, like INSERT, UPDATE and DELETE this shows how many rows were affected by the query
	- `Resultsets.foundRows: number|bigint` - If "foundRows" connection attribute is set, will ask the server to report about "found rows" (matched by the WHERE clause), instead of affected, and "affectedRows" will not be used. See [this page]{@link https://dev.mysql.com/doc/c-api/5.7/en/mysql-affected-rows.html} for more information.
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

	## Changing default schema (database)

	The connection string (DSN) that you provide when ceating a connections pool, can include schema (database) name, and this will be the default schema for all the queries that use not fully qualified table names and names of other various objects (triggers, etc.).

	To change the default schema name during the connection you can issue a `USE schema_name` query.

	This library also provides [conn.use()]{@link MyConn.use} function.

	```ts
	function MyConn.use(schema: string): void;
	```

	This function adds the `USE schema_name` query to pending, and it will be executed together with next most recent query.
	If provided schema name is invalid, the exception will be thrown on the next query.

	If no query follows, the `USE` statement never gets executed (and maybe even no actual database connection will be established, if this was the first command in the connection).

	## SQL logging

	You can use different API functions to execute queries (`conn.query*()`, `conn.prepare*()`, etc.), and some queries are generated internally.
	Also query SQL can be provided in various forms. Not only as string, but even `ReadableStream<Uint8Array>` is possible.
	To understand what's going on in your transaction, it's convenient to have a callback function, that catches all the queries.

	This library allows you to enable SQL logging in specific connection, or session:

	{@linkcode MyConn.setSqlLogger}
	{@linkcode MySession.setSqlLogger}

	By default no SQL is logged. If you set `sqlLogger` to `true`, a default logger will be used, that logs to `Deno.stderr`.

	```ts
	// To run this example:
	// export DSN='mysql://root:hello@localhost/tests'
	// deno run --allow-env --allow-net example.ts

	import {MyPool} from './mod.ts';
	import {assertEquals} from 'jsr:@std/assert@1.0.7/equals';

	await using pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');
	using conn = pool.getConn();

	// Enable SQL logger
	conn.setSqlLogger(true);

	// CREATE DATABASE
	await conn.query("DROP DATABASE IF EXISTS test1");
	await conn.query("CREATE DATABASE `test1`");

	// USE
	conn.use("test1");

	// CREATE TABLE
	await conn.query("CREATE TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, message text)");

	// INSERT
	await conn.query("INSERT INTO t_log SET message = 'Message 1'");

	const result = await conn.queryCol("SELECT message FROM t_log WHERE id = @n", {n: 1}).first();

	// Drop database that i created
	await conn.query("DROP DATABASE test1");

	assertEquals(result, 'Message 1');
	```

	![image](./readme-assets/sql-logger-1.png)

	The default logger truncates long queries to maximum 10,000 bytes, and long query parameters to 3,000 bytes.
	Also it shows no more than 100 lines of each query SQL.

	This library allows you to provide your own custom logger.
	This can be any object that implements {@link SqlLogger} interface:

	```ts
	interface SqlLogger
	{	// A new connection established.
		connect?: (dsn: Dsn, connectionId: number) => Promise<unknown>;

		// Connection state reset (before returning this connection to it's pool).
		resetConnection?: (dsn: Dsn, connectionId: number) => Promise<unknown>;

		// Disconnected.
		disconnect?: (dsn: Dsn, connectionId: number) => Promise<unknown>;

		// Started to send a new query to the server.
		// `isPrepare` means that this is query preparation operation (the query is not executed, but stored on the server).
		// This function can return object that implements `SqlLoggerQuery` for further logging the query process.
		// Query SQL (if any) will be handed to the methods of `SqlLoggerQuery`.
		query?: (dsn: Dsn, connectionId: number, isPrepare: boolean, noBackslashEscapes: boolean) => Promise<SqlLoggerQuery | undefined>;

		// Deallocated prepared query or multiple queries indentified by their `stmtIds`.
		deallocatePrepare?: (dsn: Dsn, connectionId: number, stmtIds: number[]) => Promise<unknown>;

		// This callback is called when current `MyConn` object is disposed of. This happens at the end of `MyPool.forConn()`, or at the end of a block with `using conn = ...`.
		dispose?: () => Promise<unknown>;
	}

	// 1. In the beginning one of `appendToQuery()` or `setStmtId()` is called.
	// To start writing a regular query, `appendToQuery()` is called one or multiple times.
	// To write a prepared query, `setStmtId()` is called (once).
	// 2. Then, in case of prepared query, a sequence of `appendToParam()` (one or multiple times) and `paramEnd()` can be called.
	// 3. Then, if writing queries batch, `nextQuery()` is called, and the process repeats from the beginning.
	// 4. Then, after all the queries in batch are written, `start()` is called. At this point queries are sent to the database server.
	// 5. Then, when the server responds, `end()` is called.
	interface SqlLoggerQuery
	{	appendToQuery?: (data: Uint8Array) => Promise<unknown>;

		setStmtId?: (stmtId: number) => Promise<unknown>;

		appendToParam?: (nParam: number, data: Uint8Array|number|bigint) => Promise<unknown>;

		paramEnd?: (nParam: number) => Promise<unknown>;

		nextQuery?: () => Promise<unknown>;

		start?: () => Promise<unknown>;

		// If this was query preparation (`SqlLogger.query(_, _, true)`), `stmtId` will be the statement ID that the server returned.
		// Else `stmtId` will be `-1`.
		end?: (result: Resultsets<unknown>|Error|undefined, stmtId: number) => Promise<unknown>;
	}
	```

	This library provides a base class called {@link SqlLogToWritable} that you can use to implement a logger that logs to any `WritableStream<Uint8Array>` or `Deno.Writer`.

	The default logger (that is used if you specify `sqlLogger == true`) is also implemented through {@link SqlLogToWritable}:

	```ts
	conn.setSqlLogger(true);

	// Is the same as:

	conn.setSqlLogger(new SqlLogToWritable(Deno.stderr, !Deno.noColor, 10_000, 3_000, 100));
	```

	Here is how to subclass `SqlLogToWritable` to log to a file:

	```ts
	// To run this example:
	// export DSN='mysql://root:hello@localhost/tests'
	// deno run --allow-env --allow-net --allow-write example.ts

	import {MyPool, SqlLogToWritable} from './mod.ts';
	import {assertEquals} from 'jsr:@std/assert@1.0.7/equals';

	await using pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');

	const LOG_FILE = '/tmp/sql.log';

	class SqlLogToFile extends SqlLogToWritable
	{	protected disposable: Disposable;

		private constructor(fileLike: {readonly writable: WritableStream<Uint8Array>} & Disposable, withColor=false)
		{	super(fileLike.writable, withColor);
			this.disposable = fileLike;
		}

		static async inst(path: string|URL, withColor=false)
		{	const fd = await Deno.open(path, {write: true, create: true, truncate: true});
			return new SqlLogToFile(fd, withColor);
		}

		async dispose()
		{	try
			{	await super.dispose();
			}
			finally
			{	this.disposable[Symbol.dispose]();
			}
		}
	}

	using conn = pool.getConn();

	// Enable SQL logger
	conn.setSqlLogger(await SqlLogToFile.inst(LOG_FILE, !Deno.noColor));

	// CREATE DATABASE
	await conn.query("DROP DATABASE IF EXISTS test1");
	await conn.query("CREATE DATABASE `test1`");

	// USE
	conn.use("test1");

	// CREATE TABLE
	await conn.query("CREATE TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, message text)");

	// INSERT
	await conn.query("INSERT INTO t_log SET message = 'Message 1'");

	const result = await conn.queryCol("SELECT message FROM t_log WHERE id = @n", {n: 1}).first();

	// Drop database that i created
	await conn.query("DROP DATABASE test1");

	assertEquals(result, 'Message 1');
	console.log(`See log in ${LOG_FILE}`);
	```

	To view the color-highlighted file we can do:

	```bash
	less -r /tmp/sql.log
	```

	You can see [here]{@link https://github.com/jeremiah-shaulov/office_spirit_mysql/blob/v0.19.14/private/sql_log_to_writable.ts} how {@link SqlLogToWritable} class is implemented,
	and you can override it's public and protected methods to customize it's behavior.

	## Transactions

	{@link MyConn} class has the following functions to work with transactions:

	```ts
	// Commit current transaction (if any), and start new.
	// This is lazy operation. The corresponding command will be sent to the server later (however commit of the current transaction will happen immediately).
	// To start regular transaction, call `startTrx()` without parameters.
	// To start READONLY transaction, pass `{readonly: true}`.
	// To start distributed transaction, pass `{xaId: '...'}`.
	// If you want `conn.connectionId` to be automatically appended to XA identifier, pass `{xaId1: '...'}`, where `xaId1` is the first part of the `xaId`.
	// If connection to server was not yet established, the `conn.connectionId` is not known (and `startTrx()` will not connect), so `conn.connectionId` will be appended later on first query.
	MyConn.startTrx(options?: {readonly?: boolean, xaId?: string, xaId1?: string}): Promise<void>;

	// Creates transaction savepoint, and returns ID number of this new savepoint.
	// Then you can call `conn.rollback(pointId)`.
	// This is lazy operation. The corresponding command will be sent to the server later.
	// Calling `savepoint()` immediately followed by `rollback(pointId)` to this point will send no commands.
	MyConn.savepoint(): number;

	// If the current transaction is of distributed type, this function prepares the 2-phase commit.
	// Else does nothing.
	// If this function succeeds, the transaction will be saved on the server till you call `commit()`.
	// The saved transaction can survive server restart and unexpected halt.
	// You need to commit it as soon as possible, to release all the locks that it holds.
	// Usually, you want to prepare transactions on all servers, and immediately commit them if `prepareCommit()` succeeded, or rollback them if it failed.
	MyConn.prepareCommit(): Promise<void>;

	// Rollback to a savepoint, or all.
	// If `toPointId` is not given or undefined - rolls back the whole transaction (XA transactions can be rolled back before `prepareCommit()` called, or after that).
	// If `toPointId` is a number returned from `savepoint()` call, rolls back to that point (also works with XAs).
	// If `toPointId` is `0`, rolls back to the beginning of transaction, and doesn't end this transaction (doesn't work with XAs).
	// If rollback (not to savepoint) failed, will disconnect from server and throw ServerDisconnectedError.
	// If `toPointId` was `0` (not for XAs), the transaction will be restarted after the disconnect if rollback failed.
	MyConn.rollback(toPointId?: number): Promise<void>;

	// Commit.
	// If the current transaction is XA, and you didn't call `prepareCommit()` i'll throw error.
	// With `andChain` parameter will commit and then restart the same transaction (doesn't work with XAs).
	// If commit fails will rollback and throw error. If rollback also fails, will disconnect from server and throw ServerDisconnectedError.
	MyConn.commit(andChain=false): Promise<void>;
	```

	To start a regular transaction call {@link MyConn.startTrx()} without parameters. Then you can create savepoints, rollback to a savepoint, or rollback the whole transaction, or commit.

	```ts
	// To run this example:
	// export DSN='mysql://root:hello@localhost/tests'
	// deno run --allow-env --allow-net example.ts

	import {MyPool} from './mod.ts';

	await using pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');
	using conn = pool.getConn();

	// CREATE DATABASE
	await conn.query("DROP DATABASE IF EXISTS test1");
	await conn.query("CREATE DATABASE `test1`");

	// USE
	conn.use("test1");

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

	If you specify `xaId1`, the XA ID will consist of 2 parts: the string you provided (`xaId1`) and [conn.connectionId]{@link MyConn.connectionId} (the latter may be not known at this point if there's no connection to the server yet, so it will be appended later).

	Transaction-related functions are also present in {@link MySession} object.
	If you start a transaction on the session level, all the connections in this session will have this transaction, and when you ask new connections, the current transaction with all the savepoints will be started there automatically.

	```ts
	// Commit current transaction (if any), and start new.
	// If there're active transactions, they will be properly (2-phase if needed) committed.
	// Then new transaction will be started on all connections in this session.
	// If then you'll ask a new connection, it will join the transaction.
	// If commit fails, this function does rollback, and throws the Error.
	function MySession.startTrx(options?: {readonly?: boolean, xa?: boolean}): Promise<void>;

	// Create session-level savepoint, and return it's ID number.
	// Then you can call `session.rollback(pointId)`.
	// This is lazy operation. The corresponding command will be sent to the server later.
	// Calling `savepoint()` immediately followed by `rollback(pointId)` to this point will send no commands.
	// Using `MySession.savepoint()` doesn't interfere with `MyConn.savepoint()`, so it's possible to use both.
	function MySession.savepoint(): number;

	// Rollback all the active transactions in this session.
	// If `toPointId` is not given or undefined - rolls back the whole transaction.
	// If `toPointId` is a number returned from `savepoint()` call, rolls back all the transactions to that point.
	// If `toPointId` is `0`, rolls back to the beginning of transaction, and doesn't end this transaction (also works with XAs).
	// If rollback (not to savepoint) failed, will disconnect from server and throw ServerDisconnectedError.
	// If `toPointId` was `0`, the transaction will be restarted after the disconnect if rollback failed.
	function MySession.rollback(toPointId?: number): Promise<void>;

	// Commit all the active transactions in this session.
	// If the session transaction was started with `{xa: true}`, will do 2-phase commit.
	// If failed will rollback. If failed and `andChain` was true, will rollback and restart the same transaction (also XA).
	// If rollback failed, will disconnect (and restart the transaction in case of `andChain`).
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

	[Read more about distributed transactions]{@link https://dev.mysql.com/doc/refman/8.0/en/xa.html}.

	Some kind of transactions manager is needed when working with distributed transactions.

	This library provides transactions manager that you can use, or you can use your own one.

	When calling `MyConn.startTrx()` on a connection, this creates non-managed transaction. To use the distributed transactions manager, you need to:

	- create session (`pool.getSession()`), and call `MySession.startTrx({xa: true})` on session object
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
	import {MyPool, Dsn} from './mod.ts';

	const dsn1 = new Dsn('mysql://app:app@localhost/test1');
	const dsn2 = new Dsn('mysql://app:app@localhost/test2');

	await using pool = new MyPool
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

	// Start session
	using session = pool.getSession();

	// Enable SQL logger
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
	```

	When you start a managed transaction (`MySession.startTrx({xa: true})`), the manager generates XA ID for it.
	This ID encodes in itself several pieces of data: timestamp of when the transaction started, `Deno.pid` of the application that started the transaction, ID of chosen info table, and MySQL connection ID.

	When you call [session.commit()]{@link MySession.commit}, the 2-phase commit takes place on all the connections in this session.
	After the 1st phase succeeded, current XA ID is inserted to the chosen info table (in parallel connection in autocommit mode).
	And after successful 2nd phase, this record is deleted from the info table.

	Transactions manager periodically monitors `managedXaDsns` for dangling transactions - those whose MySQL connection is dead.
	If a dangling transaction found, it's either committed or rolled back.
	If a corresponding record is found in the corresponding info table, the transaction will be committed.
	If no record found, or there were no info tables, the transaction will be rolled back.
	If you want the transactions manager to always roll back transactions in such situation, don't provide info tables to the pool options.

	@module
	@summary office_spirit_mysql - MySQL and MariaDB driver for Deno.
 **/

export {MyPool, type PoolStatus} from './private/my_pool.ts';
export type {MyPoolOptions} from './private/my_pool.ts';
export {MySession} from './private/my_session.ts';
export {Dsn} from './private/dsn.ts';
export {MyConn, type DisconnectStatus} from './private/my_conn.ts';
export {ResultsetsPromise, Resultsets, Column} from './private/resultsets.ts';
export type {ColumnValue, JsonNode, Params} from './private/resultsets.ts';
export {Charset, MysqlType, ColumnFlags, ErrorCodes} from './private/constants.ts';
export type {SqlSource} from './private/my_protocol_reader_writer.ts';
export {SqlError, ServerDisconnectedError, BusyError, CanceledError, CanRetry} from './private/errors.ts';
export type {SqlLogger} from './private/sql_logger.ts';
export {SqlLogToWritable, SqlLogToWriter} from './private/sql_log_to_writable.ts';
