# `class` SafeSqlLogger

[Documentation Index](../README.md)

## This class has

- [constructor](#-constructordsn-dsn-underlying-sqllogger-logger-logger)
- 6 methods:
[connect](#-connectconnectionid-number-promiseany),
[resetConnection](#-resetconnectionconnectionid-number-promiseany),
[disconnect](#-disconnectconnectionid-number-promiseany),
[query](#-queryconnectionid-number-isprepare-boolean-nobackslashescapes-boolean-promisesafesqlloggerquery),
[deallocatePrepare](#-deallocateprepareconnectionid-number-stmtids-number-promiseany),
[dispose](#-dispose-promiseany)


#### 🔧 `constructor`(dsn: [Dsn](../class.Dsn/README.md), underlying: [SqlLogger](../interface.SqlLogger/README.md), logger: [Logger](../interface.Logger/README.md))



#### ⚙ connect(connectionId: `number`): Promise\<`any`>



#### ⚙ resetConnection(connectionId: `number`): Promise\<`any`>



#### ⚙ disconnect(connectionId: `number`): Promise\<`any`>



#### ⚙ query(connectionId: `number`, isPrepare: `boolean`, noBackslashEscapes: `boolean`): Promise\<[SafeSqlLoggerQuery](../interface.SafeSqlLoggerQuery/README.md)>



#### ⚙ deallocatePrepare(connectionId: `number`, stmtIds: `number`\[]): Promise\<`any`>



#### ⚙ dispose(): Promise\<`any`>



