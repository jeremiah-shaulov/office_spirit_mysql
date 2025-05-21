# `deprecated` `class` SqlLogToWriter `extends` [SqlLogToWritable](../class.SqlLogToWritable/README.md)

[Documentation Index](../README.md)

```ts
import {SqlLogToWriter} from "https://deno.land/x/office_spirit_mysql@v0.21.1/mod.ts"
```

Please, use new class called `SqlLogToWritable` that has the same functionality as old `SqlLogToWriter`,
plus it supports `WritableStream<Uint8Array>`.

## This class has

- [constructor](#-constructorwriter-writer--writablestreamuint8array-withcolor-booleanfalse-querymaxbytes-numberdefault_query_max_bytes-parammaxbytes-numberdefault_param_max_bytes-maxlines-numberdefault_max_lines-logger-loggerconsole)
- 4 inherited members from [SqlLogToWritableBase](../class.SqlLogToWritableBase/README.md)


#### 🔧 `constructor`(writer: [Writer](../interface.Writer/README.md) | WritableStream\<Uint8Array>, withColor: `boolean`=false, queryMaxBytes: `number`=DEFAULT\_QUERY\_MAX\_BYTES, paramMaxBytes: `number`=DEFAULT\_PARAM\_MAX\_BYTES, maxLines: `number`=DEFAULT\_MAX\_LINES, logger: [Logger](../interface.Logger/README.md)=console)



