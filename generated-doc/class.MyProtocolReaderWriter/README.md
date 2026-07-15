# `class` MyProtocolReaderWriter `extends` [MyProtocolReader](../class.MyProtocolReader/README.md)

[Documentation Index](../README.md)

Starting from stable state (bufferEnd == bufferStart) you can start writing packets.
It's possible to write multiple packets, and then send them all, or to send each packet immediately after writing it.

```ts
// Send 1 packet
this.startWritingNewPacket(true);
this.writeUint8(Command.COM_RESET_CONNECTION);
await this.send();

// Send batch of 2 packets
this.startWritingNewPacket(true);
this.writeUint8(Command.COM_RESET_CONNECTION);
this.startWritingNewPacket(true);
this.writeUint8(Command.COM_INIT_DB);
this.writeString('test');
await this.send();
```

At the end of the operation (after each sending) the object will be left in the stable state.

When using `send()` to send the packets, all the written packets must fit the size of `this.buffer` (it's up to you to ensure this).
To send a long packet, use `sendWithData()`.

## This class has

- [constructor](#-constructorwriter-writablestreamdefaultwriteruint8array-reader-readablestreambyobreader-decoder-textdecoder-usebuffer-uint8array--undefined)
- method [setHeader](#-setheaderpayloadlength-number-void)
- protected property [writer](#-protected-writer-writablestreamdefaultwriteruint8array)
- 26 protected methods:
[ensureRoom](#-protected-ensureroomroom-number-void),
[startWritingNewPacket](#-protected-startwritingnewpacketresetsequenceid-booleanfalse-void),
[discardPacket](#-protected-discardpacket-void),
[writeUint8](#-protected-writeuint8value-number-void),
[writeInt8](#-protected-writeint8value-number-void),
[writeUint16](#-protected-writeuint16value-number-void),
[writeInt16](#-protected-writeint16value-number-void),
[writeUint32](#-protected-writeuint32value-number-void),
[writeInt32](#-protected-writeint32value-number-void),
[writeUint64](#-protected-writeuint64value-bigint-void),
[writeInt64](#-protected-writeint64value-bigint-void),
[writeFloat](#-protected-writefloatvalue-number-void),
[writeLenencInt](#-protected-writelenencintvalue-number--bigint-void),
[writeDouble](#-protected-writedoublevalue-number-void),
[writeZero](#-protected-writezeronbytes-number-void),
[writeShortBytes](#-protected-writeshortbytesbytes-uint8array-void),
[writeShortLenencBytes](#-protected-writeshortlenencbytesbytes-uint8array-void),
[writeShortNulBytes](#-protected-writeshortnulbytesbytes-uint8array-void),
[writeShortString](#-protected-writeshortstringvalue-string-void),
[writeShortLenencString](#-protected-writeshortlenencstringvalue-string-void),
[writeShortNulString](#-protected-writeshortnulstringvalue-string-void),
[writeReadChunk](#-protected-writereadchunkvalue-reader-promisenumber),
[send](#-protected-send-promisevoid),
[sendPackets](#-protected-sendpacketsend-number-promisevoid),
[sendData](#-protected-senddatadata-uint8array-promisevoid),
[sendWithData](#-protected-sendwithdatadata-sqlsource-nobackslashescapes-boolean-logdata-data-uint8array--promiseunknown-canwait-booleanfalse-putparamsto-unknown-promiseboolean)
- 63 inherited members from [MyProtocolReader](../class.MyProtocolReader/README.md)


#### 🔧 `constructor`(writer: WritableStreamDefaultWriter\<Uint8Array>, reader: ReadableStreamBYOBReader, decoder: TextDecoder, useBuffer: Uint8Array | `undefined`)



#### ⚙ setHeader(payloadLength: `number`): `void`



#### 📄 `protected` writer: WritableStreamDefaultWriter\<Uint8Array>



#### ⚙ `protected` ensureRoom(room: `number`): `void`



#### ⚙ `protected` startWritingNewPacket(resetSequenceId: `boolean`=false): `void`



#### ⚙ `protected` discardPacket(): `void`



#### ⚙ `protected` writeUint8(value: `number`): `void`



#### ⚙ `protected` writeInt8(value: `number`): `void`



#### ⚙ `protected` writeUint16(value: `number`): `void`



#### ⚙ `protected` writeInt16(value: `number`): `void`



#### ⚙ `protected` writeUint32(value: `number`): `void`



#### ⚙ `protected` writeInt32(value: `number`): `void`



#### ⚙ `protected` writeUint64(value: `bigint`): `void`



#### ⚙ `protected` writeInt64(value: `bigint`): `void`



#### ⚙ `protected` writeFloat(value: `number`): `void`



#### ⚙ `protected` writeLenencInt(value: `number` | `bigint`): `void`



#### ⚙ `protected` writeDouble(value: `number`): `void`



#### ⚙ `protected` writeZero(nBytes: `number`): `void`



#### ⚙ `protected` writeShortBytes(bytes: Uint8Array): `void`



#### ⚙ `protected` writeShortLenencBytes(bytes: Uint8Array): `void`



#### ⚙ `protected` writeShortNulBytes(bytes: Uint8Array): `void`



#### ⚙ `protected` writeShortString(value: `string`): `void`



#### ⚙ `protected` writeShortLenencString(value: `string`): `void`



#### ⚙ `protected` writeShortNulString(value: `string`): `void`



#### ⚙ `protected` writeReadChunk(value: [Reader](../interface.Reader/README.md)): Promise\<`number`>



#### ⚙ `protected` send(): Promise\<`void`>



#### ⚙ `protected` sendPackets(end: `number`): Promise\<`void`>

> Send `this.buffer[0 .. end)` to the connection. The bytes are packets, each beginning with its 4-byte header
> (only the last packet is allowed to be cut, when the caller will complete it with [sendData()](../class.MyProtocolReaderWriter/README.md#-protected-senddatadata-uint8array-promisevoid) calls).
> In the ordinary protocol this is a single write.
> In the compressed protocol, each command must begin its own compressed packet,
> with the compressed packet numbering restarted from 0 - like libmysql, that never lets 2 commands share a compressed packet, does.
> The server (both MySQL and MariaDB) counts the compressed packets it receives within each command read cycle,
> and can overwrite the tail of a decompressed packet in it's buffer when it writes a response,
> swallowing the command that shared the compressed packet with the previous command.
> The command boundaries are recorded by `startWritingNewPacket(resetSequenceId=true)` in `this.#commandStarts`
> (as offsets, not as slices of `this.buffer`, because the buffer can be reallocated by `ensureRoom()`, or detached and rebound by a BYOB read, before the bytes are sent),
> and bytes that don't start a command (like `LOCAL INFILE` file data) continue the current compressed packet numbering.
> All the compressed packets go in 1 write to the connection.



#### ⚙ `protected` sendData(data: Uint8Array): Promise\<`void`>

> Send raw bytes to the connection - a continuation of the payload of the current packet, whose beginning was sent with [sendPackets()](../class.MyProtocolReaderWriter/README.md#-protected-sendpacketsend-number-promisevoid).
> In the compressed protocol wraps the bytes in compressed packets, continuing the current numbering (no command begins in them).
> The compressed packets are built in `this.buffer` after the input (or from its beginning, if the input is an external array -
> safe, because a payload continuation can only be sent after the packets in the buffer were flushed).



#### ⚙ `protected` sendWithData(data: [SqlSource](../type.SqlSource/README.md), noBackslashEscapes: `boolean`, logData?: (data: Uint8Array) => Promise\<`unknown`>, canWait: `boolean`=false, putParamsTo?: `unknown`\[]): Promise\<`boolean`>

> Append long data to the end of current packet, and send the packet (or split to several packets and send them).



