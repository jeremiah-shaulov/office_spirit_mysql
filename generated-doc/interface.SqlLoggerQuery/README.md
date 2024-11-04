# `interface` SqlLoggerQuery

[Documentation Index](../README.md)

1. First one of `appendToQuery()` or `setStmtId()` is called.
To start writing a regular query, `appendToQuery()` is called one or multiple times.
To write a prepared query, `setStmtId()` is called (once).
2. Then, in case of prepared query, a sequence of `appendToParam()` (one or multiple times) and `paramEnd()` can be called.
3. Then, if writing queries batch, `nextQuery()` is called, and the process repeats from the beginning.
4. Then, after all the queries in batch are written, `start()` is called. At this point queries are sent to the database server.
5. Then, when the server responds, `end()` is called.

## This interface has

- 7 properties:
[appendToQuery](#-appendtoquery-data-uint8array--promiseunknown),
[setStmtId](#-setstmtid-stmtid-number--promiseunknown),
[appendToParam](#-appendtoparam-nparam-number-data-uint8array--number--bigint--promiseunknown),
[paramEnd](#-paramend-nparam-number--promiseunknown),
[nextQuery](#-nextquery---promiseunknown),
[start](#-start---promiseunknown),
[end](#-end-result-resultsetsunknown--error--undefined-stmtid-number--promiseunknown)


#### 📄 appendToQuery?: (data: Uint8Array) => Promise\<`unknown`>



#### 📄 setStmtId?: (stmtId: `number`) => Promise\<`unknown`>



#### 📄 appendToParam?: (nParam: `number`, data: Uint8Array | `number` | `bigint`) => Promise\<`unknown`>



#### 📄 paramEnd?: (nParam: `number`) => Promise\<`unknown`>



#### 📄 nextQuery?: () => Promise\<`unknown`>



#### 📄 start?: () => Promise\<`unknown`>



#### 📄 end?: (result: [Resultsets](../class.Resultsets/README.md)\<`unknown`> | Error | `undefined`, stmtId: `number`) => Promise\<`unknown`>

> If this was query preparation (`SqlLogger.query(_, _, true)`), `stmtId` will be the statement ID that the server returned.
> Else `stmtId` will be `-1`.



