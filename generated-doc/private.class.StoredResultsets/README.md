# `class` StoredResultsets\<Row>

[Documentation Index](../README.md)

## This class has

- [constructor](#-constructorresultsets-resultsetsinternalrow-rowtype-rowtype-jsonasstring-boolean-datesasstring-boolean-tz-gettimezonemsecoffsetfromsystem---number-decoder-textdecoder-resultsetsinfo-arraynrows-number-columns-column-lastinsertid-number--bigint-affectedrows-number--bigint-foundrows-number--bigint-warnings-number-statusinfo-string-nogoodindexused-boolean-noindexused-boolean-isslowquery-boolean-nplaceholders-number-storedrows-columnvalue-filename-string-file-denofsfile-writer-writablestreamdefaultwriteruint8arrayarraybufferlike-reader-readablestreambyobreader-serializer-myprotocolreaderwriterserializer)
- [destructor](#-symbolasyncdispose-promisevoid)
- 16 properties:
[nResultset](#-nresultset-number),
[nRow](#-nrow-number),
[hasMore](#-get-hasmore-boolean),
[resultsets](#-resultsets-resultsetsinternalrow),
[rowType](#-rowtype-rowtype),
[jsonAsString](#-jsonasstring-boolean),
[datesAsString](#-datesasstring-boolean),
[tz](#-tz-gettimezonemsecoffsetfromsystem---number),
[decoder](#-decoder-textdecoder),
[resultsetsInfo](#-resultsetsinfo-arraynrows-number-columns-column-lastinsertid-number--bigint-affectedrows-number--bigint-foundrows-number--bigint-warnings-number-statusinfo-string-nogoodindexused-boolean-noindexused-boolean-isslowquery-boolean-nplaceholders-number),
[storedRows](#-storedrows-columnvalue),
[fileName](#-filename-string),
[file](#-file-denofsfile),
[writer](#-writer-writablestreamdefaultwriteruint8arrayarraybufferlike),
[reader](#-reader-readablestreambyobreader),
[serializer](#-serializer-myprotocolreaderwriterserializer)
- 3 methods:
[nextResultset](#-nextresultset-nrows-number-columns-column-lastinsertid-number--bigint-affectedrows-number--bigint-foundrows-number--bigint-warnings-number-statusinfo-string-nogoodindexused-boolean-noindexused-boolean-isslowquery-boolean-nplaceholders-number),
[discard](#-discard-promisevoid),
[\[Symbol.asyncIterator\]](#-symbolasynciterator-asyncgeneratorrow-any-any)


#### 🔧 `constructor`(resultsets: [ResultsetsInternal](../class.ResultsetsInternal/README.md)\<Row>, rowType: [RowType](../enum.RowType/README.md), jsonAsString: `boolean`, datesAsString: `boolean`, tz: \{getTimezoneMsecOffsetFromSystem: () => `number`}, decoder: TextDecoder, resultsetsInfo: Array\<\{nRows: `number`, columns: [Column](../class.Column/README.md)\[], lastInsertId: `number` | `bigint`, affectedRows: `number` | `bigint`, foundRows: `number` | `bigint`, warnings: `number`, statusInfo: `string`, noGoodIndexUsed: `boolean`, noIndexUsed: `boolean`, isSlowQuery: `boolean`, nPlaceholders: `number`}>, storedRows: [ColumnValue](../type.ColumnValue/README.md)\[]\[], fileName: `string`="", file?: Deno.FsFile, writer?: WritableStreamDefaultWriter\<Uint8Array\<ArrayBufferLike>>, reader?: ReadableStreamBYOBReader, serializer?: [MyProtocolReaderWriterSerializer](../class.MyProtocolReaderWriterSerializer/README.md))



#### 🔨 \[Symbol.asyncDispose](): Promise\<`void`>



#### 📄 nResultset: `number`



#### 📄 nRow: `number`



#### 📄 `get` hasMore(): `boolean`



#### 📄 resultsets: [ResultsetsInternal](../class.ResultsetsInternal/README.md)\<Row>



#### 📄 rowType: [RowType](../enum.RowType/README.md)



#### 📄 jsonAsString: `boolean`



#### 📄 datesAsString: `boolean`



#### 📄 tz: \{getTimezoneMsecOffsetFromSystem: () => `number`}



#### 📄 decoder: TextDecoder



#### 📄 resultsetsInfo: Array\<\{nRows: `number`, columns: [Column](../class.Column/README.md)\[], lastInsertId: `number` | `bigint`, affectedRows: `number` | `bigint`, foundRows: `number` | `bigint`, warnings: `number`, statusInfo: `string`, noGoodIndexUsed: `boolean`, noIndexUsed: `boolean`, isSlowQuery: `boolean`, nPlaceholders: `number`}>



#### 📄 storedRows: [ColumnValue](../type.ColumnValue/README.md)\[]\[]



#### 📄 fileName: `string`



#### 📄 file?: Deno.FsFile



#### 📄 writer?: WritableStreamDefaultWriter\<Uint8Array\<ArrayBufferLike>>



#### 📄 reader?: ReadableStreamBYOBReader



#### 📄 serializer?: [MyProtocolReaderWriterSerializer](../class.MyProtocolReaderWriterSerializer/README.md)



#### ⚙ nextResultset(): \{nRows: `number`, columns: Column\[], lastInsertId: `number` | `bigint`, affectedRows: `number` | `bigint`, foundRows: `number` | `bigint`, warnings: `number`, statusInfo: `string`, noGoodIndexUsed: `boolean`, noIndexUsed: `boolean`, isSlowQuery: `boolean`, nPlaceholders: `number`}



#### ⚙ discard(): Promise\<`void`>

> Marks all remaining resultsets as read, and releases the associated resources (like the temporary file, if the rows were stored on disk).



#### ⚙ \[Symbol.asyncIterator](): AsyncGenerator\<Row, `any`, `any`>



