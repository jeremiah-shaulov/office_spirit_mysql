# `class` SafeSqlLogger

[Documentation Index](../README.md)

## This class has

- [constructor](#-constructordsn-dsn-underlying-sqllogger-logger-logger)
- 6 methods:
[connect](#-connectconnectionid-number-any),
[resetConnection](#-resetconnectionconnectionid-number-any),
[disconnect](#-disconnectconnectionid-number-any),
[query](#-queryconnectionid-number-isprepare-boolean-nobackslashescapes-boolean-promisesafesqlloggerquery),
[deallocatePrepare](#-deallocateprepareconnectionid-number-stmtids-number-any),
[dispose](#-dispose-any)


#### 🔧 `constructor`(dsn: [Dsn](../class.Dsn/README.md), underlying: [SqlLogger](../interface.SqlLogger/README.md), logger: [Logger](../interface.Logger/README.md))



#### ⚙ connect(connectionId: `number`): `any`



#### ⚙ resetConnection(connectionId: `number`): `any`



#### ⚙ disconnect(connectionId: `number`): `any`



#### ⚙ query(connectionId: `number`, isPrepare: `boolean`, noBackslashEscapes: `boolean`): Promise\<[SafeSqlLoggerQuery](../interface.SafeSqlLoggerQuery/README.md)>



#### ⚙ deallocatePrepare(connectionId: `number`, stmtIds: `number`\[]): `any`



#### ⚙ dispose(): `any`



