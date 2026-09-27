# `type` SqlSource

[Documentation Index](../README.md)

```ts
import {SqlSource} from "jsr:@shaulov/office-spirit-mysql@0.29.1"
```

`type` SqlSource = `string` | Uint8Array | (\{`readonly` readable: ReadableStream\<Uint8Array>} | [Reader](../interface.Reader/README.md)) \& (\{`readonly` size: `number`} | [Seeker](../interface.Seeker/README.md)) | [ToSqlBytes](../private.interface.ToSqlBytes/README.md)