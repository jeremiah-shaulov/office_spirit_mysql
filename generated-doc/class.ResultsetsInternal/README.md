# `class` ResultsetsInternal\<Row> `extends` [Resultsets](../class.Resultsets/README.md)\<Row>

[Documentation Index](../README.md)

This library creates resultsets as ResultsetsInternal object, but exposes them as Resultsets.
Methods that don't exist on Resultsets are for internal use.

## This class has

- [constructor](#-constructorrowtype-rowtype)
- [destructor](#-symbolasyncdispose-promisevoid)
- 5 properties:
[protocol](#-protocol-myprotocol--undefined),
[isPreparedStmt](#-ispreparedstmt-boolean),
[stmtId](#-stmtid-number),
[hasMoreInternal](#-hasmoreinternal-boolean),
[rowType](#-rowtype-rowtype)
- 6 methods:
[exec](#-execparams-param-resultsetspromiserow),
[nextResultset](#-nextresultset-promiseboolean),
[discard](#-discard-promisevoid),
[disposePreparedStmt](#-disposepreparedstmt-void),
[resetFields](#-resetfields-void),
[\[Symbol.asyncIterator\]](#-symbolasynciterator-asyncgeneratorrow-any-any)


#### 🔧 `constructor`(rowType: [RowType](../enum.RowType/README.md))



#### 🔨 \[Symbol.asyncDispose](): Promise\<`void`>

> Calls `this.discard()` and if this is a prepared statement, deallocates it.



#### 📄 protocol: [MyProtocol](../class.MyProtocol/README.md) | `undefined`



#### 📄 isPreparedStmt: `boolean`



#### 📄 stmtId: `number`



#### 📄 hasMoreInternal: `boolean`



#### 📄 rowType: [RowType](../enum.RowType/README.md)



#### ⚙ exec(params: [Param](../type.Param/README.md)\[]): [ResultsetsPromise](../class.ResultsetsPromise/README.md)\<Row>

> If this is a prepared query, this function executes it again.



#### ⚙ nextResultset(): Promise\<`boolean`>

> Advances to the next resultset of this query, if there is one. Returns true if moved to the next resultset.



#### ⚙ discard(): Promise\<`void`>

> Reads and discards all the rows in all the resultsets of this query.



#### ⚙ disposePreparedStmt(): `void`



#### ⚙ resetFields(): `void`



#### ⚙ \[Symbol.asyncIterator](): AsyncGenerator\<Row, `any`, `any`>



