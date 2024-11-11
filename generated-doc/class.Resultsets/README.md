# `class` Resultsets\<Row>

[Documentation Index](../README.md)

```ts
import {Resultsets} from "https://deno.land/x/office_spirit_mysql@v0.19.6/mod.ts"
```

## This class has

- [constructor](#-constructorcolumns-column-lastinsertid-number--bigint0-affectedrows-number--bigint0-foundrows-number--bigint0-warnings-number0-statusinfo-string-nogoodindexused-booleanfalse-noindexused-booleanfalse-isslowquery-booleanfalse-nplaceholders-number0)
- [destructor](#-symbolasyncdispose-promisevoid)
- 11 properties:
[columns](#-columns-column),
[lastInsertId](#-lastinsertid-number--bigint),
[affectedRows](#-affectedrows-number--bigint),
[foundRows](#-foundrows-number--bigint),
[warnings](#-warnings-number),
[statusInfo](#-statusinfo-string),
[noGoodIndexUsed](#-nogoodindexused-boolean),
[noIndexUsed](#-noindexused-boolean),
[isSlowQuery](#-isslowquery-boolean),
[nPlaceholders](#-nplaceholders-number),
[hasMore](#-get-hasmore-boolean)
- 7 methods:
[exec](#-exec_params-param-resultsetspromiserow),
[all](#-all-promiserow),
[first](#-first-promiserow),
[forEach](#-foreachtcallback-row-row--t--promiset-promiset),
[nextResultset](#-nextresultset-promiseboolean),
[discard](#-discard-promisevoid),
[\[Symbol.asyncIterator\]](#-symbolasynciterator-asyncgeneratorrow-any-any)


#### 🔧 `constructor`(columns: [Column](../class.Column/README.md)\[]=\[], lastInsertId: `number` | `bigint`=0, affectedRows: `number` | `bigint`=0, foundRows: `number` | `bigint`=0, warnings: `number`=0, statusInfo: `string`="", noGoodIndexUsed: `boolean`=false, noIndexUsed: `boolean`=false, isSlowQuery: `boolean`=false, nPlaceholders: `number`=0)



#### 🔨 \[Symbol.asyncDispose](): Promise\<`void`>

> Calls `this.discard()` and if this is a prepared statement, deallocates it.



#### 📄 columns: [Column](../class.Column/README.md)\[]

> Information about columns in resultset.



#### 📄 lastInsertId: `number` | `bigint`

> In INSERT queries this is last generated AUTO_INCREMENT ID



#### 📄 affectedRows: `number` | `bigint`

> In modifying queries, like INSERT, UPDATE and DELETE this shows how many rows were affected by the query



#### 📄 foundRows: `number` | `bigint`

> If "foundRows" connection attribute is set, will ask the server to report about "found rows" (matched by the WHERE clause), instead of affected, and "affectedRows" will not be used. See [this page](https://dev.mysql.com/doc/c-api/5.7/en/mysql-affected-rows.html) for more information.



#### 📄 warnings: `number`

> Number of warnings produced by the last query. To see the warning messages you can use `SHOW WARNINGS` query.



#### 📄 statusInfo: `string`

> Human-readable information about last query result, if sent by server.



#### 📄 noGoodIndexUsed: `boolean`

> Server can report about nonoptimal queries.



#### 📄 noIndexUsed: `boolean`



#### 📄 isSlowQuery: `boolean`



#### 📄 nPlaceholders: `number`

> Number of `?`-placeholders in the SQL query.



#### 📄 `get` hasMore(): `boolean`

> True if there are more rows or resultsets to read.



#### ⚙ exec(\_params: [Param](../type.Param/README.md)\[]): [ResultsetsPromise](../class.ResultsetsPromise/README.md)\<Row>

> If this is a prepared query, this function executes it again.



#### ⚙ all(): Promise\<Row\[]>

> Reads all rows in current resultset to an array.



#### ⚙ first(): Promise\<Row>

> Reads all rows in current resultset, and returns the first row.



#### ⚙ forEach\<T>(callback: (row: Row) => T | Promise\<T>): Promise\<T>

> Reads all rows in current resultset, and calls the provided callback for each of them.



#### ⚙ nextResultset(): Promise\<`boolean`>

> Advances to the next resultset of this query, if there is one. Returns true if moved to the next resultset.



#### ⚙ discard(): Promise\<`void`>

> Reads and discards all the rows in all the resultsets of this query.



#### ⚙ \[Symbol.asyncIterator](): AsyncGenerator\<Row, `any`, `any`>

> Iterates over rows in current resultset.



