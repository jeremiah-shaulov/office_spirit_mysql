# `class` Column

[Documentation Index](../README.md)

```ts
import {Column} from "https://deno.land/x/office_spirit_mysql@v0.25.0/mod.ts"
```

Array of such objects is found on `Resultsets.columns`.
For SELECT queries MySQL server reports various information about each returned column.

## This class has

- [constructor](#-constructorcatalog-string-schema-string-table-string-orgtable-string-name-string-orgname-string-charsetid-charset-length-number-typeid-mysqltype-flags-columnflags-decimals-number)
- 20 properties:
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
[decimals](#-decimals-number),
[charset](#-get-charset-string),
[type](#-get-type-year----float--timestamp--blob--set--bigint--decimal--tinyint-unsigned--tinyint--smallint-unsigned--smallint--integer-unsigned--integer---22-more---geometry),
[isNotNull](#-get-isnotnull-boolean),
[isPrimaryKey](#-get-isprimarykey-boolean),
[isUniqueKey](#-get-isuniquekey-boolean),
[isKey](#-get-iskey-boolean),
[isAutoIncrement](#-get-isautoincrement-boolean),
[isUnsigned](#-get-isunsigned-boolean),
[isZeroFill](#-get-iszerofill-boolean)


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



#### 📄 `get` charset(): `string`



#### 📄 `get` type(): <mark>"year"</mark> | <mark>""</mark> | <mark>"float"</mark> | <mark>"timestamp"</mark> | <mark>"blob"</mark> | <mark>"set"</mark> | <mark>"bigint"</mark> | <mark>"decimal"</mark> | <mark>"tinyint unsigned"</mark> | <mark>"tinyint"</mark> | <mark>"smallint unsigned"</mark> | <mark>"smallint"</mark> | <mark>"integer unsigned"</mark> | <mark>"integer"</mark> | ... 22 more ... | <mark>"geometry"</mark>

> Get MySQL type of the column as string, like "varchar", "integer unsigned", "enum", etc.
> If cannot determine the type, returns empty string.



#### 📄 `get` isNotNull(): `boolean`



#### 📄 `get` isPrimaryKey(): `boolean`



#### 📄 `get` isUniqueKey(): `boolean`



#### 📄 `get` isKey(): `boolean`



#### 📄 `get` isAutoIncrement(): `boolean`



#### 📄 `get` isUnsigned(): `boolean`



#### 📄 `get` isZeroFill(): `boolean`



