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

- [protected constructor](#-protected-constructorwriter-writablestreamdefaultwriteruint8array-reader-readablestreambyobreader-decoder-textdecoder-usebuffer-uint8array--undefined)
- method [setHeader](#-setheaderpayloadlength-number-void)
- protected property [writer](#-protected-writer-writablestreamdefaultwriteruint8array)
- 18 protected methods:
[startWritingNewPacket](#-protected-startwritingnewpacketresetsequenceid-booleanfalse-void),
[discardPacket](#-protected-discardpacket-void),
[writeUint8](#-protected-writeuint8value-number-void),
[writeUint16](#-protected-writeuint16value-number-void),
[writeUint32](#-protected-writeuint32value-number-void),
[writeUint64](#-protected-writeuint64value-bigint-void),
[writeLenencInt](#-protected-writelenencintvalue-number--bigint-void),
[writeDouble](#-protected-writedoublevalue-number-void),
[writeZero](#-protected-writezeronbytes-number-void),
[writeBytes](#-protected-writebytesbytes-uint8array-void),
[writeLenencBytes](#-protected-writelenencbytesbytes-uint8array-void),
[writeNulBytes](#-protected-writenulbytesbytes-uint8array-void),
[writeString](#-protected-writestringvalue-string-void),
[writeLenencString](#-protected-writelenencstringvalue-string-void),
[writeNulString](#-protected-writenulstringvalue-string-void),
[writeReadChunk](#-protected-writereadchunkvalue-reader-promisenumber),
[send](#-protected-send-promisevoid),
[sendWithData](#-protected-sendwithdatadata-sqlsource-nobackslashescapes-boolean-logdata-data-uint8array--promiseunknown-canwait-booleanfalse-putparamsto-any-promiseboolean)


#### ⚙ setHeader(payloadLength: `number`): `void`



#### 🔧 `protected` `constructor`(writer: WritableStreamDefaultWriter\<Uint8Array>, reader: ReadableStreamBYOBReader, decoder: TextDecoder, useBuffer: Uint8Array | `undefined`)



#### 📄 `protected` writer: WritableStreamDefaultWriter\<Uint8Array>



#### ⚙ `protected` startWritingNewPacket(resetSequenceId: `boolean`=false): `void`



#### ⚙ `protected` discardPacket(): `void`



#### ⚙ `protected` writeUint8(value: `number`): `void`



#### ⚙ `protected` writeUint16(value: `number`): `void`



#### ⚙ `protected` writeUint32(value: `number`): `void`



#### ⚙ `protected` writeUint64(value: `bigint`): `void`



#### ⚙ `protected` writeLenencInt(value: `number` | `bigint`): `void`



#### ⚙ `protected` writeDouble(value: `number`): `void`



#### ⚙ `protected` writeZero(nBytes: `number`): `void`



#### ⚙ `protected` writeBytes(bytes: Uint8Array): `void`



#### ⚙ `protected` writeLenencBytes(bytes: Uint8Array): `void`



#### ⚙ `protected` writeNulBytes(bytes: Uint8Array): `void`



#### ⚙ `protected` writeString(value: `string`): `void`



#### ⚙ `protected` writeLenencString(value: `string`): `void`



#### ⚙ `protected` writeNulString(value: `string`): `void`



#### ⚙ `protected` writeReadChunk(value: [Reader](../interface.Reader/README.md)): Promise\<`number`>



#### ⚙ `protected` send(): Promise\<`void`>



#### ⚙ `protected` sendWithData(data: [SqlSource](../type.SqlSource/README.md), noBackslashEscapes: `boolean`, logData?: (data: Uint8Array) => Promise\<`unknown`>, canWait: `boolean`=false, putParamsTo?: [Any](../private.type.Any.2/README.md)\[]): Promise\<`boolean`>

> Append long data to the end of current packet, and send the packet (or split to several packets and send them).



