# `class` Dsn

[Documentation Index](../README.md)

```ts
import {Dsn} from "https://deno.land/x/office_spirit_mysql@v0.26.1/mod.ts"
```

Data source name. URL string that specifies how to connect to MySQL server.
Format: `mysql://user:password@host:port/schema?param1=value1&param2=value2#INITIAL_SQL`.
Or: `mysql://user:password@localhost/path/to/named.pipe/schema`.

Example: `mysql://root@localhost/` or `mysql://root:hello@[::1]/?keepAliveTimeout=10000&foundRows`.

Possible parameters:
- [connectionTimeout](../class.Dsn/README.md#-accessor-connectiontimeout-number)
- [reconnectInterval](../class.Dsn/README.md#-accessor-reconnectinterval-number)
- [keepAliveTimeout](../class.Dsn/README.md#-accessor-keepalivetimeout-number)
- [keepAliveMax](../class.Dsn/README.md#-accessor-keepalivemax-number)
- [maxConns](../class.Dsn/README.md#-accessor-maxconns-number)
- [maxColumnLen](../class.Dsn/README.md#-accessor-maxcolumnlen-number)
- [foundRows](../class.Dsn/README.md#-accessor-foundrows-boolean)
- [ignoreSpace](../class.Dsn/README.md#-accessor-ignorespace-boolean)
- [retryLockWaitTimeout](../class.Dsn/README.md#-accessor-retrylockwaittimeout-boolean)
- [retryQueryTimes](../class.Dsn/README.md#-accessor-retryquerytimes-number)
- [jsonAsString](../class.Dsn/README.md#-accessor-jsonasstring-boolean)
- [datesAsString](../class.Dsn/README.md#-accessor-datesasstring-boolean)
- [correctDates](../class.Dsn/README.md#-accessor-correctdates-boolean)
- [storeResultsetIfBigger](../class.Dsn/README.md#-accessor-storeresultsetifbigger-number)

## This class has

- [constructor](#-constructordsn-string--dsn)
- 25 properties:
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
[jsonAsString](#-accessor-jsonasstring-boolean),
[datesAsString](#-accessor-datesasstring-boolean),
[correctDates](#-accessor-correctdates-boolean),
[storeResultsetIfBigger](#-accessor-storeresultsetifbigger-number),
[initSql](#-accessor-initsql-string),
[name](#-get-name-string),
[hash](#-get-hash-number),
[hashNoSchema](#-get-hashnoschema-number),
[addr](#-get-addr-connectoptions--transport-unix-path-string)
- method [toString](#-tostring-string)
- [deprecated symbol](#-deprecated-accessor-multistatements-boolean)


#### 🔧 `constructor`(dsn: `string` | [Dsn](../class.Dsn/README.md))



#### 📄 `accessor` hostname: `string`



#### 📄 `accessor` port: `number`



#### 📄 `accessor` username: `string`



#### 📄 `accessor` password: `string`



#### 📄 `accessor` schema: `string`



#### 📄 `accessor` pipe: `string`

> Path to unix-domain socket file, through which to connect to the server.



#### 📄 `accessor` connectionTimeout: `number`

> Default value: `5000`
> 
> Milliseconds. If connection to the server is failing, it will be retried during this period of time, each `reconnectInterval` milliseconds.



#### 📄 `accessor` reconnectInterval: `number`

> Default value: `500`
> 
> Milliseconds. Will retry connecting to the server each this number of milliseconds, during the `connectionTimeout`.



#### 📄 `accessor` keepAliveTimeout: `number`

> Default value: `10000`
> 
> Milliseconds. Each connection will persist for this period of time, before termination, so it can be reused when someone else asks for the same connection.



#### 📄 `accessor` keepAliveMax: `number`

> Default value: `Infinity`
> 
> How many times at most to recycle each connection.



#### 📄 `accessor` maxConns: `number`

> Default value: `250`
> 
> Limit number of simultaneous connections to this DSN in pool.



#### 📄 `accessor` maxColumnLen: `number`

> Default value: `10MiB`
> 
> Bytes. If a column was longer, it's value is skipped, and it will be returned as NULL.



#### 📄 `accessor` foundRows: `boolean`

> Default value: `false`
> 
> If present, will use "found rows" instead of "affected rows" in resultsets.



#### 📄 `accessor` ignoreSpace: `boolean`

> Default value: `false`
> 
> If present, parser on server side can ignore spaces before '(' in built-in function names.



#### 📄 `accessor` retryLockWaitTimeout: `boolean`

> Default value: `false`
> 
> If set, and `retryQueryTimes` is also set, will retry query that failed with "lock wait timeout" error. The query will be retried `retryQueryTimes` times.



#### 📄 `accessor` retryQueryTimes: `number`

> Default value: `0`
> 
> Automatically reissue queries this number of attempts, if error was "deadlock" in autocommit mode, or (if `retryLockWaitTimeout` was set) "lock wait timeout" in both modes.
> Please note, that this will also rerun queries like `CALL`.



#### 📄 `accessor` jsonAsString: `boolean`

> Default value: `false`
> 
> If present, json columns will not be parsed when selected from MySQL, so they'll be returned as strings.



#### 📄 `accessor` datesAsString: `boolean`

> Default value: `false`
> 
> If present, date, datetime and timestamp columns will not be converted to `Date` objects when selected from MySQL, so they'll be returned as strings.



#### 📄 `accessor` correctDates: `boolean`

> Default value: `false`
> 
> Enables timezone correction when converting between Javascript `Date` objects and MySQL date, datetime and timestamp types.
> This is only supported on MySQL 5.7+, and this is not supported on MariaDB at least up to v10.7.



#### 📄 `accessor` storeResultsetIfBigger: `number`

> Default value: `64KiB`
> 
> When using [Resultsets.store()](../class.Resultsets/README.md#-store_allresultsets-booleanfalse-promisethis) and the resultset is bigger than this number of bytes, it will be stored on disk, rather than in RAM (array).



#### 📄 `accessor` initSql: `string`

> SQL statement, or several statements separated with `;`, that will be executed to initialize each connection right after connecting.



#### 📄 `get` name(): `string`

> String representation of this object. Synonym of [toString()](../class.Dsn/README.md#-tostring-string).



#### 📄 `get` hash(): `number`

> Numeric hash of [name](../class.Dsn/README.md#-get-name-string) string.



#### 📄 `get` hashNoSchema(): `number`

> Numeric hash of string that represents all parts of this object except schema name.



#### 📄 `get` addr(): ConnectOptions | \{transport: <mark>"unix"</mark>, path: `string`}

> `Deno.ConnectOptions` object for hostname and port, or unix-domain socket.



#### ⚙ toString(): `string`



<div style="opacity:0.6">

#### 📄 `deprecated` `accessor` multiStatements: `boolean`

> SQL can contain multiple statements separated with ';', so you can upload dumps, but SQL injection attacks become more risky.
> 
> `deprecated`
> 
> To execute multiple statements use `queriesVoid()` function and the such.



</div>

