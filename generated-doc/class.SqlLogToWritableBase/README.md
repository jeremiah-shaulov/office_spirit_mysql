# `class` SqlLogToWritableBase `implements` [SqlLogger](../interface.SqlLogger/README.md)

[Documentation Index](../README.md)

## This class has

- [constructor](#-constructorwriter-writer--writablestreamuint8array-logger-loggerconsole)
- property [logger](#-logger-logger)
- method [dispose](#-dispose-promisevoid)
- protected property [writer](#-protected-writer-writablestreamdefaultwriteruint8array)
- 2 protected methods:
[write](#-protected-writedsn-dsn-connectionid-number-data-uint8array--string-promisevoid),
[nextConnBanner](#-protected-nextconnbanner_dsn-dsn-_connectionid-number-string--uint8arrayarraybufferlike)


#### 🔧 `constructor`(writer: [Writer](../interface.Writer/README.md) | WritableStream\<Uint8Array>, logger: [Logger](../interface.Logger/README.md)=console)



#### 📄 logger: [Logger](../interface.Logger/README.md)



#### ⚙ dispose(): Promise\<`void`>

> This callback is called when current `MyConn` object is disposed of. This happens at the end of `MyPool.forConn()`, or at the end of a block with `using conn = ...`.



#### 📄 `protected` writer: WritableStreamDefaultWriter\<Uint8Array>



#### ⚙ `protected` write(dsn: [Dsn](../class.Dsn/README.md), connectionId: `number`, data: Uint8Array | `string`): Promise\<`void`>



#### ⚙ `protected` nextConnBanner(\_dsn: [Dsn](../class.Dsn/README.md), \_connectionId: `number`): `string` | Uint8Array\<ArrayBufferLike>



