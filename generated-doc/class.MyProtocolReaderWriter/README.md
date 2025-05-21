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
- 24 protected methods:
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
[sendWithData](#-protected-sendwithdatadata-sqlsource-nobackslashescapes-boolean-logdata-data-uint8array--promiseunknown-canwait-booleanfalse-putparamsto-unknown-promiseboolean)
- 59 inherited members from [MyProtocolReader](../class.MyProtocolReader/README.md)


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



#### ⚙ `protected` sendWithData(data: [SqlSource](../type.SqlSource/README.md), noBackslashEscapes: `boolean`, logData?: (data: Uint8Array) => Promise\<`unknown`>, canWait: `boolean`=false, putParamsTo?: `unknown`\[]): Promise\<`boolean`>

> Append long data to the end of current packet, and send the packet (or split to several packets and send them).



