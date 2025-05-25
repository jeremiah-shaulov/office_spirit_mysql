# `class` SqlLogToWritable `extends` [SqlLogToWritableBase](../class.SqlLogToWritableBase/README.md) `implements` [SqlLogger](../interface.SqlLogger/README.md)

[Documentation Index](../README.md)

```ts
import {SqlLogToWritable} from "https://deno.land/x/office_spirit_mysql@v0.22.0/mod.ts"
```

## This class has

- [constructor](#-constructorwriter-writer--writablestreamuint8array-withcolor-booleanfalse-querymaxbytes-numberdefault_query_max_bytes-parammaxbytes-numberdefault_param_max_bytes-maxlines-numberdefault_max_lines-logger-loggerconsole)
- 4 properties:
[withColor](#-withcolor-boolean),
[queryMaxBytes](#-querymaxbytes-number),
[paramMaxBytes](#-parammaxbytes-number),
[maxLines](#-maxlines-number)
- 5 methods:
[connect](#-connectdsn-dsn-connectionid-number-promisevoid),
[resetConnection](#-resetconnectiondsn-dsn-connectionid-number-promisevoid),
[disconnect](#-disconnectdsn-dsn-connectionid-number-promisevoid),
[query](#-querydsn-dsn-connectionid-number-isprepare-boolean-nobackslashescapes-boolean-promisestart---promise-appendtoquerydata-uint8arrayarraybufferlike-promisevoid-setstmtidstmtid-number-promisevoid-appendtoparamnparam-number-data-number---1-more---uint8array-promise-paramend_nparam-number-promise-nextquery-promise-endresult-error--resultsets-stmtid-number-promise),
[deallocatePrepare](#-deallocatepreparedsn-dsn-connectionid-number-stmtids-number-promisevoid)
- protected method [nextConnBanner](#-protected-override-nextconnbannerdsn-dsn-connectionid-number-string--uint8arrayarraybufferlike)
- 4 inherited members from [SqlLogToWritableBase](../class.SqlLogToWritableBase/README.md)


#### 🔧 `constructor`(writer: [Writer](../interface.Writer/README.md) | WritableStream\<Uint8Array>, withColor: `boolean`=false, queryMaxBytes: `number`=DEFAULT\_QUERY\_MAX\_BYTES, paramMaxBytes: `number`=DEFAULT\_PARAM\_MAX\_BYTES, maxLines: `number`=DEFAULT\_MAX\_LINES, logger: [Logger](../interface.Logger/README.md)=console)



#### 📄 withColor: `boolean`



#### 📄 queryMaxBytes: `number`



#### 📄 paramMaxBytes: `number`



#### 📄 maxLines: `number`



#### ⚙ connect(dsn: [Dsn](../class.Dsn/README.md), connectionId: `number`): Promise\<`void`>

> A new connection established.



#### ⚙ resetConnection(dsn: [Dsn](../class.Dsn/README.md), connectionId: `number`): Promise\<`void`>

> Connection state reset (before returning this connection to it's pool).



#### ⚙ disconnect(dsn: [Dsn](../class.Dsn/README.md), connectionId: `number`): Promise\<`void`>

> Disconnected.



#### ⚙ query(dsn: [Dsn](../class.Dsn/README.md), connectionId: `number`, isPrepare: `boolean`, noBackslashEscapes: `boolean`): Promise\<\{start: () => Promise\<...>, appendToQuery(data: Uint8Array\<ArrayBufferLike>): Promise\<`void`>, setStmtId(stmtId: `number`): Promise\<`void`>, appendToParam(nParam: `number`, data: `number` | ... 1 more ... | Uint8Array\<...>): Promise\<...>, paramEnd(\_nParam: `number`): Promise\<...>, nextQuery(): Promise\<...>, end(result: Error | Resultsets\<...>, stmtId: `number`): Promise\<...>}>

> Started to send a new query to the server.
> `isPrepare` means that this is query preparation operation (the query is not executed, but stored on the server).
> This function can return object that implements `SqlLoggerQuery` for further logging the query process.
> Query SQL (if any) will be handed to the methods of `SqlLoggerQuery`.



#### ⚙ deallocatePrepare(dsn: [Dsn](../class.Dsn/README.md), connectionId: `number`, stmtIds: `number`\[]): Promise\<`void`>

> Deallocated prepared query or multiple queries indentified by their `stmtIds`.



#### ⚙ `protected` `override` nextConnBanner(dsn: [Dsn](../class.Dsn/README.md), connectionId: `number`): `string` | Uint8Array\<ArrayBufferLike>



