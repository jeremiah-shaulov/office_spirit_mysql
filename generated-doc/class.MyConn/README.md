# `class` MyConn

[Documentation Index](../README.md)

```ts
import {MyConn} from "https://deno.land/x/office_spirit_mysql/v0.19.2/mod.ts"
```

## This class has

- [constructor](#-constructordsn-dsn-pool-pool)
- [destructor](#-symboldispose-void)
- property [dsn](#-readonly-dsn-dsn)
- 31 methods:
[connect](#-connect-promisevoid),
[end](#-end-void),
[use](#-useschema-string-void),
[query](#-querycolumntypecolumnvaluesql-sqlsource-params-params-resultsetspromiserecord),
[queryMap](#-querymapcolumntypecolumnvaluesql-sqlsource-params-params-resultsetspromisemapstring-columntype),
[queryArr](#-queryarrcolumntypecolumnvaluesql-sqlsource-params-params-resultsetspromisecolumntype),
[queryCol](#-querycolcolumntypecolumnvaluesql-sqlsource-params-params-resultsetspromisecolumntype),
[queryVoid](#-queryvoidsql-sqlsource-params-params-promiseresultsetsvoid),
[queries](#-queriescolumntypecolumnvaluesql-sqlsource-params-params-resultsetspromiserecord),
[queriesMap](#-queriesmapcolumntypecolumnvaluesql-sqlsource-params-params-resultsetspromisemapstring-columntype),
[queriesArr](#-queriesarrcolumntypecolumnvaluesql-sqlsource-params-params-resultsetspromisecolumntype),
[queriesCol](#-queriescolcolumntypecolumnvaluesql-sqlsource-params-params-resultsetspromisecolumntype),
[queriesVoid](#-queriesvoidsql-sqlsource-params-params-promiseresultsetsvoid),
[makeLastColumnReadable](#-makelastcolumnreadablecolumntypecolumnvaluesql-sqlsource-params-params-promiseany),
[prepare](#-preparecolumntypecolumnvaluesql-sqlsource-promiseresultsetsrecord),
[prepareMap](#-preparemapcolumntypecolumnvaluesql-sqlsource-promiseresultsetsmapstring-columntype),
[prepareArr](#-preparearrcolumntypecolumnvaluesql-sqlsource-promiseresultsetscolumntype),
[prepareCol](#-preparecolcolumntypecolumnvaluesql-sqlsource-promiseresultsetscolumntype),
[prepareVoid](#-preparevoidsql-sqlsource-promiseresultsetsvoid),
[forPrepared](#-forpreparedcolumntypecolumnvalue-tunknownsql-sqlsource-callback-prepared-resultsetsrecordstring-columntype--promiset-promiset),
[forPreparedMap](#-forpreparedmapcolumntypecolumnvalue-tunknownsql-sqlsource-callback-prepared-resultsetsmapstring-columntype--promiset-promiset),
[forPreparedArr](#-forpreparedarrcolumntypecolumnvalue-tunknownsql-sqlsource-callback-prepared-resultsetscolumntype--promiset-promiset),
[forPreparedCol](#-forpreparedcolcolumntypecolumnvalue-tunknownsql-sqlsource-callback-prepared-resultsetscolumntype--promiset-promiset),
[forPreparedVoid](#-forpreparedvoidtsql-sqlsource-callback-prepared-resultsetsvoid--promiset-promiset),
[startTrx](#-starttrxoptions-readonly-boolean-xaid-string-xaid1-string-promisevoid),
[savepoint](#-savepoint-number),
[prepareCommit](#-preparecommit-promisevoid),
[rollback](#-rollbacktopointid-number-promisevoid),
[commit](#-commitandchain-booleanfalse-promisevoid),
[setSqlLogger](#-setsqlloggersqllogger-sqllogger--true-void),
[getNamedParamsQueries](#-getnamedparamsqueriesprotocol-myprotocol-params-recordstring-param-letreturnundefined-boolean-promisestmtid-number-values-any-query1-uint8array)
- protected property [pendingTrxSql](#-protected-pendingtrxsql-string)
- [7 deprecated symbols](#-deprecated-executesql-sqlsource-params-params-promiseresultsetsvoid)


#### 🔧 `constructor`(dsn: [Dsn](../class.Dsn/README.md), pool: [Pool](../class.Pool/README.md))



#### 🔨 \[Symbol.dispose](): `void`

> Immediately places the connection back to it's pool where it gets eventually reset or disconnected.
> This method doesn't throw.



#### 📄 `readonly` dsn: [Dsn](../class.Dsn/README.md)



#### ⚙ connect(): Promise\<`void`>

> If end() called during connection process, the connection will not be established after this function returns.



#### ⚙ end(): `void`



#### ⚙ use(schema: `string`): `void`

> Add "USE schema" command to pending.
> The command will be executed together with next query.
> If no query follows, the command will be never executed.
> If there's no such schema, the exception will be thrown on the next query.



#### ⚙ query\<ColumnType=[ColumnValue](../type.ColumnValue/README.md)>(sql: [SqlSource](../type.SqlSource/README.md), params?: [Params](../type.Params/README.md)): [ResultsetsPromise](../class.ResultsetsPromise/README.md)\<Record>



#### ⚙ queryMap\<ColumnType=[ColumnValue](../type.ColumnValue/README.md)>(sql: [SqlSource](../type.SqlSource/README.md), params?: [Params](../type.Params/README.md)): [ResultsetsPromise](../class.ResultsetsPromise/README.md)\<Map\<`string`, ColumnType>>



#### ⚙ queryArr\<ColumnType=[ColumnValue](../type.ColumnValue/README.md)>(sql: [SqlSource](../type.SqlSource/README.md), params?: [Params](../type.Params/README.md)): [ResultsetsPromise](../class.ResultsetsPromise/README.md)\<ColumnType\[]>



#### ⚙ queryCol\<ColumnType=[ColumnValue](../type.ColumnValue/README.md)>(sql: [SqlSource](../type.SqlSource/README.md), params?: [Params](../type.Params/README.md)): [ResultsetsPromise](../class.ResultsetsPromise/README.md)\<ColumnType>



#### ⚙ queryVoid(sql: [SqlSource](../type.SqlSource/README.md), params?: [Params](../type.Params/README.md)): Promise\<[Resultsets](../class.Resultsets/README.md)\<`void`>>



#### ⚙ queries\<ColumnType=[ColumnValue](../type.ColumnValue/README.md)>(sql: [SqlSource](../type.SqlSource/README.md), params?: [Params](../type.Params/README.md)): [ResultsetsPromise](../class.ResultsetsPromise/README.md)\<Record>



#### ⚙ queriesMap\<ColumnType=[ColumnValue](../type.ColumnValue/README.md)>(sql: [SqlSource](../type.SqlSource/README.md), params?: [Params](../type.Params/README.md)): [ResultsetsPromise](../class.ResultsetsPromise/README.md)\<Map\<`string`, ColumnType>>



#### ⚙ queriesArr\<ColumnType=[ColumnValue](../type.ColumnValue/README.md)>(sql: [SqlSource](../type.SqlSource/README.md), params?: [Params](../type.Params/README.md)): [ResultsetsPromise](../class.ResultsetsPromise/README.md)\<ColumnType\[]>



#### ⚙ queriesCol\<ColumnType=[ColumnValue](../type.ColumnValue/README.md)>(sql: [SqlSource](../type.SqlSource/README.md), params?: [Params](../type.Params/README.md)): [ResultsetsPromise](../class.ResultsetsPromise/README.md)\<ColumnType>



#### ⚙ queriesVoid(sql: [SqlSource](../type.SqlSource/README.md), params?: [Params](../type.Params/README.md)): Promise\<[Resultsets](../class.Resultsets/README.md)\<`void`>>



#### ⚙ makeLastColumnReadable\<ColumnType=[ColumnValue](../type.ColumnValue/README.md)>(sql: [SqlSource](../type.SqlSource/README.md), params?: [Params](../type.Params/README.md)): Promise\<`any`>

> Stream column contents as `ReadableStream`. If the resultset contains multiple columns, only the last one will be used (and others discarded).



#### ⚙ prepare\<ColumnType=[ColumnValue](../type.ColumnValue/README.md)>(sql: [SqlSource](../type.SqlSource/README.md)): Promise\<[Resultsets](../class.Resultsets/README.md)\<Record>>



#### ⚙ prepareMap\<ColumnType=[ColumnValue](../type.ColumnValue/README.md)>(sql: [SqlSource](../type.SqlSource/README.md)): Promise\<[Resultsets](../class.Resultsets/README.md)\<Map\<`string`, ColumnType>>>



#### ⚙ prepareArr\<ColumnType=[ColumnValue](../type.ColumnValue/README.md)>(sql: [SqlSource](../type.SqlSource/README.md)): Promise\<[Resultsets](../class.Resultsets/README.md)\<ColumnType\[]>>



#### ⚙ prepareCol\<ColumnType=[ColumnValue](../type.ColumnValue/README.md)>(sql: [SqlSource](../type.SqlSource/README.md)): Promise\<[Resultsets](../class.Resultsets/README.md)\<ColumnType>>



#### ⚙ prepareVoid(sql: [SqlSource](../type.SqlSource/README.md)): Promise\<[Resultsets](../class.Resultsets/README.md)\<`void`>>



#### ⚙ forPrepared\<ColumnType=[ColumnValue](../type.ColumnValue/README.md), T=`unknown`>(sql: [SqlSource](../type.SqlSource/README.md), callback: (prepared: [Resultsets](../class.Resultsets/README.md)\<Record\<`string`, ColumnType>>) => Promise\<T>): Promise\<T>



#### ⚙ forPreparedMap\<ColumnType=[ColumnValue](../type.ColumnValue/README.md), T=`unknown`>(sql: [SqlSource](../type.SqlSource/README.md), callback: (prepared: [Resultsets](../class.Resultsets/README.md)\<Map\<`string`, ColumnType>>) => Promise\<T>): Promise\<T>



#### ⚙ forPreparedArr\<ColumnType=[ColumnValue](../type.ColumnValue/README.md), T=`unknown`>(sql: [SqlSource](../type.SqlSource/README.md), callback: (prepared: [Resultsets](../class.Resultsets/README.md)\<ColumnType\[]>) => Promise\<T>): Promise\<T>



#### ⚙ forPreparedCol\<ColumnType=[ColumnValue](../type.ColumnValue/README.md), T=`unknown`>(sql: [SqlSource](../type.SqlSource/README.md), callback: (prepared: [Resultsets](../class.Resultsets/README.md)\<ColumnType>) => Promise\<T>): Promise\<T>



#### ⚙ forPreparedVoid\<T>(sql: [SqlSource](../type.SqlSource/README.md), callback: (prepared: [Resultsets](../class.Resultsets/README.md)\<`void`>) => Promise\<T>): Promise\<T>



#### ⚙ startTrx(options?: \{readonly?: `boolean`, xaId?: `string`, xaId1?: `string`}): Promise\<`void`>

> Commit current transaction (if any), and start new.
> This is lazy operation. The corresponding command will be sent to the server later (however commit of the current transaction will happen immediately).
> To start regular transaction, call `startTrx()` without parameters.
> To start READONLY transaction, pass `{readonly: true}`.
> To start distributed transaction, pass `{xaId: '...'}`.
> If you want `conn.connectionId` to be automatically appended to XA identifier, pass `{xaId1: '...'}`, where `xaId1` is the first part of the `xaId`.
> If connection to server was not yet established, the `conn.connectionId` is not known (and `startTrx()` will not connect), so `conn.connectionId` will be appended later on first query.



#### ⚙ savepoint(): `number`

> Creates transaction savepoint, and returns ID number of this new savepoint.
> Then you can call [conn.rollback(pointId)](../class.MyConn/README.md#-rollbacktopointid-number-promisevoid).
> This is lazy operation. The corresponding command will be sent to the server later.
> Calling `savepoint()` immediately followed by `rollback(pointId)` to this point will send no commands.



#### ⚙ prepareCommit(): Promise\<`void`>

> If the current transaction is of distributed type, this function prepares the 2-phase commit.
> Else does nothing.
> If this function succeeds, the transaction will be saved on the server till you call `commit()`.
> The saved transaction can survive server restart and unexpected halt.
> You need to commit it as soon as possible, to release all the locks that it holds.
> Usually, you want to prepare transactions on all servers, and immediately commit them if `prepareCommit()` succeeded, or rollback them if it failed.



#### ⚙ rollback(toPointId?: `number`): Promise\<`void`>

> Rollback to a savepoint, or all.
> If `toPointId` is not given or undefined - rolls back the whole transaction (XA transactions can be rolled back before `prepareCommit()` called, or after that).
> If `toPointId` is a number returned from `savepoint()` call, rolls back to that point (also works with XAs).
> If `toPointId` is `0`, rolls back to the beginning of transaction, and doesn't end this transaction (doesn't work with XAs).
> If rollback (not to savepoint) failed, will disconnect from server and throw ServerDisconnectedError.
> If `toPointId` was `0` (not for XAs), the transaction will be restarted after the disconnect if rollback failed.



#### ⚙ commit(andChain: `boolean`=false): Promise\<`void`>

> Commit.
> If the current transaction is XA, and you didn't call `prepareCommit()` i'll throw error.
> With `andChain` parameter will commit and then restart the same transaction (doesn't work with XAs).
> If commit fails will rollback and throw error. If rollback also fails, will disconnect from server and throw ServerDisconnectedError.



#### ⚙ setSqlLogger(sqlLogger?: [SqlLogger](../interface.SqlLogger/README.md) | `true`): `void`



#### ⚙ getNamedParamsQueries(protocol: [MyProtocol](../class.MyProtocol/README.md), params: Record\<`string`, [Param](../type.Param/README.md)>, letReturnUndefined: `boolean`): Promise\<\{stmtId: `number`, values: `any`\[], query1: Uint8Array}>



#### 📄 `protected` pendingTrxSql: `string`\[]



<div style="opacity:0.6">

#### ⚙ `deprecated` execute(sql: [SqlSource](../type.SqlSource/README.md), params?: [Params](../type.Params/README.md)): Promise\<[Resultsets](../class.Resultsets/README.md)\<`void`>>

> Alias of queryVoid().



#### ⚙ `deprecated` makeLastColumnReader\<ColumnType=[ColumnValue](../type.ColumnValue/README.md)>(sql: [SqlSource](../type.SqlSource/README.md), params?: [Params](../type.Params/README.md)): Promise\<`any`>

> Stream column contents as `Deno.Reader`. If the resultset contains multiple columns, only the last one will be used (and others discarded).

> `deprecated`
> 
> As `Deno.Reader` is deprecated, this method is deprecated as well.



#### ⚙ `deprecated` forQuery\<ColumnType=[ColumnValue](../type.ColumnValue/README.md), T=`unknown`>(sql: [SqlSource](../type.SqlSource/README.md), callback: (prepared: [Resultsets](../class.Resultsets/README.md)\<Record\<`string`, ColumnType>>) => Promise\<T>): Promise\<T>

> Deprecated alias of `forPrepared()`.



#### ⚙ `deprecated` forQueryMap\<ColumnType=[ColumnValue](../type.ColumnValue/README.md), T=`unknown`>(sql: [SqlSource](../type.SqlSource/README.md), callback: (prepared: [Resultsets](../class.Resultsets/README.md)\<Map\<`string`, ColumnType>>) => Promise\<T>): Promise\<T>

> Deprecated alias of `forPreparedMap()`.



#### ⚙ `deprecated` forQueryArr\<ColumnType=[ColumnValue](../type.ColumnValue/README.md), T=`unknown`>(sql: [SqlSource](../type.SqlSource/README.md), callback: (prepared: [Resultsets](../class.Resultsets/README.md)\<ColumnType\[]>) => Promise\<T>): Promise\<T>

> Deprecated alias of `forPreparedArr()`.



#### ⚙ `deprecated` forQueryCol\<ColumnType=[ColumnValue](../type.ColumnValue/README.md), T=`unknown`>(sql: [SqlSource](../type.SqlSource/README.md), callback: (prepared: [Resultsets](../class.Resultsets/README.md)\<ColumnType>) => Promise\<T>): Promise\<T>

> Deprecated alias of `forPreparedCol()`.



#### ⚙ `deprecated` forQueryVoid\<T>(sql: [SqlSource](../type.SqlSource/README.md), callback: (prepared: [Resultsets](../class.Resultsets/README.md)\<`void`>) => Promise\<T>): Promise\<T>

> Deprecated alias of `forPreparedVoid()`.



</div>

