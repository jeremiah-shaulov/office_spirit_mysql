# `class` StoredResultsets\<Row>

[Documentation Index](../README.md)

## This class has

- [constructor](#-constructorresultsets-resultsetsinternalrow-rowtype-rowtype-jsonasstring-boolean-datesasstring-boolean-tz-gettimezonemsecoffsetfromsystem-atmsec-number--number-decoder-textdecoder-resultsetsinfo-arraynrows-number-columns-column-lastinsertid-number--bigint-affectedrows-number--bigint-foundrows-number--bigint-warnings-number-statusinfo-string-nogoodindexused-boolean-noindexused-boolean-isslowquery-boolean-nplaceholders-number-storedrows-columnvalue-filename-string-file-denofsfile-writer-writablestreamdefaultwriteruint8arrayarraybufferlike-reader-readablestreambyobreader-serializer-myprotocolreaderwriterserializer)
- [destructor](#-symbolasyncdispose-promisevoid)
- 19 properties:
[nResultset](#-nresultset-number),
[nRow](#-nrow-number),
[nRowInCurrent](#-nrowincurrent-number),
[readingStarted](#-readingstarted-boolean),
[advancedByIteration](#-advancedbyiteration-boolean),
[hasMore](#-get-hasmore-boolean),
[resultsets](#-resultsets-resultsetsinternalrow),
[rowType](#-rowtype-rowtype),
[jsonAsString](#-jsonasstring-boolean),
[datesAsString](#-datesasstring-boolean),
[tz](#-tz-gettimezonemsecoffsetfromsystem-atmsec-number--number),
[decoder](#-decoder-textdecoder),
[resultsetsInfo](#-resultsetsinfo-arraynrows-number-columns-column-lastinsertid-number--bigint-affectedrows-number--bigint-foundrows-number--bigint-warnings-number-statusinfo-string-nogoodindexused-boolean-noindexused-boolean-isslowquery-boolean-nplaceholders-number),
[storedRows](#-storedrows-columnvalue),
[fileName](#-filename-string),
[file](#-file-denofsfile),
[writer](#-writer-writablestreamdefaultwriteruint8arrayarraybufferlike),
[reader](#-reader-readablestreambyobreader),
[serializer](#-serializer-myprotocolreaderwriterserializer)
- 6 methods:
[loadResultsetInfo](#-loadresultsetinfo-nrows-number-columns-column-lastinsertid-number--bigint-affectedrows-number--bigint-foundrows-number--bigint-warnings-number-statusinfo-string-nogoodindexused-boolean-noindexused-boolean-isslowquery-boolean-nplaceholders-number),
[beginReading](#-beginreadingfile-denofsfile-serializer-myprotocolreaderwriterserializer-promisevoid),
[skipCurrentResultset](#-skipcurrentresultset-promisevoid),
[nextResultset](#-nextresultset-promiseboolean),
[discard](#-discard-promisevoid),
[\[Symbol.asyncIterator\]](#-symbolasynciterator-asyncgeneratorrow-any-any)


#### 🔧 `constructor`(resultsets: [ResultsetsInternal](../class.ResultsetsInternal/README.md)\<Row>, rowType: [RowType](../enum.RowType/README.md), jsonAsString: `boolean`, datesAsString: `boolean`, tz: \{getTimezoneMsecOffsetFromSystem: (atMsec: `number`) => `number`}, decoder: TextDecoder, resultsetsInfo: Array\<\{nRows: `number`, columns: [Column](../class.Column/README.md)\[], lastInsertId: `number` | `bigint`, affectedRows: `number` | `bigint`, foundRows: `number` | `bigint`, warnings: `number`, statusInfo: `string`, noGoodIndexUsed: `boolean`, noIndexUsed: `boolean`, isSlowQuery: `boolean`, nPlaceholders: `number`}>, storedRows: [ColumnValue](../type.ColumnValue/README.md)\[]\[], fileName: `string`="", file?: Deno.FsFile, writer?: WritableStreamDefaultWriter\<Uint8Array\<ArrayBufferLike>>, reader?: ReadableStreamBYOBReader, serializer?: [MyProtocolReaderWriterSerializer](../class.MyProtocolReaderWriterSerializer/README.md))



#### 🔨 \[Symbol.asyncDispose](): Promise\<`void`>



#### 📄 nResultset: `number`



#### 📄 nRow: `number`



#### 📄 nRowInCurrent: `number`



#### 📄 readingStarted: `boolean`



#### 📄 advancedByIteration: `boolean`



#### 📄 `get` hasMore(): `boolean`



#### 📄 resultsets: [ResultsetsInternal](../class.ResultsetsInternal/README.md)\<Row>



#### 📄 rowType: [RowType](../enum.RowType/README.md)



#### 📄 jsonAsString: `boolean`



#### 📄 datesAsString: `boolean`



#### 📄 tz: \{getTimezoneMsecOffsetFromSystem: (atMsec: `number`) => `number`}



#### 📄 decoder: TextDecoder



#### 📄 resultsetsInfo: Array\<\{nRows: `number`, columns: [Column](../class.Column/README.md)\[], lastInsertId: `number` | `bigint`, affectedRows: `number` | `bigint`, foundRows: `number` | `bigint`, warnings: `number`, statusInfo: `string`, noGoodIndexUsed: `boolean`, noIndexUsed: `boolean`, isSlowQuery: `boolean`, nPlaceholders: `number`}>



#### 📄 storedRows: [ColumnValue](../type.ColumnValue/README.md)\[]\[]



#### 📄 fileName: `string`



#### 📄 file?: Deno.FsFile



#### 📄 writer?: WritableStreamDefaultWriter\<Uint8Array\<ArrayBufferLike>>



#### 📄 reader?: ReadableStreamBYOBReader



#### 📄 serializer?: [MyProtocolReaderWriterSerializer](../class.MyProtocolReaderWriterSerializer/README.md)



#### ⚙ loadResultsetInfo(): \{nRows: `number`, columns: Column\[], lastInsertId: `number` | `bigint`, affectedRows: `number` | `bigint`, foundRows: `number` | `bigint`, warnings: `number`, statusInfo: `string`, noGoodIndexUsed: `boolean`, noIndexUsed: `boolean`, isSlowQuery: `boolean`, nPlaceholders: `number`}

> Copies the information of the current resultset to the parent `Resultsets` object
> (like reading a resultset header does in the live protocol), and returns it.



#### ⚙ beginReading(file: Deno.FsFile, serializer: [MyProtocolReaderWriterSerializer](../class.MyProtocolReaderWriterSerializer/README.md)): Promise\<`void`>

> For rows stored on disk: switches the store from writing to reading, if not yet done -
> flushes what remains buffered to the file, and rewinds the file to the beginning.



#### ⚙ skipCurrentResultset(): Promise\<`void`>

> Reads and discards the rows that remain unread in the current resultset - like the live protocol does
> when `nextResultset()` is called before all the rows are read, or when the iteration is abandoned.



#### ⚙ nextResultset(): Promise\<`boolean`>

> Skips the rows that remain unread in the current resultset, and advances to the next one,
> mirroring what `nextResultset()` does in the live protocol.
> Returns true if there was a next resultset to advance to, and false if the current one was the last
> (then the associated resources, like the temporary file, are released).
> If iterating the current resultset to the end has already advanced to the next one
> (see `advancedByIteration`), only acknowledges this, without skipping the new current resultset.



#### ⚙ discard(): Promise\<`void`>

> Marks all remaining resultsets as read, and releases the associated resources (like the temporary file, if the rows were stored on disk).



#### ⚙ \[Symbol.asyncIterator](): AsyncGenerator\<Row, `any`, `any`>



