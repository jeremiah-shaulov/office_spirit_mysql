# `class` MyProtocolReaderWriterSerializer `extends` [MyProtocolReaderWriter](../class.MyProtocolReaderWriter/README.md)

[Documentation Index](../README.md)

## This class has

- [constructor](#-constructorwriter-writablestreamdefaultwriteruint8array-reader-readablestreambyobreader-decoder-textdecoder-usebuffer-uint8array--undefined)
- 5 methods:
[serializeBegin](#-serializebegin-void),
[serializeRowBinary](#-serializerowbinaryrow-columnvalue-columns-column-datesasstring-boolean-tz-gettimezonemsecoffsetfromsystem---number-promisevoid),
[serializeEnd](#-serializeend-promisevoid),
[deserializeRowBinary](#-deserializerowbinaryrowtype-rowtype-columns-column-jsonasstring-boolean-datesasstring-boolean-tz-gettimezonemsecoffsetfromsystem---number-maxcolumnlen-number-isforserialize-booleanfalse-promiserow-any-lastcolumnreaderlen-number),
[deserializeRowText](#-deserializerowtextrowtype-rowtype-columns-column-jsonasstring-boolean-datesasstring-boolean-tz-gettimezonemsecoffsetfromsystem---number-maxcolumnlen-number-isforserialize-booleanfalse-promiserow-any-lastcolumnreaderlen-number)
- 26 inherited members from [MyProtocolReaderWriter](../class.MyProtocolReaderWriter/README.md), 59 from [MyProtocolReader](../class.MyProtocolReader/README.md)


#### 🔧 `constructor`(writer: WritableStreamDefaultWriter\<Uint8Array>, reader: ReadableStreamBYOBReader, decoder: TextDecoder, useBuffer: Uint8Array | `undefined`)



#### ⚙ serializeBegin(): `void`



#### ⚙ serializeRowBinary(row: [ColumnValue](../type.ColumnValue/README.md)\[], columns: [Column](../class.Column/README.md)\[], datesAsString: `boolean`, tz: \{getTimezoneMsecOffsetFromSystem: () => `number`}): Promise\<`void`>

> Serialize a row, so it can be stored to a file.
> This uses the same format as Mysql binary protocol, so the `deserializeRowBinary()` counterpart method
> can be used for 2 purposes: deserializing the row back into Javascript object, and reading the row from the MySQL server.



#### ⚙ serializeEnd(): Promise\<`void`>

> Call this method after you serialized all rows.



#### ⚙ deserializeRowBinary(rowType: [RowType](../enum.RowType/README.md), columns: [Column](../class.Column/README.md)\[], jsonAsString: `boolean`, datesAsString: `boolean`, tz: \{getTimezoneMsecOffsetFromSystem: () => `number`}, maxColumnLen: `number`, isForSerialize: `boolean`=false): Promise\<\{row: `any`, lastColumnReaderLen: `number`}>

> Reads a row from the MySQL server, or from another readable stream (like file), and deserializes it into a Javascript object.
> It deals with the MySQL binary protocol.



#### ⚙ deserializeRowText(rowType: [RowType](../enum.RowType/README.md), columns: [Column](../class.Column/README.md)\[], jsonAsString: `boolean`, datesAsString: `boolean`, tz: \{getTimezoneMsecOffsetFromSystem: () => `number`}, maxColumnLen: `number`, isForSerialize: `boolean`=false): Promise\<\{row: `any`, lastColumnReaderLen: `number`}>

> Reads a row from the MySQL server when using text protocol, and deserializes it into a Javascript object.



