# `type` OnLoadFile

[Documentation Index](../README.md)

`type` OnLoadFile = ((filename: `string`) => Promise\<([Reader](../interface.Reader/README.md) \& [Closer](../interface.Closer/README.md)) | `undefined`>) | ((filename: `string`) => Promise\<(\{`readonly` readable: ReadableStream\<Uint8Array>} \& Disposable) | `undefined`>)