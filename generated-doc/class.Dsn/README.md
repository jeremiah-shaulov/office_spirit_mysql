# `class` Dsn

[Documentation Index](../README.md)

```ts
import {Dsn} from "https://deno.land/x/office_spirit_mysql/v0.19.2/mod.ts"
```

Data source name. URL string that specifies how to connect to MySQL server.
Format: `mysql://user:password@host:port/schema?param1=value1&param2=value2#INITIAL_SQL`.
Or: `mysql://user:password@localhost/path/to/named.pipe/schema`.

Example: `mysql://root@localhost/` or `mysql://root:hello@[::1]/?keepAliveTimeout=10000&foundRows`.

Possible parameters:
- `connectionTimeout` (number) milliseconds - if connection to the server is failing, it will be retried during this period of time, each `reconnectInterval` milliseconds;
- `reconnectInterval` (number) milliseconds - will retry connecting to the server each this number of milliseconds, during the `connectionTimeout`;
- `keepAliveTimeout` (number) milliseconds - each connection will persist for this period of time, before termination, so it can be reused when someone else asks for the same connection;
- `keepAliveMax` (number) - how many times at most to recycle each connection;
- `maxConns` (number) - limit number of simultaneous connections to this DSN in pool
- `maxColumnLen` (number) bytes - if a column was longer, it's value is skipped, and it will be returned as NULL;
- `foundRows` (boolean) - if present, will use "found rows" instead of "affected rows" in resultsets;
- `ignoreSpace` (boolean) - if present, parser on server side can ignore spaces before '(' in built-in function names;
- `retryLockWaitTimeout` (boolean) - if set, and `retryQueryTimes` is also set, will retry query that failed with "lock wait timeout" error. The query will be retried `retryQueryTimes` times.
- `retryQueryTimes` (number) - automatically reissue queries this number of attempts, if error was "deadlock" in autocommit mode, or (if `retryLockWaitTimeout` was set) "lock wait timeout" in both modes; please note, that this will also rerun queries like `CALL`;
- `datesAsString` (boolean) - if present, date, datetime and timestamp columns will not be converted to `Date` objects when selected from MySQL, so they'll be returned as strings;
- `correctDates` (boolean) - enables timezone correction when converting between Javascript `Date` objects and MySQL date, datetime and timestamp types. This is only supported on MySQL 5.7+, and this is not supported on MariaDB at least up to v10.7;

## This class has

- [constructor](#-constructordsn-string--dsn)
- 19 properties:
[hostname](#-accessor-hostname-string),
[port](#-accessor-port-number),
[username](#-accessor-username-string),
[password](#-accessor-password-string),
[schema](#-accessor-schema-string),
[pipe](#-accessor-pipe-string),
[connectionTimeout](#-accessor-connectiontimeout-number),
[reconnectInterval](#-accessor-reconnectinterval-number),
[keepAliveTimeout](#-accessor-keepalivetimeout-number),
[keepAliveMax](#-accessor-keepalivemax-number),
[maxConns](#-accessor-maxconns-number),
[maxColumnLen](#-accessor-maxcolumnlen-number),
[foundRows](#-accessor-foundrows-boolean),
[ignoreSpace](#-accessor-ignorespace-boolean),
[retryLockWaitTimeout](#-accessor-retrylockwaittimeout-boolean),
[retryQueryTimes](#-accessor-retryquerytimes-number),
[datesAsString](#-accessor-datesasstring-boolean),
[correctDates](#-accessor-correctdates-boolean),
[initSql](#-accessor-initsql-string)
- method [toString](#-tostring-string)
- [deprecated symbol](#-deprecated-accessor-multistatements-boolean)


#### 🔧 `constructor`(dsn: `string` | [Dsn](../class.Dsn/README.md))



#### 📄 `accessor` hostname: `string`



#### 📄 `accessor` port: `number`



#### 📄 `accessor` username: `string`



#### 📄 `accessor` password: `string`



#### 📄 `accessor` schema: `string`



#### 📄 `accessor` pipe: `string`



#### 📄 `accessor` connectionTimeout: `number`



#### 📄 `accessor` reconnectInterval: `number`



#### 📄 `accessor` keepAliveTimeout: `number`



#### 📄 `accessor` keepAliveMax: `number`



#### 📄 `accessor` maxConns: `number`



#### 📄 `accessor` maxColumnLen: `number`



#### 📄 `accessor` foundRows: `boolean`



#### 📄 `accessor` ignoreSpace: `boolean`



#### 📄 `accessor` retryLockWaitTimeout: `boolean`



#### 📄 `accessor` retryQueryTimes: `number`



#### 📄 `accessor` datesAsString: `boolean`



#### 📄 `accessor` correctDates: `boolean`



#### 📄 `accessor` initSql: `string`



#### ⚙ toString(): `string`



<div style="opacity:0.6">

#### 📄 `deprecated` `accessor` multiStatements: `boolean`

> SQL can contain multiple statements separated with ';', so you can upload dumps, but SQL injection attacks become more risky.

> `deprecated`
> 
> To execute multiple statements use `queriesVoid()` function and the such.



</div>

