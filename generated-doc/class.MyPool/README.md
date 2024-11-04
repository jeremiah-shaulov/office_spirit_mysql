# `class` MyPool

[Documentation Index](../README.md)

```ts
import {MyPool} from "https://deno.land/x/office_spirit_mysql/v0.19.1/mod.ts"
```

## This class has

- [constructor](#-constructoroptions-dsn--string--mypooloptions)
- [destructor](#-symbolasyncdispose-promisevoid)
- 5 methods:
[options](#-optionsoptions-dsn--string--mypooloptions-mypooloptions),
[getSession](#-getsession-mysession),
[forSession](#-forsessiontcallback-session-mysession--promiset-promiset),
[getConn](#-getconndsn-dsn--string-myconn),
[forConn](#-forconntcallback-conn-myconn--promiset-dsn-dsn--string-promiset)
- [2 deprecated symbols](#-deprecated-shutdown-promisevoid)


#### 🔧 `constructor`(options?: [Dsn](../class.Dsn/README.md) | `string` | [MyPoolOptions](../interface.MyPoolOptions/README.md))



#### 🔨 \[Symbol.asyncDispose](): Promise\<`void`>

> Wait till all active sessions and connections complete, and close idle connections in the pool.
> Then new connections will be rejected, and this object will be unusable.



#### ⚙ options(options?: [Dsn](../class.Dsn/README.md) | `string` | [MyPoolOptions](../interface.MyPoolOptions/README.md)): [MyPoolOptions](../interface.MyPoolOptions/README.md)



#### ⚙ getSession(): [MySession](../class.MySession/README.md)



#### ⚙ forSession\<T>(callback: (session: [MySession](../class.MySession/README.md)) => Promise\<T>): Promise\<T>



#### ⚙ getConn(dsn?: [Dsn](../class.Dsn/README.md) | `string`): [MyConn](../class.MyConn/README.md)



#### ⚙ forConn\<T>(callback: (conn: [MyConn](../class.MyConn/README.md)) => Promise\<T>, dsn?: [Dsn](../class.Dsn/README.md) | `string`): Promise\<T>



<div style="opacity:0.6">

#### ⚙ `deprecated` shutdown(): Promise\<`void`>

> Deprecated alias of `this[Symbol.asyncDispose]()`.



#### ⚙ `deprecated` session\<T>(callback: (session: [MySession](../class.MySession/README.md)) => Promise\<T>): Promise\<T>

> Deprecated alias of `forSession()`.



</div>

