# `class` ResultsetsPromise\<Row> `extends` Promise\<[Resultsets](../class.Resultsets/README.md)\<Row>>

[Documentation Index](../README.md)

```ts
import {ResultsetsPromise} from "https://deno.land/x/office_spirit_mysql@v0.19.5/mod.ts"
```

## This class has

- [constructor](#-constructorexecutor-resolve-value-t--promiseliket--void-reject-reason-any--void--void)
- 4 methods:
[all](#-all-promiserow),
[first](#-first-promiseany),
[forEach](#-foreachtcallback-row-row--t--promiset-promiset),
[\[Symbol.asyncIterator\]](#-symbolasynciterator-asyncgeneratorrow-any-any)


#### 🔧 `constructor`(executor: (resolve: (value: T | PromiseLike\<T>) => `void`, reject: (reason?: `any`) => `void`) => `void`)

> Creates a new Promise.



#### ⚙ all(): Promise\<Row\[]>

> Reads all rows in the first resultset to an array.
> And if there're more resultsets, they will be skipped (discarded).



#### ⚙ first(): Promise\<`any`>

> Returns the first row of the first resultset.
> And if there're more rows or resultsets, they all will be skipped (discarded).



#### ⚙ forEach\<T>(callback: (row: Row) => T | Promise\<T>): Promise\<T>

> Reads all rows in the first resultset, and calls the provided callback for each of them.
> If there're more resultsets, they will be skipped (discarded).



#### ⚙ \[Symbol.asyncIterator](): AsyncGenerator\<Row, `any`, `any`>



