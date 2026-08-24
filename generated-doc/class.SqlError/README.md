# `class` SqlError `extends` Error

[Documentation Index](../README.md)

```ts
import {SqlError} from "jsr:@shaulov/office-spirit-mysql@0.28.2"
```

Query was sent to the server, and this error is reported by the server (not a connection error or such).

## This class has

- [constructor](#-constructormessage-string-errorcode-number0-sqlstate-string-autocommit-booleanfalse-intrx-booleanfalse)
- 3 properties:
[canRetry](#-readonly-canretry-any),
[errorCode](#-errorcode-number),
[sqlState](#-sqlstate-string)
- method [toString](#-override-tostring-string)
- base class


#### 🔧 `constructor`(message: `string`, errorCode: `number`=0, sqlState: `string`="", autocommit: `boolean`=false, inTrx: `boolean`=false)



#### 📄 `readonly` canRetry: `any`



#### 📄 errorCode: `number`



#### 📄 sqlState: `string`



#### ⚙ `override` toString(): `string`

> Returns a string representation of an object.



