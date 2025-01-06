# `interface` MyPoolOptions

[Documentation Index](../README.md)

```ts
import {MyPoolOptions} from "https://deno.land/x/office_spirit_mysql@v0.19.13/mod.ts"
```

## This interface has

- 8 properties:
[dsn](#-dsn-dsn--string),
[maxConnsWaitQueue](#-maxconnswaitqueue-number),
[onLoadFile](#-onloadfile-onloadfile),
[onBeforeCommit](#-onbeforecommit-onbeforecommit),
[managedXaDsns](#-managedxadsns-dsn--string--dsn--string),
[xaCheckEach](#-xacheckeach-number),
[xaInfoTables](#-xainfotables-dsn-dsn--string-table-string),
[logger](#-logger-logger)


#### 📄 dsn?: [Dsn](../class.Dsn/README.md) | `string`

> Default Data Source Name for the pool.



#### 📄 maxConnsWaitQueue?: `number`

> Default value: `50`
> 
> When [Dsn.maxConns](../class.Dsn/README.md#-accessor-maxconns-number) exceeded, new connection requests will enter waiting queue (like backlog). This is the queue maximum size.



#### 📄 onLoadFile?: [OnLoadFile](../type.OnLoadFile/README.md)

> Handler for `LOAD DATA LOCAL INFILE` query.



#### 📄 onBeforeCommit?: [OnBeforeCommit](../type.OnBeforeCommit/README.md)

> Callback that will be called every time a transaction is about to be committed.



#### 📄 managedXaDsns?: [Dsn](../class.Dsn/README.md) | `string` | ([Dsn](../class.Dsn/README.md) | `string`)\[]

> Will automatically manage distributed transactions on DSNs listed here (will rollback or commit dangling transactions).



#### 📄 xaCheckEach?: `number`

> Default value: `6000`
> 
> Check for dangling transactions each this number of milliseconds.



#### 📄 xaInfoTables?: \{dsn: [Dsn](../class.Dsn/README.md) | `string`, table: `string`}\[]

> You can provide tables (that you need to create), that will improve distributed transactions management (optional).



#### 📄 logger?: [Logger](../interface.Logger/README.md)

> A `console`-compatible logger, or `globalThis.console`. It will be used to report errors and print log messages.



