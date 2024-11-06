# `class` MySession

[Documentation Index](../README.md)

```ts
import {MySession} from "https://deno.land/x/office_spirit_mysql/v0.19.4/mod.ts"
```

## This class has

- [constructor](#-constructorpool-pool)
- [destructor](#-symboldispose-void)
- property [conns](#-get-conns-readonly-myconn)
- 6 methods:
[conn](#-conndsn-dsn--string-fresh-booleanfalse-myconn),
[startTrx](#-starttrxoptions-readonly-boolean-xa-boolean-promisevoid),
[savepoint](#-savepoint-number),
[rollback](#-rollbacktopointid-number-promisevoid),
[commit](#-commitandchain-booleanfalse-promisevoid),
[setSqlLogger](#-setsqlloggersqllogger-sqllogger--true-void)


#### 🔧 `constructor`(pool: [Pool](../class.Pool/README.md))



#### 🔨 \[Symbol.dispose](): `void`

> Disposes all the connections in this session.
> This method doesn't throw.



#### 📄 `get` conns(): readonly MyConn\[]



#### ⚙ conn(dsn?: [Dsn](../class.Dsn/README.md) | `string`, fresh: `boolean`=false): [MyConn](../class.MyConn/README.md)



#### ⚙ startTrx(options?: \{readonly?: `boolean`, xa?: `boolean`}): Promise\<`void`>

> Commit current transaction (if any), and start new.
> If there're active transactions, they will be properly (2-phase if needed) committed.
> Then new transaction will be started on all connections in this session.
> If then you'll ask a new connection, it will join the transaction.
> If commit fails, this function does rollback, and throws the Error.



#### ⚙ savepoint(): `number`

> Create session-level savepoint, and return it's ID number.
> Then you can call `session.rollback(pointId)`.
> This is lazy operation. The corresponding command will be sent to the server later.
> Calling `savepoint()` immediately followed by `rollback(pointId)` to this point will send no commands.
> Using `MySession.savepoint()` doesn't interfere with `MyConn.savepoint()`, so it's possible to use both.



#### ⚙ rollback(toPointId?: `number`): Promise\<`void`>

> Rollback all the active transactions in this session.
> If `toPointId` is not given or undefined - rolls back the whole transaction.
> If `toPointId` is a number returned from `savepoint()` call, rolls back all the transactions to that point.
> If `toPointId` is `0`, rolls back to the beginning of transaction, and doesn't end this transaction (also works with XAs).
> If rollback (not to savepoint) failed, will disconnect from server and throw ServerDisconnectedError.
> If `toPointId` was `0`, the transaction will be restarted after the disconnect if rollback failed.



#### ⚙ commit(andChain: `boolean`=false): Promise\<`void`>

> Commit all the active transactions in this session.
> If the session transaction was started with `{xa: true}`, will do 2-phase commit.
> If failed will rollback. If failed and `andChain` was true, will rollback and restart the same transaction (also XA).
> If rollback failed, will disconnect (and restart the transaction in case of `andChain`).



#### ⚙ setSqlLogger(sqlLogger?: [SqlLogger](../interface.SqlLogger/README.md) | `true`): `void`



