# `class` Pool

[Documentation Index](../README.md)

## This class has

- [destructor](#-symbolasyncdispose-promisevoid)
- property [options](#-options-optionsmanager)
- 5 methods:
[updateOptions](#-updateoptionsoptions-dsn--string--mypooloptions-mypooloptions),
[ref](#-ref-void),
[unref](#-unref-void),
[getProtocol](#-getprotocoldsn-dsn-pendingchangeschema-string-sqllogger-safesqllogger--undefined-promisemyprotocol),
[returnProtocol](#-returnprotocolprotocol-myprotocol-rollbackpreparedxaid-string-withdisposesqllogger-boolean-promisevoid)


#### 🔨 \[Symbol.asyncDispose](): Promise\<`void`>



#### 📄 options: [OptionsManager](../private.class.OptionsManager/README.md)



#### ⚙ updateOptions(options?: [Dsn](../class.Dsn/README.md) | `string` | [MyPoolOptions](../interface.MyPoolOptions/README.md)): [MyPoolOptions](../interface.MyPoolOptions/README.md)



#### ⚙ ref(): `void`



#### ⚙ unref(): `void`



#### ⚙ getProtocol(dsn: [Dsn](../class.Dsn/README.md), pendingChangeSchema: `string`, sqlLogger: [SafeSqlLogger](../class.SafeSqlLogger/README.md) | `undefined`): Promise\<[MyProtocol](../class.MyProtocol/README.md)>



#### ⚙ returnProtocol(protocol: [MyProtocol](../class.MyProtocol/README.md), rollbackPreparedXaId: `string`, withDisposeSqlLogger: `boolean`): Promise\<`void`>


