# `class` Column

[Documentation Index](../README.md)

```ts
import {Column} from "https://deno.land/x/office_spirit_mysql/v0.19.3/mod.ts"
```

Array of such objects is found on `Resultsets.columns`.
For SELECT queries MySQL server reports various information about each returned column.

## This class has

- [constructor](#-constructorcatalog-string-schema-string-table-string-orgtable-string-name-string-orgname-string-charsetid-charset-length-number-typeid-mysqltype-flags-columnflags-decimals-number)
- 11 properties:
[catalog](#-catalog-string),
[schema](#-schema-string),
[table](#-table-string),
[orgTable](#-orgtable-string),
[name](#-name-string),
[orgName](#-orgname-string),
[charsetId](#-charsetid-charset),
[length](#-length-number),
[typeId](#-typeid-mysqltype),
[flags](#-flags-columnflags),
[decimals](#-decimals-number)


#### 🔧 `constructor`(catalog: `string`, schema: `string`, table: `string`, orgTable: `string`, name: `string`, orgName: `string`, charsetId: [Charset](../enum.Charset/README.md), length: `number`, typeId: [MysqlType](../enum.MysqlType/README.md), flags: [ColumnFlags](../enum.ColumnFlags/README.md), decimals: `number`)



#### 📄 catalog: `string`



#### 📄 schema: `string`



#### 📄 table: `string`



#### 📄 orgTable: `string`



#### 📄 name: `string`



#### 📄 orgName: `string`



#### 📄 charsetId: [Charset](../enum.Charset/README.md)



#### 📄 length: `number`



#### 📄 typeId: [MysqlType](../enum.MysqlType/README.md)



#### 📄 flags: [ColumnFlags](../enum.ColumnFlags/README.md)



#### 📄 decimals: `number`



