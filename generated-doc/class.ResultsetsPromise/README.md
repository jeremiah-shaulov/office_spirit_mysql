# `class` ResultsetsPromise\<Row> `extends` Promise\<[Resultsets](../class.Resultsets/README.md)\<Row>>

[Documentation Index](../README.md)

```ts
import {ResultsetsPromise} from "https://deno.land/x/office_spirit_mysql@v0.21.1/mod.ts"
```

## This class has

- [constructor](#-constructorexecutor-resolve-value-t--promiseliket--void-reject-reason-any--void--void)
- 5 methods:
[all](#-all-promiserow),
[allStored](#-allstored-asynciterablerow-any-any),
[first](#-first-promiseany),
[forEach](#-foreachtcallback-row-row--t--promiset-promiset),
[\[Symbol.asyncIterator\]](#-symbolasynciterator-asyncgeneratorrow-any-any)
- base class


#### 🔧 `constructor`(executor: (resolve: (value: T | PromiseLike\<T>) => `void`, reject: (reason?: `any`) => `void`) => `void`)

> Creates a new Promise.
> 
> 🎚️ Parameter **executor**:
> 
> A callback used to initialize the promise. This callback is passed two arguments:
> a resolve callback used to resolve the promise with a value or the result of another promise,
> and a reject callback used to reject the promise with a provided reason or error.



#### ⚙ all(): Promise\<Row\[]>

> Reads all rows in the first resultset to an array.
> And if there're more resultsets, they will be skipped (discarded).



#### ⚙ allStored(): AsyncIterable\<Row, `any`, `any`>

> Reads all rows in the first resultset, and stores them either in memory or on disk.
> Other resultsets will be skipped (discarded).
> The threshold for storing on disk is set in DSN parameter [Dsn.storeResultsetIfBigger](../class.Dsn/README.md#-accessor-storeresultsetifbigger-number).
> Use this function if you want to read a large resultset, and iterate over it later,
> and being able to perform other queries in the meantime.



#### ⚙ first(): Promise\<`any`>

> Returns the first row of the first resultset.
> And if there're more rows or resultsets, they all will be skipped (discarded).



#### ⚙ forEach\<T>(callback: (row: Row) => T | Promise\<T>): Promise\<T>

> Reads all rows in the first resultset, and calls the provided callback for each of them.
> If there're more resultsets, they will be skipped (discarded).



#### ⚙ \[Symbol.asyncIterator](): AsyncGenerator\<Row, `any`, `any`>



