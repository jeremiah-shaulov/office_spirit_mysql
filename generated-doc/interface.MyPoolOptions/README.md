# `interface` MyPoolOptions

[Documentation Index](../README.md)

```ts
import {MyPoolOptions} from "https://deno.land/x/office_spirit_mysql@v0.22.0/mod.ts"
```

## This interface has

- 7 properties:
[dsn](#-readonly-dsn-dsn--string),
[maxConnsWaitQueue](#-readonly-maxconnswaitqueue-number),
[onLoadFile](#-readonly-onloadfile-onloadfile),
[onBeforeCommit](#-readonly-onbeforecommit-onbeforecommit),
[managedXaDsns](#-readonly-managedxadsns-dsn--string--readonlyarraydsn--string),
[xaCheckEach](#-readonly-xacheckeach-number),
[logger](#-readonly-logger-logger)


#### 📄 `readonly` dsn?: [Dsn](../class.Dsn/README.md) | `string`

> Default Data Source Name for the pool.



#### 📄 `readonly` maxConnsWaitQueue?: `number`

> Default value: `50`
> 
> When [Dsn.maxConns](../class.Dsn/README.md#-accessor-maxconns-number) exceeded, new connection requests will enter waiting queue (like backlog). This is the queue maximum size.



#### 📄 `readonly` onLoadFile?: [OnLoadFile](../type.OnLoadFile/README.md)

> Handler for `LOAD DATA LOCAL INFILE` query.



#### 📄 `readonly` onBeforeCommit?: [OnBeforeCommit](../type.OnBeforeCommit/README.md)

> Callback that will be called every time a transaction is about to be committed.



#### 📄 `readonly` managedXaDsns?: [Dsn](../class.Dsn/README.md) | `string` | ReadonlyArray\<[Dsn](../class.Dsn/README.md) | `string`>

> Will automatically manage distributed transactions on DSNs listed here (will rollback or commit dangling transactions).



#### 📄 `readonly` xaCheckEach?: `number`

> Default value: `6000`
> 
> Check for dangling transactions each this number of milliseconds.



#### 📄 `readonly` logger?: [Logger](../interface.Logger/README.md)

> A `console`-compatible logger, or `globalThis.console`. It will be used to report errors and print log messages.



