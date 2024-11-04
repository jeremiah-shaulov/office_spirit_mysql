# `interface` SafeSqlLoggerQuery

[Documentation Index](../README.md)

Like [SqlLoggerQuery](../interface.SqlLoggerQuery/README.md), but all functions are non-optional, and uses `paramStart()` instead of `nParam` argument in `appendToParam()` and `paramEnd()`.

## This interface has

- 8 properties:
[appendToQuery](#-appendtoquery-data-uint8array--promiseunknown),
[setStmtId](#-setstmtid-stmtid-number--promiseunknown),
[paramStart](#-paramstart-nparam-number--void),
[appendToParam](#-appendtoparam-data-uint8array--number--bigint--promiseunknown),
[paramEnd](#-paramend---promiseunknown),
[nextQuery](#-nextquery---promiseunknown),
[start](#-start---promiseunknown),
[end](#-end-result-resultsetsunknown--error--undefined-stmtid-number--promiseunknown)


#### 📄 appendToQuery: (data: Uint8Array) => Promise\<`unknown`>



#### 📄 setStmtId: (stmtId: `number`) => Promise\<`unknown`>



#### 📄 paramStart: (nParam: `number`) => `void`



#### 📄 appendToParam: (data: Uint8Array | `number` | `bigint`) => Promise\<`unknown`>



#### 📄 paramEnd: () => Promise\<`unknown`>



#### 📄 nextQuery: () => Promise\<`unknown`>



#### 📄 start: () => Promise\<`unknown`>



#### 📄 end: (result: [Resultsets](../class.Resultsets/README.md)\<`unknown`> | Error | `undefined`, stmtId: `number`) => Promise\<`unknown`>



