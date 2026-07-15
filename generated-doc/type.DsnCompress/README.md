# `type` DsnCompress

[Documentation Index](../README.md)

```ts
import {DsnCompress} from "https://deno.land/x/office_spirit_mysql@v0.28.0/mod.ts"
```

Value of the [Dsn.compress](../class.Dsn/README.md#-accessor-compress-dsncompress) parameter:
- `false` - don't compress;
- `true` - compress with the best algorithm that the server and this runtime support: zstd (with the default level 3) is preferred, zlib is the fallback;
- `zlib` - only zlib;
- `zstd` - only zstd (with the default level 3);
- `zstd:N` - only zstd with compression level N (1 - 22, e.g. `zstd:19`).

`type` DsnCompress = `boolean` | <mark>"zlib"</mark> | <mark>"zstd"</mark> | <mark>\`\`zstd:$\{number}\`\`</mark>