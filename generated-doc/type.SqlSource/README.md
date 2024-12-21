# `type` SqlSource

[Documentation Index](../README.md)

```ts
import {SqlSource} from "https://deno.land/x/office_spirit_mysql@v0.19.8/mod.ts"
```

`type` SqlSource = `string` | Uint8Array | (\{`readonly` readable: ReadableStream\<Uint8Array>} | [Reader](../interface.Reader/README.md)) \& (\{`readonly` size: `number`} | [Seeker](../interface.Seeker/README.md)) | [ToSqlBytes](../private.interface.ToSqlBytes/README.md)