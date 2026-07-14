# `class` Trx

[Documentation Index](../README.md)

```ts
import {Trx} from "https://deno.land/x/office_spirit_mysql@v0.27.2/mod.ts"
```

Represents a started transaction.
This object is returned from [MyConn.getTrx()](../class.MyConn/README.md#-gettrxoptions-readonly-boolean-xaid-string-xaid1-string-promisetrx) and [MySession.getTrx()](../class.MySession/README.md#-gettrxoptions-readonly-boolean-xa-boolean-promisetrx).
It's an `AsyncDisposable`, so you're expected to use it together with `await using`.
When the variable goes out of scope, the transaction is rolled back, unless you've called [Trx.commit()](../class.Trx/README.md#-commit-any) on it.
This way the transaction can't be left dangling: it's either committed explicitly, or rolled back automatically.

## This class has

- [constructor](#-constructorconn-commit-promisevoid-rollback-promisevoid)
- [destructor](#-symbolasyncdispose-any)
- method [commit](#-commit-any)


#### 🔧 `constructor`(conn: \{commit(): Promise\<`void`>, rollback(): Promise\<`void`>})



#### 🔨 \[Symbol.asyncDispose](): `any`

> Rolls back the transaction, unless [Trx.commit()](../class.Trx/README.md#-commit-any) was called.
> This is invoked automatically at the end of the `await using` scope.



#### ⚙ commit(): `any`

> Commit the transaction.
> After this call, disposing the `Trx` object will not rollback anything.



