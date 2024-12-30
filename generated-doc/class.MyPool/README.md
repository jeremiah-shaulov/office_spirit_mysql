# `class` MyPool

[Documentation Index](../README.md)

```ts
import {MyPool} from "https://deno.land/x/office_spirit_mysql@v0.19.12/mod.ts"
```

## This class has

- [constructor](#-constructoroptions-dsn--string--mypooloptions)
- [destructor](#-symbolasyncdispose-promisevoid)
- 6 methods:
[options](#-optionsoptions-dsn--string--mypooloptions-mypooloptions),
[getSession](#-getsession-mysession),
[forSession](#-forsessiontcallback-session-mysession--promiset-promiset),
[getConn](#-getconndsn-dsn--string-myconn),
[forConn](#-forconntcallback-conn-myconn--promiset-dsn-dsn--string-promiset),
[getStatus](#-getstatus-mapdsn-nbusy-number-nidle-number)
- [2 deprecated symbols](#-deprecated-shutdown-promisevoid)


#### 🔧 `constructor`(options?: [Dsn](../class.Dsn/README.md) | `string` | [MyPoolOptions](../interface.MyPoolOptions/README.md))



#### 🔨 \[Symbol.asyncDispose](): Promise\<`void`>

> Wait till all active sessions and connections complete, and close idle connections in the pool.
> Then new connections will be rejected, and this object will be unusable.



#### ⚙ options(options?: [Dsn](../class.Dsn/README.md) | `string` | [MyPoolOptions](../interface.MyPoolOptions/README.md)): [MyPoolOptions](../interface.MyPoolOptions/README.md)

> Patches configuration options (if `options` parameter is provided).
> Returns the new options.



#### ⚙ getSession(): [MySession](../class.MySession/README.md)

> Get [MySession](../class.MySession/README.md) object, that allows to get connections to different database servers.
> Unlike [getConn()](../class.MyPool/README.md#-getconndsn-dsn--string-myconn), getting connection from [MySession.conn()](../class.MySession/README.md#-conndsn-dsn--string-fresh-booleanfalse-myconn) returns the same
> connection object if asked the same server.



#### ⚙ forSession\<T>(callback: (session: [MySession](../class.MySession/README.md)) => Promise\<T>): Promise\<T>

> Execute callback with new [MySession](../class.MySession/README.md) object, and then destroy the object.



#### ⚙ getConn(dsn?: [Dsn](../class.Dsn/README.md) | `string`): [MyConn](../class.MyConn/README.md)

> Get connection to server.
> 
> 🎚️ Parameter **dsn**:
> 
> To which server to connect. If not specified, returns connection to pool-defaul
> 
> ✔️ Return value:
> 
> New connection object from the pool. It can be a reused connection, or new empty object that will establish the actual connection on first query.



#### ⚙ forConn\<T>(callback: (conn: [MyConn](../class.MyConn/README.md)) => Promise\<T>, dsn?: [Dsn](../class.Dsn/README.md) | `string`): Promise\<T>

> Execute callback with new [MyConn](../class.MyConn/README.md) object, and then destroy the object.



#### ⚙ getStatus(): Map\<[Dsn](../class.Dsn/README.md), \{nBusy: `number`, nIdle: `number`}>



<div style="opacity:0.6">

#### ⚙ `deprecated` shutdown(): Promise\<`void`>

> Deprecated alias of `this[Symbol.asyncDispose]()`.



#### ⚙ `deprecated` session\<T>(callback: (session: [MySession](../class.MySession/README.md)) => Promise\<T>): Promise\<T>

> Deprecated alias of `forSession()`.



</div>

