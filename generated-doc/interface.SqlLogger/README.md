# `interface` SqlLogger

[Documentation Index](../README.md)

```ts
import {SqlLogger} from "https://deno.land/x/office_spirit_mysql@v0.20.0/mod.ts"
```

## This interface has

- 6 properties:
[connect](#-connect-dsn-dsn-connectionid-number--promiseunknown),
[resetConnection](#-resetconnection-dsn-dsn-connectionid-number--promiseunknown),
[disconnect](#-disconnect-dsn-dsn-connectionid-number--promiseunknown),
[query](#-query-dsn-dsn-connectionid-number-isprepare-boolean-nobackslashescapes-boolean--promisesqlloggerquery--undefined),
[deallocatePrepare](#-deallocateprepare-dsn-dsn-connectionid-number-stmtids-number--promiseunknown),
[dispose](#-dispose---promiseunknown)


#### 📄 connect?: (dsn: [Dsn](../class.Dsn/README.md), connectionId: `number`) => Promise\<`unknown`>

> A new connection established.



#### 📄 resetConnection?: (dsn: [Dsn](../class.Dsn/README.md), connectionId: `number`) => Promise\<`unknown`>

> Connection state reset (before returning this connection to it's pool).



#### 📄 disconnect?: (dsn: [Dsn](../class.Dsn/README.md), connectionId: `number`) => Promise\<`unknown`>

> Disconnected.



#### 📄 query?: (dsn: [Dsn](../class.Dsn/README.md), connectionId: `number`, isPrepare: `boolean`, noBackslashEscapes: `boolean`) => Promise\<[SqlLoggerQuery](../interface.SqlLoggerQuery/README.md) | `undefined`>

> Started to send a new query to the server.
> `isPrepare` means that this is query preparation operation (the query is not executed, but stored on the server).
> This function can return object that implements `SqlLoggerQuery` for further logging the query process.
> Query SQL (if any) will be handed to the methods of `SqlLoggerQuery`.



#### 📄 deallocatePrepare?: (dsn: [Dsn](../class.Dsn/README.md), connectionId: `number`, stmtIds: `number`\[]) => Promise\<`unknown`>

> Deallocated prepared query or multiple queries indentified by their `stmtIds`.



#### 📄 dispose?: () => Promise\<`unknown`>

> This callback is called when current `MyConn` object is disposed of. This happens at the end of `MyPool.forConn()`, or at the end of a block with `using conn = ...`.



