# `class` MyProtocolReader

[Documentation Index](../README.md)

## This class has

- [constructor](#-constructorreader-readablestreambyobreader-decoder-textdecoder-usebuffer-uint8array--undefined)
- 2 properties:
[totalBytesInPacket](#-totalbytesinpacket-number),
[decoder](#-decoder-textdecoder)
- method [recycleBuffer](#-recyclebuffer-uint8arrayarraybufferlike)
- 10 protected properties:
[buffer](#-protected-buffer-uint8array),
[bufferStart](#-protected-bufferstart-number),
[bufferEnd](#-protected-bufferend-number),
[sequenceId](#-protected-sequenceid-number),
[payloadLength](#-protected-payloadlength-number),
[packetOffset](#-protected-packetoffset-number),
[compression](#-protected-compression-compression),
[zstdLevel](#-protected-zstdlevel-number),
[compressedSeqId](#-protected-compressedseqid-number),
[reader](#-protected-reader-readablestreambyobreader)
- 50 protected methods:
[isAtEndOfPacket](#-protected-isatendofpacket-boolean),
[gotoEndOfPacket](#-protected-gotoendofpacket-boolean),
[gotoEndOfPacketAsync](#-protected-gotoendofpacketasync-promisevoid),
[unput](#-protected-unputbyte-number-void),
[readFromConn](#-protected-readfromconnv-extends-uint8arrayview-v-promisereadablestreamreadresultv),
[readPacketHeader](#-protected-readpacketheader-boolean),
[readPacketHeaderAsync](#-protected-readpacketheaderasync-promisevoid),
[readUint8](#-protected-readuint8-number),
[readUint8Async](#-protected-readuint8async-promisenumber),
[readInt8](#-protected-readint8-number),
[readInt8Async](#-protected-readint8async-promisenumber),
[readUint16](#-protected-readuint16-number),
[readUint16Async](#-protected-readuint16async-promisenumber),
[readInt16](#-protected-readint16-number),
[readInt16Async](#-protected-readint16async-promisenumber),
[readUint24](#-protected-readuint24-number),
[readUint24Async](#-protected-readuint24async-promisenumber),
[readUint32](#-protected-readuint32-number),
[readUint32Async](#-protected-readuint32async-promisenumber),
[readInt32](#-protected-readint32-number),
[readInt32Async](#-protected-readint32async-promisenumber),
[readUint64](#-protected-readuint64-bigint),
[readUint64Async](#-protected-readuint64async-promisebigint),
[readInt64](#-protected-readint64-bigint),
[readInt64Async](#-protected-readint64async-promisebigint),
[readFloat](#-protected-readfloat-number),
[readFloatAsync](#-protected-readfloatasync-promisenumber),
[readDouble](#-protected-readdouble-number),
[readDoubleAsync](#-protected-readdoubleasync-promisenumber),
[readLenencInt](#-protected-readlenencint-number--bigint),
[readLenencIntAsync](#-protected-readlenencintasync-promisenumber--bigint),
[readShortBytes](#-protected-readshortbyteslen-number-uint8arrayarraybufferlike),
[readShortBytesAsync](#-protected-readshortbytesasynclen-number-promiseuint8arrayarraybufferlike),
[readShortNulBytes](#-protected-readshortnulbytes-uint8arrayarraybufferlike),
[readShortNulBytesAsync](#-protected-readshortnulbytesasync-promiseuint8arrayarraybufferlike),
[readShortLenencBytes](#-protected-readshortlenencbytes-uint8arrayarraybufferlike),
[readShortLenencBytesAsync](#-protected-readshortlenencbytesasync-promiseuint8arrayarraybufferlike),
[readShortEofBytes](#-protected-readshorteofbytes-uint8arrayarraybufferlike),
[readShortEofBytesAsync](#-protected-readshorteofbytesasync-promiseuint8arrayarraybufferlike),
[readBytesToBuffer](#-protected-readbytestobufferdest-uint8array-promiseuint8arrayarraybufferlike),
[readVoid](#-protected-readvoidlen-number-boolean),
[readVoidAsync](#-protected-readvoidasynclen-number-promisevoid),
[readShortString](#-protected-readshortstringlen-number-string),
[readShortStringAsync](#-protected-readshortstringasynclen-number-promisestring),
[readShortNulString](#-protected-readshortnulstring-string),
[readShortNulStringAsync](#-protected-readshortnulstringasync-promisestring),
[readShortLenencString](#-protected-readshortlenencstring-string),
[readShortLenencStringAsync](#-protected-readshortlenencstringasync-promisestring),
[readShortEofString](#-protected-readshorteofstring-string),
[readShortEofStringAsync](#-protected-readshorteofstringasync-promisestring)


#### 🔧 `constructor`(reader: ReadableStreamBYOBReader, decoder: TextDecoder, useBuffer: Uint8Array | `undefined`)



#### 📄 totalBytesInPacket: `number`



#### 📄 decoder: TextDecoder



#### ⚙ recycleBuffer(): Uint8Array\<ArrayBufferLike>



#### 📄 `protected` buffer: Uint8Array



#### 📄 `protected` bufferStart: `number`



#### 📄 `protected` bufferEnd: `number`



#### 📄 `protected` sequenceId: `number`



#### 📄 `protected` payloadLength: `number`



#### 📄 `protected` packetOffset: `number`



#### 📄 `protected` compression: [Compression](../enum.Compression/README.md)

> Set when the connection was switched to the compressed protocol (`CLIENT_COMPRESS` or `CLIENT_ZSTD_COMPRESSION_ALGORITHM` negotiated, after the authentication).
> Then everything sent and received over the connection is wrapped in compressed packets: a 7-byte header
> (3-byte payload length, 1-byte sequence id, 3-byte uncompressed length) followed by the payload,
> that is either a compressed (with this algorithm) part of the ordinary packet stream, or (if the uncompressed length field is 0) a verbatim part of it.



#### 📄 `protected` zstdLevel: `number`

> The zstd compression level, used when [compression](../class.MyProtocolReader/README.md#-protected-compression-compression) is `Compression.ZSTD`: the client compresses its packets with it,
> and during the handshake it was sent to the server, that uses it to compress the responses.



#### 📄 `protected` compressedSeqId: `number`

> The compressed protocol sequence id. It works like the ordinary packet sequence id, but counts compressed packets, and travels in their headers.
> The server counts the compressed packets it reads within each command read cycle, so the numbering must restart from 0
> when a compressed packet begins a new command (`MyProtocolReaderWriter.sendPackets()` takes care of this),
> and continue from the last received number + 1 when the client writes in the middle of a command
> (like the `LOCAL INFILE` file data) - [readFromConn()](../class.MyProtocolReader/README.md#-protected-readfromconnv-extends-uint8arrayview-v-promisereadablestreamreadresultv) adopts the numbers it receives for this.



#### 📄 `protected` reader: ReadableStreamBYOBReader



#### ⚙ `protected` isAtEndOfPacket(): `boolean`



#### ⚙ `protected` gotoEndOfPacket(): `boolean`



#### ⚙ `protected` gotoEndOfPacketAsync(): Promise\<`void`>



#### ⚙ `protected` unput(byte: `number`): `void`

> Immediately after readUint8() or readUint8Async(), it's possible to put the just read byte back, so you will read it again.



#### ⚙ `protected` readFromConn\<V `extends` Uint8Array>(view: V): Promise\<ReadableStreamReadResult\<V>>

> Read bytes from the connection to `view`.
> In the ordinary protocol this is a single read from the connection reader.
> In the compressed protocol, reads compressed packets and converts them back to the ordinary packet stream:
> inflates deflated payloads, and passes through payloads that travel verbatim.
> Also adopts the sequence ids from the compressed packet headers to [compressedSeqId](../class.MyProtocolReader/README.md#-protected-compressedseqid-number).



#### ⚙ `protected` readPacketHeader(): `boolean`

> If buffer contains full header, consume it, and return true. Else return false.



#### ⚙ `protected` readPacketHeaderAsync(): Promise\<`void`>

> To read a header, do: readPacketHeader() || await readPacketHeaderAsync().
> This allows to avoid unnecessary promise awaiting.



#### ⚙ `protected` readUint8(): `number`

> If buffer contains full uint8_t, consume it. Else return undefined.



#### ⚙ `protected` readUint8Async(): Promise\<`number`>

> To read a uint8_t, do: readUint8() ?? await readUint8Async().
> This allows to avoid unnecessary promise awaiting.



#### ⚙ `protected` readInt8(): `number`

> If buffer contains full int8_t, consume it. Else return undefined.



#### ⚙ `protected` readInt8Async(): Promise\<`number`>

> To read a int8_t, do: readInt8() ?? await readInt8Async().
> This allows to avoid unnecessary promise awaiting.



#### ⚙ `protected` readUint16(): `number`

> If buffer contains full uint16_t, consume it. Else return undefined.



#### ⚙ `protected` readUint16Async(): Promise\<`number`>

> To read a uint16_t, do: readUint16() ?? await readUint16Async().
> This allows to avoid unnecessary promise awaiting.



#### ⚙ `protected` readInt16(): `number`

> If buffer contains full int16_t, consume it. Else return undefined.



#### ⚙ `protected` readInt16Async(): Promise\<`number`>

> To read a int16_t, do: readInt16() ?? await readInt16Async().
> This allows to avoid unnecessary promise awaiting.



#### ⚙ `protected` readUint24(): `number`

> If buffer contains full 3-byte little-endian unsigned int, consume it. Else return undefined.



#### ⚙ `protected` readUint24Async(): Promise\<`number`>

> To read a 3-byte little-endian unsigned int, do: readUint24() ?? await readUint24Async().
> This allows to avoid unnecessary promise awaiting.



#### ⚙ `protected` readUint32(): `number`

> If buffer contains full uint32_t, consume it. Else return undefined.



#### ⚙ `protected` readUint32Async(): Promise\<`number`>

> To read a uint32_t, do: readUint32() ?? await readUint32Async().
> This allows to avoid unnecessary promise awaiting.



#### ⚙ `protected` readInt32(): `number`

> If buffer contains full int32_t, consume it. Else return undefined.



#### ⚙ `protected` readInt32Async(): Promise\<`number`>

> To read a int32_t, do: readInt32() ?? await readInt32Async().
> This allows to avoid unnecessary promise awaiting.



#### ⚙ `protected` readUint64(): `bigint`

> If buffer contains full uint64_t, consume it. Else return undefined.



#### ⚙ `protected` readUint64Async(): Promise\<`bigint`>

> To read a uint64_t, do: readUint64() ?? await readUint64Async().
> This allows to avoid unnecessary promise awaiting.



#### ⚙ `protected` readInt64(): `bigint`

> If buffer contains full int64_t, consume it. Else return undefined.



#### ⚙ `protected` readInt64Async(): Promise\<`bigint`>

> To read a int64_t, do: readInt64() ?? await readInt64Async().
> This allows to avoid unnecessary promise awaiting.



#### ⚙ `protected` readFloat(): `number`

> If buffer contains full float, consume it. Else return undefined.



#### ⚙ `protected` readFloatAsync(): Promise\<`number`>

> To read a IEEE 754 32-bit single-precision, do: readFloat() ?? await readFloatAsync().
> This allows to avoid unnecessary promise awaiting.



#### ⚙ `protected` readDouble(): `number`

> If buffer contains full double, consume it. Else return undefined.



#### ⚙ `protected` readDoubleAsync(): Promise\<`number`>

> To read a IEEE 754 32-bit double-precision, do: readDouble() ?? await readDoubleAsync().
> This allows to avoid unnecessary promise awaiting.



#### ⚙ `protected` readLenencInt(): `number` | `bigint`

> If buffer contains full length-encoded integer, consume it. Else return undefined.
> Null value (0xFB) will be returned as -1.



#### ⚙ `protected` readLenencIntAsync(): Promise\<`number` | `bigint`>

> To read a length-encoded integer, do: readLenencInt() ?? await readLenencIntAsync().
> This allows to avoid unnecessary promise awaiting.
> Null value (0xFB) will be returned as -1.



#### ⚙ `protected` readShortBytes(len: `number`): Uint8Array\<ArrayBufferLike>

> If buffer contains len bytes, consume them. Else return undefined.
> Returns pointer to buffer. If you want to use these data after next read operation, you need to copy them.



#### ⚙ `protected` readShortBytesAsync(len: `number`): Promise\<Uint8Array\<ArrayBufferLike>>

> To read len bytes, where len<=buffer.length-4, do: readShortBytes() ?? await readShortBytesAsync().
> This allows to avoid unnecessary promise awaiting.
> Returns pointer to buffer. If you want to use these data after next read operation, you need to copy them.



#### ⚙ `protected` readShortNulBytes(): Uint8Array\<ArrayBufferLike>

> If buffer contains full null-terminated blob, consume it. Else return undefined.
> Returns pointer to buffer. If you want to use these data after next read operation, you need to copy them.



#### ⚙ `protected` readShortNulBytesAsync(): Promise\<Uint8Array\<ArrayBufferLike>>

> To read a null-terminated blob that can fit buffer.length (not across packet boundary), do: readShortNulBytes() ?? await readShortNulBytesAsync().
> This allows to avoid unnecessary promise awaiting.
> If the blob was longer than buffer.length, error is thrown.
> Returns pointer to buffer. If you want to use these data after next read operation, you need to copy them.



#### ⚙ `protected` readShortLenencBytes(): Uint8Array\<ArrayBufferLike>

> If buffer contains full blob with length-encoded length, consume it. Else return undefined.
> Null value (0xFB) will be returned as empty buffer.



#### ⚙ `protected` readShortLenencBytesAsync(): Promise\<Uint8Array\<ArrayBufferLike>>

> Reads blob with length-encoded length. The blob must be not longer than buffer.length-4 bytes, or error will be thrown.
> Returns pointer to buffer. If you want to use these data after next read operation, you need to copy them.
> Null value (0xFB) will be returned as empty buffer.



#### ⚙ `protected` readShortEofBytes(): Uint8Array\<ArrayBufferLike>

> If buffer contains full packet, consume it. Else return undefined.
> Returns pointer to buffer. If you want to use these data after next read operation, you need to copy them.



#### ⚙ `protected` readShortEofBytesAsync(): Promise\<Uint8Array\<ArrayBufferLike>>

> To read a blob that can fit buffer.length to end of packet, do: readShortEofBytes() ?? await readShortEofBytesAsync().
> This allows to avoid unnecessary promise awaiting.
> Returns pointer to buffer. If you want to use these data after next read operation, you need to copy them.



#### ⚙ `protected` readBytesToBuffer(dest: Uint8Array): Promise\<Uint8Array\<ArrayBufferLike>>

> Copies bytes to provided buffer.



#### ⚙ `protected` readVoid(len: `number`): `boolean`

> If buffer contains len bytes, skip them and return true. Else return false.



#### ⚙ `protected` readVoidAsync(len: `number`): Promise\<`void`>

> To skip len bytes, do: readVoid() ?? await readVoidAsync().
> This allows to avoid unnecessary promise awaiting.



#### ⚙ `protected` readShortString(len: `number`): `string`

> If buffer contains full fixed-length string, consume it. Else return undefined.



#### ⚙ `protected` readShortStringAsync(len: `number`): Promise\<`string`>

> To read a fixed-length string that can fit buffer.length-4, do: readShortString() ?? await readShortStringAsync().
> This allows to avoid unnecessary promise awaiting.



#### ⚙ `protected` readShortNulString(): `string`

> If buffer contains full nul-string, consume it. Else return undefined.



#### ⚙ `protected` readShortNulStringAsync(): Promise\<`string`>

> To read a nul-string that can fit buffer.length, do: readShortNulString() ?? await readShortNulStringAsync().
> This allows to avoid unnecessary promise awaiting.
> If the string was longer than buffer.length, error is thrown.



#### ⚙ `protected` readShortLenencString(): `string`

> If buffer contains full string with length-encoded length, consume it. Else return undefined.
> Null value (0xFB) will be returned as ''.



#### ⚙ `protected` readShortLenencStringAsync(): Promise\<`string`>

> To read a fixed-length string that can fit buffer.length-4, do: readShortLenencString() ?? await readShortLenencStringAsync().
> This allows to avoid unnecessary promise awaiting.
> Null value (0xFB) will be returned as ''.



#### ⚙ `protected` readShortEofString(): `string`

> If buffer contains full packet, consume it. Else return undefined.



#### ⚙ `protected` readShortEofStringAsync(): Promise\<`string`>

> To read a string that can fit buffer.length to end of packet, do: readShortEofString() ?? await readShortEofStringAsync().
> This allows to avoid unnecessary promise awaiting.



