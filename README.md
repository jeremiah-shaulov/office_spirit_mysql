<!--
	This file is generated with the following command:
	deno run --allow-all https://raw.githubusercontent.com/jeremiah-shaulov/tsa/v0.0.50/tsa.ts doc-md --outFile=README.md --outUrl=https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/v0.21.0/README.md --importUrl=https://deno.land/x/office_spirit_mysql@v0.21.0/mod.ts mod.ts
-->

# office_spirit_mysql - MySQL and MariaDB driver for Deno.

[Documentation Index](generated-doc/README.md)

MySQL and MariaDB driver for Deno. Tested on: MySQL 5.6, 5.7, 8.0, 9.0, MariaDB 5.5, 10.0, 10.2, 10.5, 10.7, 11.5.

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
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/v0.21.0/README.md' | perl -ne 's/^> //; $y=$1 if /^```(.)?/; print $_ if $y&&$m; $m=$y&&$m+/<example-p9mn>/' > /tmp/example-p9mn.ts
// deno run --allow-env --allow-net /tmp/example-p9mn.ts

import {MyPool} from 'https://deno.land/x/office_spirit_mysql@v0.21.0/mod.ts';

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

Table of contents:

- [Connections pool](#connections-pool)
- [Connections](#connections)
- [Cross-server sessions](#cross-server-sessions)
- [Executing queries](#executing-queries)
- [Executing multiple statements in a single query](#executing-multiple-statements-in-a-single-query)
- [Type conversions](#type-conversions)
- [Timezone](#timezone)
- [Query parameters](#query-parameters)
- [Performance of parameters substitution](#performance-of-parameters-substitution)
- [MySQL binary protocol](#mysql-binary-protocol)
- [Prepared statements](#prepared-statements)
- [Reading long BLOBs](#reading-long-blobs)
- [Writing long BLOBS](#writing-long-blobs)
- [Importing big dumps](#importing-big-dumps)
- [LOAD DATA LOCAL INFILE](#load-data-local-infile)
- [Connection status](#connection-status)
- [Resultsets](#resultsets)
- [Changing default schema (database)](#changing-default-schema-database)
- [SQL logging](#sql-logging)
- [Transactions](#transactions)
- [Distributed (aka global) transactions](#distributed-aka-global-transactions)
- [Interrupting long queries](#interrupting-long-queries)
- [Pool health status](#pool-health-status)

## Connections pool

Connections to database servers are managed by [MyPool](generated-doc/class.MyPool/README.md) object.
You need to create one such object, and ask it to give you a free connection.
Most applications don't need more than one pool, but you can also have several pools, each one with different configuration.

> 🔧 MyPool.[constructor](generated-doc/class.MyPool/README.md#-constructoroptions-dsn--string--mypooloptions)(options?: [Dsn](generated-doc/class.Dsn/README.md) | `string` | [MyPoolOptions](generated-doc/interface.MyPoolOptions/README.md))

When you create a [MyPool](generated-doc/class.MyPool/README.md) instance, you can give it a default DSN (Data Source Name), that will be used if the DSN is not specified when requesting a new connection.
You can provide the DSN as a string or as [Dsn](generated-doc/class.Dsn/README.md) object, that contains parsed string.

Or you can specify more options:

> `interface` MyPoolOptions<br>
> {<br>
> &nbsp; &nbsp; 📄 [dsn](generated-doc/interface.MyPoolOptions/README.md#-dsn-dsn--string)?: [Dsn](generated-doc/class.Dsn/README.md) | `string`<br>
> &nbsp; &nbsp; 📄 [maxConnsWaitQueue](generated-doc/interface.MyPoolOptions/README.md#-maxconnswaitqueue-number)?: `number`<br>
> &nbsp; &nbsp; 📄 [onLoadFile](generated-doc/interface.MyPoolOptions/README.md#-onloadfile-onloadfile)?: [OnLoadFile](generated-doc/type.OnLoadFile/README.md)<br>
> &nbsp; &nbsp; 📄 [onBeforeCommit](generated-doc/interface.MyPoolOptions/README.md#-onbeforecommit-onbeforecommit)?: [OnBeforeCommit](generated-doc/type.OnBeforeCommit/README.md)<br>
> &nbsp; &nbsp; 📄 [managedXaDsns](generated-doc/interface.MyPoolOptions/README.md#-managedxadsns-dsn--string--dsn--string)?: [Dsn](generated-doc/class.Dsn/README.md) | `string` | ([Dsn](generated-doc/class.Dsn/README.md) | `string`)\[]<br>
> &nbsp; &nbsp; 📄 [xaCheckEach](generated-doc/interface.MyPoolOptions/README.md#-xacheckeach-number)?: `number`<br>
> &nbsp; &nbsp; 📄 [logger](generated-doc/interface.MyPoolOptions/README.md#-logger-logger)?: [Logger](generated-doc/interface.Logger/README.md)<br>
> }

- `dsn` - Default Data Source Name for this pool.
- `maxConnsWaitQueue` - (number, default 50) When `maxConns` exceeded, new connection requests will enter waiting queue (like backlog). This is the queue maximum size.
- `onLoadFile` - Handler for `LOAD DATA LOCAL INFILE` query.
- `onBeforeCommit` - Callback that will be called every time a transaction is about to be committed.
- `managedXaDsns` - Will automatically manage distributed transactions on DSNs listed here (will rollback or commit dangling transactions).
- `xaCheckEach` - (number, default `6000`) Check for dangling transactions each this number of milliseconds.
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
- `maxColumnLen` (number, default `10MiB`) bytes - if a column was longer, it's value is skipped, and it will be returned as NULL (this doesn't apply to [conn.makeLastColumnReadable()](generated-doc/class.MyConn/README.md#-makelastcolumnreadablecolumntypecolumnvaluesql-sqlsource-params-params-promiseany) - see below)
- `foundRows` (boolean, default `false`) - if present, will use "found rows" instead of "affected rows" in resultsets (see [here](https://dev.mysql.com/doc/refman/8.0/en/information-functions.html#function_row-count) how CLIENT_FOUND_ROWS flag affects result of `Row_count()` function)
- `ignoreSpace` (boolean, default `false`) - if present, parser on server side can ignore spaces before '(' in built-in function names (see description [here](https://dev.mysql.com/doc/refman/8.0/en/sql-mode.html#sqlmode_ignore_space))
- `retryLockWaitTimeout` (boolean, default `false`) - if set, and `retryQueryTimes` is also set, will retry query that failed with "lock wait timeout" error. The query will be retried `retryQueryTimes` times.
- `retryQueryTimes` - (number, default `0`) Automatically reissue queries this number of attempts, if error was "deadlock" in autocommit mode, or (if `retryLockWaitTimeout` was set) "lock wait timeout" in both modes. Please note, that this will also rerun queries like `CALL`.
- `datesAsString` (boolean, default `false`) - if present, date, datetime and timestamp columns will not be converted to `Date` objects when selected from MySQL, so they'll be returned as strings
- `correctDates` (boolean, default `false`) - enables timezone correction when converting between Javascript `Date` objects and MySQL date, datetime and timestamp types. This feature is supported on MySQL 5.7+, and MariaDB 10.3+.
- `storeResultsetIfBigger` (number, default 64KiB) - when using `Resultsets.allStored()` and the resultset is bigger than this number of bytes, it will be stored on disk, rather than in RAM (array).

The DSN can contain `#` sign followed by SQL statement or several statements separated with semicolons.
This SQL will be executed before first query in each connection.

## Connections

A new connection from connections pool can be asked with [pool.getConn()](generated-doc/class.MyPool/README.md#-getconndsn-dsn--string-myconn) function:

> ⚙ MyPool.[getConn](generated-doc/class.MyPool/README.md#-getconndsn-dsn--string-myconn)(dsn?: [Dsn](generated-doc/class.Dsn/README.md) | `string`): [MyConn](generated-doc/class.MyConn/README.md)

If `dsn` is not provided, the default DSN of the pool will be used. You can provide different `dsn` to ask a connection to different server.

The returned [MyConn](generated-doc/class.MyConn/README.md) object is disposable. Usually you will want to bind it to an owned variable through `using` keyword.
When [conn\[Symbol.dispose\]()](generated-doc/class.MyConn/README.md#-symboldispose-void) is called, the connection comes back to it's pool.

Another way of using connections is by calling [pool.forConn()](generated-doc/class.MyPool/README.md#-forconntcallback-conn-myconn--promiset-dsn-dsn--string-promiset) giving it an async callback, and the connection can be used within this callback, and when it returns the connection will be returned to the pool.

> ⚙ MyPool.[forConn](generated-doc/class.MyPool/README.md#-forconntcallback-conn-myconn--promiset-dsn-dsn--string-promiset)\<T>(callback: (conn: [MyConn](generated-doc/class.MyConn/README.md)) => Promise\<T>, dsn?: [Dsn](generated-doc/class.Dsn/README.md) | `string`): Promise\<T>

The following is essentially the same:

```ts
import {MyPool} from 'https://deno.land/x/office_spirit_mysql@v0.21.0/mod.ts';

await using pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');
using conn = pool.getConn();
const version = await conn.queryCol("SELECT Version()").first();
console.log(version);
```
And:
```ts
import {MyPool} from 'https://deno.land/x/office_spirit_mysql@v0.21.0/mod.ts';

await using pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');
const version = await pool.forConn
(	async conn =>
	{	const version = await conn.queryCol("SELECT Version()").first();
		return version;
	}
);
console.log(version);
```

If the promise that [pool.forConn()](generated-doc/class.MyPool/README.md#-forconntcallback-conn-myconn--promiset-dsn-dsn--string-promiset) returns is not explicitly awaited for, it will be awaited for when the pool is disposed, so the following is also equivalent:
```ts
import {MyPool} from 'https://deno.land/x/office_spirit_mysql@v0.21.0/mod.ts';

await using pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');
pool.forConn
(	async conn =>
	{	const version = await conn.queryCol("SELECT Version()").first();
		console.log(version);
	}
);
```

Before the connection is returned to the pool, its state is reset. This means that incomplete transactions are rolled back, and all kind of locks are cleared.
Then this connection can be idle in the pool for at most [keepAliveTimeout](generated-doc/class.Dsn/README.md#-accessor-keepalivetimeout-number) milliseconds, and if nobody was interested in it during this period, it will be terminated.
If somebody killed a connection while it was idle in the pool, and you asked to use this connection again, the first query on this connection can fail.
If this happens, another connection will be tried, and your query will be reissued. This process is transparent to you.

In the beginning of `callback`, the `conn` is not connected to the server. It will connect on first requested query.
To force connection call [await conn.connect()](generated-doc/class.MyConn/README.md#-connect-promisevoid).

If server is busy ("too many connections", "server shutdown in progress", etc.), the connection will be retried during the period of [connectionTimeout](generated-doc/class.Dsn/README.md#-accessor-connectiontimeout-number) milliseconds (specified in the DSN parameters).
During this period the connection will be retried each [reconnectInterval](generated-doc/class.Dsn/README.md#-accessor-reconnectinterval-number) milliseconds.
There will be only one retrying connection. Till it's resolved new connections will be tried once, and if not successful they will enter waiting queue.

If `maxConns` number of connections in pool reached, a new connection will enter waiting queue without trying to connect.

If there was no free slot during the [connectionTimeout](generated-doc/class.Dsn/README.md#-accessor-connectiontimeout-number) period, or if the waiting queue is full ([maxConnsWaitQueue](generated-doc/interface.MyPoolOptions/README.md#-maxconnswaitqueue-number) items long), exception is thrown.

## Cross-server sessions

If you want to deal with multiple simultaneous connections, you can call [pool.getSession()](generated-doc/class.MyPool/README.md#-getsession-mysession) to start a cross-server session.

> ⚙ MyPool.[getSession](generated-doc/class.MyPool/README.md#-getsession-mysession)(): [MySession](generated-doc/class.MySession/README.md)

The returned [MySession](generated-doc/class.MySession/README.md) object is disposable. Usually you will want to bind it to an owned variable through `using` keyword.
When [session\[Symbol.dispose\]()](generated-doc/class.MySession/README.md#-symboldispose-void) is called, all the connections in this session are disposed.

Another way of using sessions is by calling [pool.forSession()](generated-doc/class.MyPool/README.md#-forsessiontcallback-session-mysession--promiset-promiset) giving it an async callback, and the session can be used within this callback.

> ⚙ MyPool.[forSession](generated-doc/class.MyPool/README.md#-forsessiontcallback-session-mysession--promiset-promiset)\<T>(callback: (session: [MySession](generated-doc/class.MySession/README.md)) => Promise\<T>): Promise\<T>

During this session you can call [session.conn()](generated-doc/class.MySession/README.md#-conndsn-dsn--string-fresh-booleanfalse-myconn) to get a connection. At the end of callback all the connections will return to the pool, if they didn't before.

> ⚙ MySession.[conn](generated-doc/class.MySession/README.md#-conndsn-dsn--string-fresh-booleanfalse-myconn)(dsn?: [Dsn](generated-doc/class.Dsn/README.md) | `string`, fresh: `boolean`=false): [MyConn](generated-doc/class.MyConn/README.md)

`MySession.conn()` returns the connection object ([MyConn](generated-doc/class.MyConn/README.md)) immediately, but actual connection will be established on first SQL query.

With `true` second argument, always new connection is returned. Otherwise, if there's already an active connection to the same DSN in this session, it will be picked up.

```ts
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/v0.21.0/README.md' | perl -ne 's/^> //; $y=$1 if /^```(.)?/; print $_ if $y&&$m; $m=$y&&$m+/<example-65ya>/' > /tmp/example-65ya.ts
// deno run --allow-env --allow-net /tmp/example-65ya.ts

import {MyPool, Dsn} from 'https://deno.land/x/office_spirit_mysql@v0.21.0/mod.ts';
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
At the end of callback all active connections will be returned to the pool. However you can call [conn.end()](generated-doc/class.MyConn/README.md#-end-void) to free a connection earlier.

## Executing queries

To run a query that doesn't return rows, use [queryVoid()](generated-doc/class.MyConn/README.md#-queryvoidsql-sqlsource-params-params-promiseresultsetsvoid):

> ⚙ MyConn.[queryVoid](generated-doc/class.MyConn/README.md#-queryvoidsql-sqlsource-params-params-promiseresultsetsvoid)(sql: [SqlSource](generated-doc/type.SqlSource/README.md), params?: [Params](generated-doc/type.Params/README.md)): Promise\<[Resultsets](generated-doc/class.Resultsets/README.md)\<`void`>>

This method executes it's query and discards returned rows.
Returned `Resultsets` object contains `lastInsertId`, `affectedRows`, and more such information about the query.
If there were multiple resultsets, it will contain only information about the last one.

To run a query, and read it's rows, use one of the following methods:

> ⚙ MyConn.[query](generated-doc/class.MyConn/README.md#-querycolumntypecolumnvaluesql-sqlsource-params-params-resultsetspromiserecord)\<ColumnType=[ColumnValue](generated-doc/type.ColumnValue/README.md)>(sql: [SqlSource](generated-doc/type.SqlSource/README.md), params?: [Params](generated-doc/type.Params/README.md)): [ResultsetsPromise](generated-doc/class.ResultsetsPromise/README.md)\<Record><br>
> ⚙ MyConn.[queryMap](generated-doc/class.MyConn/README.md#-querymapcolumntypecolumnvaluesql-sqlsource-params-params-resultsetspromisemapstring-columntype)\<ColumnType=[ColumnValue](generated-doc/type.ColumnValue/README.md)>(sql: [SqlSource](generated-doc/type.SqlSource/README.md), params?: [Params](generated-doc/type.Params/README.md)): [ResultsetsPromise](generated-doc/class.ResultsetsPromise/README.md)\<Map\<`string`, ColumnType>><br>
> ⚙ MyConn.[queryArr](generated-doc/class.MyConn/README.md#-queryarrcolumntypecolumnvaluesql-sqlsource-params-params-resultsetspromisecolumntype)\<ColumnType=[ColumnValue](generated-doc/type.ColumnValue/README.md)>(sql: [SqlSource](generated-doc/type.SqlSource/README.md), params?: [Params](generated-doc/type.Params/README.md)): [ResultsetsPromise](generated-doc/class.ResultsetsPromise/README.md)\<ColumnType\[]><br>
> ⚙ MyConn.[queryCol](generated-doc/class.MyConn/README.md#-querycolcolumntypecolumnvaluesql-sqlsource-params-params-resultsetspromisecolumntype)\<ColumnType=[ColumnValue](generated-doc/type.ColumnValue/README.md)>(sql: [SqlSource](generated-doc/type.SqlSource/README.md), params?: [Params](generated-doc/type.Params/README.md)): [ResultsetsPromise](generated-doc/class.ResultsetsPromise/README.md)\<ColumnType>

These `query*` methods return [ResultsetsPromise](generated-doc/class.ResultsetsPromise/README.md) which is subclass of `Promise<Resultsets>`.
Awaiting it gives you [Resultsets](generated-doc/class.Resultsets/README.md) object.
Iterating over [ResultsetsPromise](generated-doc/class.ResultsetsPromise/README.md) or [Resultsets](generated-doc/class.Resultsets/README.md) yields rows.

If your query didn't return rows (query like `INSERT`), then these methods work exactly as [queryVoid()](generated-doc/class.MyConn/README.md#-queryvoidsql-sqlsource-params-params-promiseresultsetsvoid), so zero rows will be yielded, and [resultsets.columns](generated-doc/class.Resultsets/README.md#-columns-column) will be empty array,
and [resultsets.lastInsertId](generated-doc/class.Resultsets/README.md#-lastinsertid-number--bigint) and [resultsets.affectedRows](generated-doc/class.Resultsets/README.md#-affectedrows-number--bigint) will show relevant information.

If there're rows, you need to iterate them to the end, before you can execute another query.
Executing another query while there're unread resultsets throws [BusyError](generated-doc/class.BusyError/README.md).
You can read all the rows with [Resultsets.all()](generated-doc/class.Resultsets/README.md#-all-promiserow), [ResultsetsPromise.all()](generated-doc/class.ResultsetsPromise/README.md#-all-promiserow), [Resultsets.allStored()](generated-doc/class.Resultsets/README.md#-allstored-asynciterablerow-any-any) or [ResultsetsPromise.allStored()](generated-doc/class.ResultsetsPromise/README.md#-allstored-asynciterablerow-any-any).

```ts
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/v0.21.0/README.md' | perl -ne 's/^> //; $y=$1 if /^```(.)?/; print $_ if $y&&$m; $m=$y&&$m+/<example-pf4z>/' > /tmp/example-pf4z.ts
// deno run --allow-env --allow-net /tmp/example-pf4z.ts

import {MyPool} from 'https://deno.land/x/office_spirit_mysql@v0.21.0/mod.ts';

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

If your query returns single row, you can read it with [Resultsets.first()](generated-doc/class.Resultsets/README.md#-first-promiserow) or [ResultsetsPromise.first()](generated-doc/class.ResultsetsPromise/README.md#-first-promiseany).
It returns the first row itself, not an array of rows.
And it skips all further rows, if they exist.

```ts
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/v0.21.0/README.md' | perl -ne 's/^> //; $y=$1 if /^```(.)?/; print $_ if $y&&$m; $m=$y&&$m+/<example-ksv8>/' > /tmp/example-ksv8.ts
// deno run --allow-env --allow-net /tmp/example-ksv8.ts

import {MyPool} from 'https://deno.land/x/office_spirit_mysql@v0.21.0/mod.ts';

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

You can iterate the resultset ([ResultsetsPromise](generated-doc/class.ResultsetsPromise/README.md) or [Resultsets](generated-doc/class.Resultsets/README.md)) with `for await` loop, or you can call [ResultsetsPromise.forEach()](generated-doc/class.ResultsetsPromise/README.md#-foreachtcallback-row-row--t--promiset-promiset) or [Resultsets.forEach()](generated-doc/class.Resultsets/README.md#-foreachtcallback-row-row--t--promiset-promiset) method.

> ⚙ ResultsetsPromise.[forEach](generated-doc/class.ResultsetsPromise/README.md#-foreachtcallback-row-row--t--promiset-promiset)\<T>(callback: (row: Row) => T | Promise\<T>): Promise\<T>

```ts
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/v0.21.0/README.md' | perl -ne 's/^> //; $y=$1 if /^```(.)?/; print $_ if $y&&$m; $m=$y&&$m+/<example-rlut>/' > /tmp/example-rlut.ts
// deno run --allow-env --allow-net /tmp/example-rlut.ts

import {MyPool} from 'https://deno.land/x/office_spirit_mysql@v0.21.0/mod.ts';

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

- [MyConn.query()](generated-doc/class.MyConn/README.md#-querycolumntypecolumnvaluesql-sqlsource-params-params-resultsetspromiserecord) method iterates over rows as Javascript default objects with fields.
- [MyConn.queryMap()](generated-doc/class.MyConn/README.md#-querymapcolumntypecolumnvaluesql-sqlsource-params-params-resultsetspromisemapstring-columntype) method iterates over rows as `Map` objects.
- [MyConn.queryArr()](generated-doc/class.MyConn/README.md#-queryarrcolumntypecolumnvaluesql-sqlsource-params-params-resultsetspromisecolumntype) method iterates over rows as `Array`s with column values without column names.
- [MyConn.queryCol()](generated-doc/class.MyConn/README.md#-querycolcolumntypecolumnvaluesql-sqlsource-params-params-resultsetspromisecolumntype) method iterates over first column values of each row.

For example, using `queryCol().first()` you can get the result of `SELECT Count(*)` as a single number value:

```ts
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/v0.21.0/README.md' | perl -ne 's/^> //; $y=$1 if /^```(.)?/; print $_ if $y&&$m; $m=$y&&$m+/<example-ajdy>/' > /tmp/example-ajdy.ts
// deno run --allow-env --allow-net /tmp/example-ajdy.ts

import {MyPool} from 'https://deno.land/x/office_spirit_mysql@v0.21.0/mod.ts';
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
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/v0.21.0/README.md' | perl -ne 's/^> //; $y=$1 if /^```(.)?/; print $_ if $y&&$m; $m=$y&&$m+/<example-7bvr>/' > /tmp/example-7bvr.ts
// deno run --allow-env --allow-net /tmp/example-7bvr.ts

import {MyPool, ColumnValue} from 'https://deno.land/x/office_spirit_mysql@v0.21.0/mod.ts';
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
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/v0.21.0/README.md' | perl -ne 's/^> //; $y=$1 if /^```(.)?/; print $_ if $y&&$m; $m=$y&&$m+/<example-dbu0>/' > /tmp/example-dbu0.ts
// deno run --allow-env --allow-net /tmp/example-dbu0.ts

import {MyPool} from 'https://deno.land/x/office_spirit_mysql@v0.21.0/mod.ts';
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

> ⚙ MyConn.[queriesVoid](generated-doc/class.MyConn/README.md#-queriesvoidsql-sqlsource-params-params-promiseresultsetsvoid)(sql: [SqlSource](generated-doc/type.SqlSource/README.md), params?: [Params](generated-doc/type.Params/README.md)): Promise\<[Resultsets](generated-doc/class.Resultsets/README.md)\<`void`>><br>
> ⚙ MyConn.[queries](generated-doc/class.MyConn/README.md#-queriescolumntypecolumnvaluesql-sqlsource-params-params-resultsetspromiserecord)\<ColumnType=[ColumnValue](generated-doc/type.ColumnValue/README.md)>(sql: [SqlSource](generated-doc/type.SqlSource/README.md), params?: [Params](generated-doc/type.Params/README.md)): [ResultsetsPromise](generated-doc/class.ResultsetsPromise/README.md)\<Record><br>
> ⚙ MyConn.[queriesMap](generated-doc/class.MyConn/README.md#-queriesmapcolumntypecolumnvaluesql-sqlsource-params-params-resultsetspromisemapstring-columntype)\<ColumnType=[ColumnValue](generated-doc/type.ColumnValue/README.md)>(sql: [SqlSource](generated-doc/type.SqlSource/README.md), params?: [Params](generated-doc/type.Params/README.md)): [ResultsetsPromise](generated-doc/class.ResultsetsPromise/README.md)\<Map\<`string`, ColumnType>><br>
> ⚙ MyConn.[queriesArr](generated-doc/class.MyConn/README.md#-queriesarrcolumntypecolumnvaluesql-sqlsource-params-params-resultsetspromisecolumntype)\<ColumnType=[ColumnValue](generated-doc/type.ColumnValue/README.md)>(sql: [SqlSource](generated-doc/type.SqlSource/README.md), params?: [Params](generated-doc/type.Params/README.md)): [ResultsetsPromise](generated-doc/class.ResultsetsPromise/README.md)\<ColumnType\[]><br>
> ⚙ MyConn.[queriesCol](generated-doc/class.MyConn/README.md#-queriescolcolumntypecolumnvaluesql-sqlsource-params-params-resultsetspromisecolumntype)\<ColumnType=[ColumnValue](generated-doc/type.ColumnValue/README.md)>(sql: [SqlSource](generated-doc/type.SqlSource/README.md), params?: [Params](generated-doc/type.Params/README.md)): [ResultsetsPromise](generated-doc/class.ResultsetsPromise/README.md)\<ColumnType>

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

- [datesAsString](generated-doc/class.Dsn/README.md#-accessor-datesasstring-boolean) (boolean, default `false`)
- [correctDates](generated-doc/class.Dsn/README.md#-accessor-correctdates-boolean) (boolean, default `false`)

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

- Set the [correctDates](generated-doc/class.Dsn/README.md#-accessor-correctdates-boolean) parameter.
- Explicitly execute `SET` SQL statement that sets `time_zone` system variable, like `SET time_zone='UTC'` or equivalent. You can include it in `Dsn.initSql`, or execute through `conn.query()` before dates conversion is needed. The value that you provide to the `time_zone` variable must be recognizeable by both MySQL and Javascript `Intl.DateTimeFormat` object.
- Use MySQL 5.7+ or MariaDB 10.3+

Consider the following example:

```ts
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/v0.21.0/README.md' | perl -ne 's/^> //; $y=$1 if /^```(.)?/; print $_ if $y&&$m; $m=$y&&$m+/<example-2dm1>/' > /tmp/example-2dm1.ts
// deno run --allow-env --allow-net /tmp/example-2dm1.ts

import {MyPool} from 'https://deno.land/x/office_spirit_mysql@v0.21.0/mod.ts';

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
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/v0.21.0/README.md' | perl -ne 's/^> //; $y=$1 if /^```(.)?/; print $_ if $y&&$m; $m=$y&&$m+/<example-aymx>/' > /tmp/example-aymx.ts
// deno run --allow-env --allow-net /tmp/example-aymx.ts

import {Dsn, MyPool} from 'https://deno.land/x/office_spirit_mysql@v0.21.0/mod.ts';

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
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/v0.21.0/README.md' | perl -ne 's/^> //; $y=$1 if /^```(.)?/; print $_ if $y&&$m; $m=$y&&$m+/<example-10go>/' > /tmp/example-10go.ts
// deno run --allow-env --allow-net /tmp/example-10go.ts

import {MyPool} from 'https://deno.land/x/office_spirit_mysql@v0.21.0/mod.ts';

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
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/v0.21.0/README.md' | perl -ne 's/^> //; $y=$1 if /^```(.)?/; print $_ if $y&&$m; $m=$y&&$m+/<example-1f17>/' > /tmp/example-1f17.ts
// deno run --allow-env --allow-net /tmp/example-1f17.ts

import {MyPool} from 'https://deno.land/x/office_spirit_mysql@v0.21.0/mod.ts';

await using pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');
using conn = pool.getConn();

await conn.queryVoid("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, `time` timestamp, message text)");
await conn.queryVoid("INSERT INTO t_log SET `time`=Now(), message='Message 1'");

const row = await conn.query("SELECT `time` + INTERVAL @days DAY AS 'time', message FROM t_log WHERE id=@`id`", {days: 3, id: 1}).first();
console.log(row);
```

### Using external SQL generators

Another option for parameters substitution is to use libraries that generate SQL.

Any library that produces SQL queries is alright if it takes into consideration the very important [conn.noBackslashEscapes](generated-doc/class.MyConn/README.md#-get-nobackslashescapes-boolean) flag.
Remember that the value of this flag can change during server session, if user executes a query like `SET sql_mode='no_backslash_escapes'`.

Query functions (`query*()`) can receive SQL queries in several forms:

> `type` [SqlSource](generated-doc/type.SqlSource/README.md) = `string` | Uint8Array | (\{`readonly` readable: ReadableStream\<Uint8Array>} | [Reader](generated-doc/interface.Reader/README.md)) \& (\{`readonly` size: `number`} | [Seeker](generated-doc/interface.Seeker/README.md)) | [ToSqlBytes](generated-doc/private.interface.ToSqlBytes/README.md)

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
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/v0.21.0/README.md' | perl -ne 's/^> //; $y=$1 if /^```(.)?/; print $_ if $y&&$m; $m=$y&&$m+/<example-855m>/' > /tmp/example-855m.ts
// deno run --allow-env --allow-net /tmp/example-855m.ts

import {MyPool} from 'https://deno.land/x/office_spirit_mysql@v0.21.0/mod.ts';

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

- [x/polysql](https://deno.land/x/polysql) - Earlier this library was part of this project.

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
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/v0.21.0/README.md' | perl -ne 's/^> //; $y=$1 if /^```(.)?/; print $_ if $y&&$m; $m=$y&&$m+/<example-t6u5>/' > /tmp/example-t6u5.ts
// deno run --allow-env --allow-net /tmp/example-t6u5.ts

import {MyPool} from 'https://deno.land/x/office_spirit_mysql@v0.21.0/mod.ts';

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

```ts
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

Not all query types can be run in Binary Protocol - see [here](https://dev.mysql.com/worklog/task/?id=2871) what's supported by MySQL.

## Prepared statements

Function `conn.prepare()` prepares an SQL statement, that you can execute multiple times, each time with different parameters.

> ⚙ MyConn.[prepare](generated-doc/class.MyConn/README.md#-preparecolumntypecolumnvaluesql-sqlsource-promiseresultsetsrecord)\<ColumnType=[ColumnValue](generated-doc/type.ColumnValue/README.md)>(sql: [SqlSource](generated-doc/type.SqlSource/README.md)): Promise\<[Resultsets](generated-doc/class.Resultsets/README.md)\<Record>>

The returned object must be asynchronously disposed to free the prepared statement on the server.

```ts
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/v0.21.0/README.md' | perl -ne 's/^> //; $y=$1 if /^```(.)?/; print $_ if $y&&$m; $m=$y&&$m+/<example-wr6k>/' > /tmp/example-wr6k.ts
// deno run --allow-env --allow-net /tmp/example-wr6k.ts

import {MyPool} from 'https://deno.land/x/office_spirit_mysql@v0.21.0/mod.ts';
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

> ⚙ MyConn.[prepareVoid](generated-doc/class.MyConn/README.md#-preparevoidsql-sqlsource-promiseresultsetsvoid)(sql: [SqlSource](generated-doc/type.SqlSource/README.md)): Promise\<[Resultsets](generated-doc/class.Resultsets/README.md)\<`void`>><br>
> ⚙ MyConn.[prepare](generated-doc/class.MyConn/README.md#-preparecolumntypecolumnvaluesql-sqlsource-promiseresultsetsrecord)\<ColumnType=[ColumnValue](generated-doc/type.ColumnValue/README.md)>(sql: [SqlSource](generated-doc/type.SqlSource/README.md)): Promise\<[Resultsets](generated-doc/class.Resultsets/README.md)\<Record>><br>
> ⚙ MyConn.[prepareMap](generated-doc/class.MyConn/README.md#-preparemapcolumntypecolumnvaluesql-sqlsource-promiseresultsetsmapstring-columntype)\<ColumnType=[ColumnValue](generated-doc/type.ColumnValue/README.md)>(sql: [SqlSource](generated-doc/type.SqlSource/README.md)): Promise\<[Resultsets](generated-doc/class.Resultsets/README.md)\<Map\<`string`, ColumnType>>><br>
> ⚙ MyConn.[prepareArr](generated-doc/class.MyConn/README.md#-preparearrcolumntypecolumnvaluesql-sqlsource-promiseresultsetscolumntype)\<ColumnType=[ColumnValue](generated-doc/type.ColumnValue/README.md)>(sql: [SqlSource](generated-doc/type.SqlSource/README.md)): Promise\<[Resultsets](generated-doc/class.Resultsets/README.md)\<ColumnType\[]>><br>
> ⚙ MyConn.[prepareCol](generated-doc/class.MyConn/README.md#-preparecolcolumntypecolumnvaluesql-sqlsource-promiseresultsetscolumntype)\<ColumnType=[ColumnValue](generated-doc/type.ColumnValue/README.md)>(sql: [SqlSource](generated-doc/type.SqlSource/README.md)): Promise\<[Resultsets](generated-doc/class.Resultsets/README.md)\<ColumnType>>

The difference between them is the result type that [Resultsets.exec()](generated-doc/class.Resultsets/README.md#-exec_params-param-resultsetspromiserow) returns.

```ts
Resultsets<Row>.exec(params: any[]): ResultsetsPromise<Row>
```

The same functions exist in variant with callbacks. They call your callback with the object that represents the prepared statement, and at the end of the callback they dispose the object.

> ⚙ MyConn.[forPreparedVoid](generated-doc/class.MyConn/README.md#-forpreparedvoidtsql-sqlsource-callback-prepared-resultsetsvoid--promiset-promiset)\<T>(sql: [SqlSource](generated-doc/type.SqlSource/README.md), callback: (prepared: [Resultsets](generated-doc/class.Resultsets/README.md)\<`void`>) => Promise\<T>): Promise\<T><br>
> ⚙ MyConn.[forPrepared](generated-doc/class.MyConn/README.md#-forpreparedcolumntypecolumnvalue-tunknownsql-sqlsource-callback-prepared-resultsetsrecordstring-columntype--promiset-promiset)\<ColumnType=[ColumnValue](generated-doc/type.ColumnValue/README.md), T=`unknown`>(sql: [SqlSource](generated-doc/type.SqlSource/README.md), callback: (prepared: [Resultsets](generated-doc/class.Resultsets/README.md)\<Record\<`string`, ColumnType>>) => Promise\<T>): Promise\<T><br>
> ⚙ MyConn.[forPreparedMap](generated-doc/class.MyConn/README.md#-forpreparedmapcolumntypecolumnvalue-tunknownsql-sqlsource-callback-prepared-resultsetsmapstring-columntype--promiset-promiset)\<ColumnType=[ColumnValue](generated-doc/type.ColumnValue/README.md), T=`unknown`>(sql: [SqlSource](generated-doc/type.SqlSource/README.md), callback: (prepared: [Resultsets](generated-doc/class.Resultsets/README.md)\<Map\<`string`, ColumnType>>) => Promise\<T>): Promise\<T><br>
> ⚙ MyConn.[forPreparedArr](generated-doc/class.MyConn/README.md#-forpreparedarrcolumntypecolumnvalue-tunknownsql-sqlsource-callback-prepared-resultsetscolumntype--promiset-promiset)\<ColumnType=[ColumnValue](generated-doc/type.ColumnValue/README.md), T=`unknown`>(sql: [SqlSource](generated-doc/type.SqlSource/README.md), callback: (prepared: [Resultsets](generated-doc/class.Resultsets/README.md)\<ColumnType\[]>) => Promise\<T>): Promise\<T><br>
> ⚙ MyConn.[forPreparedCol](generated-doc/class.MyConn/README.md#-forpreparedcolcolumntypecolumnvalue-tunknownsql-sqlsource-callback-prepared-resultsetscolumntype--promiset-promiset)\<ColumnType=[ColumnValue](generated-doc/type.ColumnValue/README.md), T=`unknown`>(sql: [SqlSource](generated-doc/type.SqlSource/README.md), callback: (prepared: [Resultsets](generated-doc/class.Resultsets/README.md)\<ColumnType>) => Promise\<T>): Promise\<T>

## Reading long BLOBs

This library tries to have everything needed in real life usage. It's possible to read long data without storing it in memory.

```ts
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/v0.21.0/README.md' | perl -ne 's/^> //; $y=$1 if /^```(.)?/; print $_ if $y&&$m; $m=$y&&$m+/<example-np7j>/' > /tmp/example-np7j.ts
// deno run --allow-env --allow-net /tmp/example-np7j.ts

import {MyPool} from 'https://deno.land/x/office_spirit_mysql@v0.21.0/mod.ts';

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
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/v0.21.0/README.md' | perl -ne 's/^> //; $y=$1 if /^```(.)?/; print $_ if $y&&$m; $m=$y&&$m+/<example-7xum>/' > /tmp/example-7xum.ts
// deno run --allow-env --allow-net /tmp/example-7xum.ts

import {MyPool} from 'https://deno.land/x/office_spirit_mysql@v0.21.0/mod.ts';

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
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/v0.21.0/README.md' | perl -ne 's/^> //; $y=$1 if /^```(.)?/; print $_ if $y&&$m; $m=$y&&$m+/<example-h9zl>/' > /tmp/example-h9zl.ts
// deno run --allow-env --allow-net /tmp/example-h9zl.ts

import {MyPool} from 'https://deno.land/x/office_spirit_mysql@v0.21.0/mod.ts';

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
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/v0.21.0/README.md' | perl -ne 's/^> //; $y=$1 if /^```(.)?/; print $_ if $y&&$m; $m=$y&&$m+/<example-khw0>/' > /tmp/example-khw0.ts
// deno run --allow-env --allow-net /tmp/example-khw0.ts

import {MyPool} from 'https://deno.land/x/office_spirit_mysql@v0.21.0/mod.ts';
import {dirname} from 'jsr:@std/path@1.0.8';

await using pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');

// Set handler for LOAD DATA LOCAL INFILE queries
const ALLOWED_DIRS = ['/tmp'];
pool.options
(	{	onLoadFile(filename, dsn)
		{	if (ALLOWED_DIRS.includes(dirname(filename)))
			{	return Deno.open(filename, {read: true});
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

[MyConn](generated-doc/class.MyConn/README.md) object has several status variables:

- [conn.serverVersion: string](generated-doc/class.MyConn/README.md#-get-serverversion-string) - remote server version, as it reports (for example my server reports "8.0.25-0ubuntu0.21.04.1").
- [conn.connectionId: number](generated-doc/class.MyConn/README.md#-get-connectionid-number) - thread ID of the connection, that `SHOW PROCESSLIST` shows.
- [conn.autocommit: boolean](generated-doc/class.MyConn/README.md#-get-autocommit-boolean) - true if the connection is currently in autocommit mode. Queries like `SET autocommit=0` will affect this flag.
- [conn.inTrx: boolean](generated-doc/class.MyConn/README.md#-get-intrx-boolean) - true if a transaction was started. Queries like `START TRANSACTION` and `ROLLBACK` will affect this flag.
- [conn.inTrxReadonly: boolean](generated-doc/class.MyConn/README.md#-get-intrxreadonly-boolean) - true if a readonly transaction was started. Queries like `START TRANSACTION READ ONLY` and `ROLLBACK` will affect this flag.
- [conn.noBackslashEscapes: boolean](generated-doc/class.MyConn/README.md#-get-nobackslashescapes-boolean) - true, if the server is configured not to use backslash escapes in string literals. Queries like `SET sql_mode='NO_BACKSLASH_ESCAPES'` will affect this flag.
- [conn.schema: string](generated-doc/class.MyConn/README.md#-get-schema-string) - if your server version supports change schema notifications, this will be current default schema (database) name. Queries like `USE new_schema` will affect this value. With old servers this will always remain empty string.

Initially these variables can be empty. They are set after actual connection to the server, that happens after issuing the first query. Or you can call [await conn.connect()](generated-doc/class.MyConn/README.md#-connect-promisevoid).

## Resultsets

`conn.query*()` methods all return [Resultsets](generated-doc/class.Resultsets/README.md) object, that contains information about your query result.
Also this object allows to iterate over rows that the query returned.

If your query returned multiple resultsets, [conn.queryVoid()](generated-doc/class.MyConn/README.md#-queryvoidsql-sqlsource-params-params-promiseresultsetsvoid) skips them, and returns only the status of the last one.

`conn.query*()` functions except [conn.queryVoid()](generated-doc/class.MyConn/README.md#-queryvoidsql-sqlsource-params-params-promiseresultsetsvoid) don't skip resultsets, and [await resultsets.nextResultset()](generated-doc/class.Resultsets/README.md#-nextresultset-promiseboolean) will advance to the next result, and return true.
If there are no more resultsets, [await resultsets.nextResultset()](generated-doc/class.Resultsets/README.md#-nextresultset-promiseboolean) returns false.
And you must read or discard all the resultsets before being able to issue next queries.

```ts
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/v0.21.0/README.md' | perl -ne 's/^> //; $y=$1 if /^```(.)?/; print $_ if $y&&$m; $m=$y&&$m+/<example-rjwg>/' > /tmp/example-rjwg.ts
// deno run --allow-env --allow-net /tmp/example-rjwg.ts

import {MyPool} from 'https://deno.land/x/office_spirit_mysql@v0.21.0/mod.ts';
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

[Resultsets](generated-doc/class.Resultsets/README.md) object has the following properties and methods:

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

## Changing default schema (database)

The connection string (DSN) that you provide when ceating a connections pool, can include schema (database) name, and this will be the default schema for all the queries that use not fully qualified table names and names of other various objects (triggers, etc.).

To change the default schema name during the connection you can issue a `USE schema_name` query.

This library also provides [conn.use()](generated-doc/class.MyConn/README.md#-useschema-string-void) function.

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

> ⚙ MyConn.[setSqlLogger](generated-doc/class.MyConn/README.md#-setsqlloggersqllogger-sqllogger--true-void)(sqlLogger?: [SqlLogger](generated-doc/interface.SqlLogger/README.md) | `true`): `void`<br>
> ⚙ MySession.[setSqlLogger](generated-doc/class.MySession/README.md#-setsqlloggersqllogger-sqllogger--true-void)(sqlLogger?: [SqlLogger](generated-doc/interface.SqlLogger/README.md) | `true`): `void`

By default no SQL is logged. If you set `sqlLogger` to `true`, a default logger will be used, that logs to `Deno.stderr`.

```ts
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/v0.21.0/README.md' | perl -ne 's/^> //; $y=$1 if /^```(.)?/; print $_ if $y&&$m; $m=$y&&$m+/<example-c5vl>/' > /tmp/example-c5vl.ts
// deno run --allow-env --allow-net /tmp/example-c5vl.ts

import {MyPool} from 'https://deno.land/x/office_spirit_mysql@v0.21.0/mod.ts';
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
This can be any object that implements [SqlLogger](generated-doc/interface.SqlLogger/README.md) interface:

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

This library provides a base class called [SqlLogToWritable](generated-doc/class.SqlLogToWritable/README.md) that you can use to implement a logger that logs to any `WritableStream<Uint8Array>` or `Deno.Writer`.

The default logger (that is used if you specify `sqlLogger == true`) is also implemented through [SqlLogToWritable](generated-doc/class.SqlLogToWritable/README.md):

```ts
conn.setSqlLogger(true);

// Is the same as:

conn.setSqlLogger(new SqlLogToWritable(Deno.stderr, !Deno.noColor, 10_000, 3_000, 100));
```

Here is how to subclass `SqlLogToWritable` to log to a file:

```ts
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/v0.21.0/README.md' | perl -ne 's/^> //; $y=$1 if /^```(.)?/; print $_ if $y&&$m; $m=$y&&$m+/<example-mbya>/' > /tmp/example-mbya.ts
// deno run --allow-env --allow-net --allow-write /tmp/example-mbya.ts

import {MyPool, SqlLogToWritable} from 'https://deno.land/x/office_spirit_mysql@v0.21.0/mod.ts';
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

You can see [here](https://github.com/jeremiah-shaulov/office_spirit_mysql/blob/v0.21.0/private/sql_log_to_writable.ts) how [SqlLogToWritable](generated-doc/class.SqlLogToWritable/README.md) class is implemented,
and you can override it's public and protected methods to customize it's behavior.

## Transactions

[MyConn](generated-doc/class.MyConn/README.md) class has the following functions to work with transactions:

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

To start a regular transaction call [MyConn.startTrx()](generated-doc/class.MyConn/README.md#-starttrxoptions-readonly-boolean-xaid-string-xaid1-string-promisevoid) without parameters. Then you can create savepoints, rollback to a savepoint, or rollback the whole transaction, or commit.

```ts
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/v0.21.0/README.md' | perl -ne 's/^> //; $y=$1 if /^```(.)?/; print $_ if $y&&$m; $m=$y&&$m+/<example-y5hf>/' > /tmp/example-y5hf.ts
// deno run --allow-env --allow-net /tmp/example-y5hf.ts

import {MyPool} from 'https://deno.land/x/office_spirit_mysql@v0.21.0/mod.ts';

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

If you specify `xaId1`, the XA ID will consist of 2 parts: the string you provided (`xaId1`) and [conn.connectionId](generated-doc/class.MyConn/README.md#-get-connectionid-number) (the latter may be not known at this point if there's no connection to the server yet, so it will be appended later).

Transaction-related functions are also present in [MySession](generated-doc/class.MySession/README.md) object.
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

[Read more about distributed transactions](https://dev.mysql.com/doc/refman/8.0/en/xa.html).

Some kind of transactions manager is needed when working with distributed transactions.

This library provides transactions manager that you can use.
It's principle is to include MySQL thread ID in transaction IDs started from this thread.
The manager will periodically execute "XA RECOVER" query, and see IDs of prepared transactions.
Then it will execute "SHOW PROCESSLIST" (or similar) query to see running threads.
If there's a transaction whose thread is already terminated, the manager will rollback this dangling transaction.

To use the distributed transactions manager, you need to:

- specify `managedXaDsns` in pool options
- use `MySession.startTrx({xa: true})` to start the distributed transaction

Let's consider the following situation.
We have 2 databases on 2 servers. But in dev environment and in this example they both will reside on the same server.
In both databases we have table called `t_log`, and we want to replicate inserts to this table.

MySQL user for the application will be called `app`, and the manager user will be `manager`, and it will have permission to execute `XA RECOVER`.

```sql
CREATE DATABASE test1;
CREATE DATABASE test2;

CREATE TABLE test1.t_log (id integer PRIMARY KEY AUTO_INCREMENT, message text);
CREATE TABLE test2.t_log (id integer PRIMARY KEY AUTO_INCREMENT, message text);

-- CREATE USER app
CREATE USER app@localhost IDENTIFIED BY 'app';
GRANT ALL ON test1.* TO app@localhost;
GRANT ALL ON test2.* TO app@localhost;

-- CREATE USER manager
CREATE USER manager@localhost IDENTIFIED BY 'manager';
GRANT XA_RECOVER_ADMIN ON *.* TO manager@localhost;
```

```ts
import {MyPool, Dsn} from 'https://deno.land/x/office_spirit_mysql@v0.21.0/mod.ts';

const dsn1 = new Dsn('mysql://app:app@localhost/test1');
const dsn2 = new Dsn('mysql://app:app@localhost/test2');

await using pool = new MyPool
(	{	managedXaDsns:
		[	'mysql://manager:manager@localhost/test1',
			'mysql://manager:manager@localhost/test2',
		]
	}
);

// Start session
using session = pool.getSession();

// Enable SQL logger
session.setSqlLogger(true);

// Start distributed transaction
await session.startTrx({xa: true});

// Query
await session.conn(dsn1).query("INSERT INTO t_log SET message = 'Msg 1'");
await session.conn(dsn2).query("INSERT INTO t_log SET message = 'Msg 1'");

// 2-phase commit
await session.commit();
```

When you start a managed transaction (`MySession.startTrx({xa: true})`), the manager generates XA ID for it.
This ID encodes in itself several pieces of data: timestamp of when the transaction started, `Deno.pid` of the application that started the transaction, and MySQL connection ID.

When the manager rolls back a transaction, it prints message like this:

```ts
Rolled back dangling transaction sqnum0.2@7vo9-1082 because it's MySQL thread ID 1082 was dead. Transaction started 2 sec ago by OS process 367641.
```

## Interrupting long queries

To interrupt a long running query, you can get a parallel connection to the same server, and execute `KILL QUERY`.
This library provides a function that does this for you:

```ts
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/v0.21.0/README.md' | perl -ne 's/^> //; $y=$1 if /^```(.)?/; print $_ if $y&&$m; $m=$y&&$m+/<example-jrt0>/' > /tmp/example-jrt0.ts
// deno run --allow-env --allow-net /tmp/example-jrt0.ts

import {MyPool} from 'https://deno.land/x/office_spirit_mysql@v0.21.0/mod.ts';

await using pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');

const startTime = Date.now();

using conn = pool.getConn();
const sleepPromise = conn.queryVoid("DO SLEEP(3)");
await new Promise(resolve => setTimeout(resolve, 1000));
await conn.killQuery(); // killQuery never returns rejected promise, so it's safe to use it without try-catch (otherwise promise rejection could lead to not awaiting `sleepPromise`)
await sleepPromise;

console.log(`Completed in ${Date.now()-startTime} ms`);
```

Also this library allows you to force immediate disconnection from the server.
The library will then take care of interrupting currently running query in the background, and also rolling back a distributed transaction, if one is in progress.

You can terminate the connection by calling [MyConn.forceImmediateDisconnect()](generated-doc/class.MyConn/README.md#-forceimmediatedisconnectnorollbackcurxa-booleanfalse-nokillcurquery-booleanfalse-disconnectstatus).
Or you can do this on session level by calling [MySession.forceImmediateDisconnect()](generated-doc/class.MySession/README.md#-forceimmediatedisconnectnorollbackcurxa-booleanfalse-nokillcurquery-booleanfalse-disconnectstatus), and this will immediately terminate all the connections in the session.

```ts
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/v0.21.0/README.md' | perl -ne 's/^> //; $y=$1 if /^```(.)?/; print $_ if $y&&$m; $m=$y&&$m+/<example-hwat>/' > /tmp/example-hwat.ts
// deno run --allow-env --allow-net /tmp/example-hwat.ts

import {MyPool} from 'https://deno.land/x/office_spirit_mysql@v0.21.0/mod.ts';

await using pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');

const startTime = Date.now();

using conn = pool.getConn();
const sleepPromise = conn.queryVoid("DO SLEEP(3)");
await new Promise(resolve => setTimeout(resolve, 1000));
conn.forceImmediateDisconnect();
try
{	await sleepPromise;
}
catch (e)
{	console.log(e);
}

console.log(`Completed in ${Date.now()-startTime} ms`);
```

## Pool health status

This library tracks health status for the last 1 minute.
The status is measured in number of successful connecting attempts per total number of attempts.
Also the status shows how many connections are currently in use, and how many are idle in the pool.

To get the status, use [MyPool.getStatus()](generated-doc/class.MyPool/README.md#-getstatushealthstatusforperiodsec-numbertrack_healh_status_for_period_sec-mapdsn-poolstatus).

```ts
// To download and run this example:
// export DSN='mysql://root:hello@localhost/tests'
// curl 'https://raw.githubusercontent.com/jeremiah-shaulov/office_spirit_mysql/v0.21.0/README.md' | perl -ne 's/^> //; $y=$1 if /^```(.)?/; print $_ if $y&&$m; $m=$y&&$m+/<example-w4qu>/' > /tmp/example-w4qu.ts
// deno run --allow-env --allow-net /tmp/example-w4qu.ts

import {MyPool} from 'https://deno.land/x/office_spirit_mysql@v0.21.0/mod.ts';

await using pool = new MyPool(Deno.env.get('DSN') || 'mysql://root:hello@localhost/tests');

{	using conn = pool.getConn();
	await conn.connect();
}

console.log(pool.getStatus());

await new Promise(y => setTimeout(y, 1000));

console.log(pool.getStatus());
```

The returned health status is a number from 0 to 1. 0 means all connecting attempts failed.
1 means all succeeded.
If during the last minute there were no new connections (all the connections were recycled, or no new connections were asked), the `health` is `NaN`.

You can ask the status for the last minute (default), or for last N seconds, where N is between 1 and 60.

```ts
console.log(pool.getStatus(10)); // for the last 10 seconds
```