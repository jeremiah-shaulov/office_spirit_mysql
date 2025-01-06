# `class` SqlError `extends` Error

[Documentation Index](../README.md)

```ts
import {SqlError} from "https://deno.land/x/office_spirit_mysql@v0.19.13/mod.ts"
```

Query was sent to the server, and this error is reported by the server (not a connection error or such).

## This class has

- [constructor](#-constructormessage-string-errorcode-number0-sqlstate-string-autocommit-booleanfalse-intrx-booleanfalse)
- 3 properties:
[canRetry](#-readonly-canretry-any),
[errorCode](#-errorcode-number),
[sqlState](#-sqlstate-string)
- base class


#### 🔧 `constructor`(message: `string`, errorCode: `number`=0, sqlState: `string`="", autocommit: `boolean`=false, inTrx: `boolean`=false)



#### 📄 `readonly` canRetry: `any`



#### 📄 errorCode: `number`



#### 📄 sqlState: `string`



