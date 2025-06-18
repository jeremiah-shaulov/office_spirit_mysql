# `class` ResultsetsInternal\<Row> `extends` [Resultsets](../class.Resultsets/README.md)\<Row>

[Documentation Index](../README.md)

This library creates resultsets as ResultsetsInternal object, but exposes them as Resultsets.
Methods that don't exist on Resultsets are for internal use.

## This class has

- [constructor](#-constructorrowtype-rowtype-maxcolumnlen-number-jsonasstring-boolean-datesasstring-boolean-correctdates-boolean)
- [destructor](#-override-symbolasyncdispose-promisevoid)
- 11 properties:
[protocol](#-protocol-myprotocol--undefined),
[isPreparedStmt](#-ispreparedstmt-boolean),
[stmtId](#-stmtid-number),
[hasMoreInternal](#-hasmoreinternal-boolean),
[storedResultsets](#-storedresultsets-storedresultsetsrow--undefined),
[rowType](#-readonly-rowtype-rowtype),
[maxColumnLen](#-readonly-maxcolumnlen-number),
[jsonAsString](#-readonly-jsonasstring-boolean),
[datesAsString](#-readonly-datesasstring-boolean),
[correctDates](#-readonly-correctdates-boolean),
[hasMore](#-override-get-hasmore-boolean)
- 7 methods:
[exec](#-override-execparams-param-resultsetspromiserow),
[nextResultset](#-override-nextresultset-promiseboolean),
[discard](#-override-discard-promisevoid),
[disposePreparedStmt](#-disposepreparedstmt-void),
[resetFields](#-resetfields-void),
[store](#-override-storeallresultsets-booleanfalse-promisethis),
[\[Symbol.asyncIterator\]](#-override-symbolasynciterator-asyncgeneratorrow-any-any)
- 14 inherited members from [Resultsets](../class.Resultsets/README.md)


#### 🔧 `constructor`(rowType: [RowType](../enum.RowType/README.md), maxColumnLen: `number`, jsonAsString: `boolean`, datesAsString: `boolean`, correctDates: `boolean`)



#### 🔨 `override` \[Symbol.asyncDispose](): Promise\<`void`>

> Calls `this.discard()` and if this is a prepared statement, deallocates it.



#### 📄 protocol: [MyProtocol](../class.MyProtocol/README.md) | `undefined`



#### 📄 isPreparedStmt: `boolean`



#### 📄 stmtId: `number`



#### 📄 hasMoreInternal: `boolean`



#### 📄 storedResultsets: [StoredResultsets](../private.class.StoredResultsets/README.md)\<Row> | `undefined`



#### 📄 `readonly` rowType: [RowType](../enum.RowType/README.md)



#### 📄 `readonly` maxColumnLen: `number`



#### 📄 `readonly` jsonAsString: `boolean`



#### 📄 `readonly` datesAsString: `boolean`



#### 📄 `readonly` correctDates: `boolean`



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



#### ⚙ `override` store(allResultsets: `boolean`=false): Promise\<`this`>

> Reads all rows of the first resultset in this object (if `allResultsets` is false)
> or of all resultsets in this object (if `allResultsets` is true), and stores them either in memory or on disk.
> Other resultsets will be discarded (if `allResultsets` is false).
> 
> After the call this `Resultsets` object is detached from the connection,
> so you can perform other queries while you iterate over this object.
> 
> The threshold for storing on disk is set in DSN parameter [Dsn.storeResultsetIfBigger](../class.Dsn/README.md#-accessor-storeresultsetifbigger-number).
> 
> You need to read this object to the end to release the file resource.
> Or you can call `await resultsets.discard()` or to bind this `Resultsets` object to an `await using` variable.



#### ⚙ `override` \[Symbol.asyncIterator](): AsyncGenerator\<Row, `any`, `any`>



