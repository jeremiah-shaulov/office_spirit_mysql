# `class` ResultsetsInternal\<Row> `extends` [Resultsets](../class.Resultsets/README.md)\<Row>

[Documentation Index](../README.md)

This library creates resultsets as ResultsetsInternal object, but exposes them as Resultsets.
Methods that don't exist on Resultsets are for internal use.

## This class has

- [constructor](#-constructorrowtype-rowtype)
- [destructor](#-override-symbolasyncdispose-promisevoid)
- 6 properties:
[protocol](#-protocol-myprotocol--undefined),
[isPreparedStmt](#-ispreparedstmt-boolean),
[stmtId](#-stmtid-number),
[hasMoreInternal](#-hasmoreinternal-boolean),
[rowType](#-rowtype-rowtype),
[hasMore](#-override-get-hasmore-boolean)
- 7 methods:
[exec](#-override-execparams-param-resultsetspromiserow),
[nextResultset](#-override-nextresultset-promiseboolean),
[discard](#-override-discard-promisevoid),
[disposePreparedStmt](#-disposepreparedstmt-void),
[resetFields](#-resetfields-void),
[allStored](#-override-allstored-asynciterablerow-any-any),
[\[Symbol.asyncIterator\]](#-override-symbolasynciterator-asyncgeneratorrow-any-any)
- 14 inherited members from [Resultsets](../class.Resultsets/README.md)


#### 🔧 `constructor`(rowType: [RowType](../enum.RowType/README.md))



#### 🔨 `override` \[Symbol.asyncDispose](): Promise\<`void`>

> Calls `this.discard()` and if this is a prepared statement, deallocates it.



#### 📄 protocol: [MyProtocol](../class.MyProtocol/README.md) | `undefined`



#### 📄 isPreparedStmt: `boolean`



#### 📄 stmtId: `number`



#### 📄 hasMoreInternal: `boolean`



#### 📄 rowType: [RowType](../enum.RowType/README.md)



#### 📄 `override` `get` hasMore(): `boolean`

> True if there are more rows or resultsets to read.



#### ⚙ `override` exec(params: [Param](../type.Param/README.md)\[]): [ResultsetsPromise](../class.ResultsetsPromise/README.md)\<Row>

> If this is a prepared query, this function executes it again.



#### ⚙ `override` nextResultset(): Promise\<`boolean`>

> Advances to the next resultset of this query, if there is one. Returns true if moved to the next resultset.



#### ⚙ `override` discard(): Promise\<`void`>

> Reads and discards all the rows in all the resultsets of this query.



#### ⚙ disposePreparedStmt(): `void`



#### ⚙ resetFields(): `void`



#### ⚙ `override` allStored(): AsyncIterable\<Row, `any`, `any`>

> Reads all rows in current resultset, and stores them either in memory or on disk.
> The threshold for storing on disk is set in DSN parameter [Dsn.storeResultsetIfBigger](../class.Dsn/README.md#-accessor-storeresultsetifbigger-number).
> Use this function if you want to read a large resultset, and iterate over it later,
> and being able to perform other queries in the meantime.



#### ⚙ `override` \[Symbol.asyncIterator](): AsyncGenerator\<Row, `any`, `any`>



