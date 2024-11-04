# `class` MyProtocol `extends` [MyProtocolReaderWriter](../class.MyProtocolReaderWriter/README.md)

[Documentation Index](../README.md)

## This class has

- static method [inst](#-static-instdsn-dsn-pendingchangeschema-string-usebuffer-uint8array-onloadfile-onloadfile-sqllogger-safesqllogger-logger-loggerconsole-promisemyprotocol)
- [protected constructor](#-protected-constructorwriter-writablestreamdefaultwriteruint8array-reader-readablestreambyobreader-closer-disposable-decoder-textdecoder-usebuffer-uint8array--undefined-dsn-dsn-logger-loggerconsole)
- 9 properties:
[serverVersion](#-serverversion-string),
[connectionId](#-connectionid-number),
[capabilityFlags](#-capabilityflags-number),
[statusFlags](#-statusflags-number),
[schema](#-schema-string),
[useTill](#-usetill-number),
[useNTimes](#-usentimes-number),
[dsn](#-dsn-dsn),
[logger](#-logger-logger)
- 14 methods:
[getTimezoneMsecOffsetFromSystem](#-gettimezonemsecoffsetfromsystem-number),
[authSendUint8Packet](#-authsenduint8packetvalue-number-promisevoid),
[authSendBytesPacket](#-authsendbytespacketvalue-uint8array-promisevoid),
[use](#-useschema-string-void),
[setSqlLogger](#-setsqlloggersqllogger-safesqllogger-void),
[writeComInitDb](#-writecominitdbschema-string-void),
[sendComQuery](#-sendcomqueryrowsql-sqlsource-rowtype-rowtyperowtypevoid-letreturnundefined-booleanfalse-multistatements-setoption--multistatementsmultistatementsnomatter-promiseresultsetsinternalrow),
[sendThreeQueries](#-sendthreequeriesrowprestmtid-number-prestmtparams-unknown--undefined-prequery-uint8array--string--undefined-ignoreprequeryerror-boolean-sql-sqlsource-rowtype-rowtyperowtypevoid-letreturnundefined-booleanfalse-multistatements-setoption--multistatementsmultistatementsnomatter-promiseresultsetsinternalrow),
[sendComStmtPrepare](#-sendcomstmtpreparerowsql-sqlsource-putparamsto-any--undefined-rowtype-rowtype-letreturnundefined-booleanfalse-skipcolumns-booleanfalse-promiseresultsetsinternalrow),
[disposePreparedStmt](#-disposepreparedstmtstmtid-number-void),
[execStmt](#-execstmtresultsets-resultsetsinternalunknown-params-param-promisevoid),
[fetch](#-fetchrowrowtype-rowtype-promiserow),
[nextResultset](#-nextresultsetignoreterminated-booleanfalse-promiseboolean),
[end](#-endrollbackpreparedxaid-string-recycleconnection-booleanfalse-withdisposesqllogger-booleanfalse-promiseuint8array--myprotocol)


## Static members

#### ⚙ `static` inst(dsn: [Dsn](../class.Dsn/README.md), pendingChangeSchema: `string`, useBuffer?: Uint8Array, onLoadFile?: [OnLoadFile](../type.OnLoadFile/README.md), sqlLogger?: [SafeSqlLogger](../class.SafeSqlLogger/README.md), logger: [Logger](../interface.Logger/README.md)=console): Promise\<[MyProtocol](../class.MyProtocol/README.md)>



## Instance members

#### 📄 serverVersion: `string`



#### 📄 connectionId: `number`



#### 📄 capabilityFlags: `number`



#### 📄 statusFlags: `number`



#### 📄 schema: `string`



#### 📄 useTill: `number`



#### 📄 useNTimes: `number`



#### 📄 dsn: [Dsn](../class.Dsn/README.md)



#### 📄 logger: [Logger](../interface.Logger/README.md)



#### ⚙ getTimezoneMsecOffsetFromSystem(): `number`



#### ⚙ authSendUint8Packet(value: `number`): Promise\<`void`>



#### ⚙ authSendBytesPacket(value: Uint8Array): Promise\<`void`>



#### ⚙ use(schema: `string`): `void`



#### ⚙ setSqlLogger(sqlLogger?: [SafeSqlLogger](../class.SafeSqlLogger/README.md)): `void`



#### ⚙ writeComInitDb(schema: `string`): `void`



#### ⚙ sendComQuery\<Row>(sql: [SqlSource](../type.SqlSource/README.md), rowType: [RowType](../enum.RowType/README.md)=RowType.VOID, letReturnUndefined: `boolean`=false, multiStatements: [SetOption](../enum.SetOption/README.md) | [MultiStatements](../enum.MultiStatements/README.md)=MultiStatements.NO\_MATTER): Promise\<[ResultsetsInternal](../class.ResultsetsInternal/README.md)\<Row>>

> On success returns ResultsetsProtocol<Row>.
> On error throws exception.
> If `letReturnUndefined` and communication error occured on connection that was just taken form pool, returns undefined.



#### ⚙ sendThreeQueries\<Row>(preStmtId: `number`, preStmtParams: `unknown`\[] | `undefined`, prequery: Uint8Array | `string` | `undefined`, ignorePrequeryError: `boolean`, sql: [SqlSource](../type.SqlSource/README.md), rowType: [RowType](../enum.RowType/README.md)=RowType.VOID, letReturnUndefined: `boolean`=false, multiStatements: [SetOption](../enum.SetOption/README.md) | [MultiStatements](../enum.MultiStatements/README.md)=MultiStatements.NO\_MATTER): Promise\<[ResultsetsInternal](../class.ResultsetsInternal/README.md)\<Row>>

> Send 2 or 3 queries in 1 round-trip.
> First sends preStmt (if preStmtId >= 0) defined by `preStmtId` and `preStmtParams`.
> Then sends `prequery`.
> `preStmt` and `prequery` must not return resultsets.
> Number of placeholders in prepared query must be exactly `preStmtParams.length`.
> And finally it sends `sql`.
> Then it reads the results of the sent queries.
> If one of the queries returned error, exception will be thrown (excepting the case when `ignorePrequeryError` was true, and `prequery` thrown error).



#### ⚙ sendComStmtPrepare\<Row>(sql: [SqlSource](../type.SqlSource/README.md), putParamsTo: [Any](../private.type.Any/README.md)\[] | `undefined`, rowType: [RowType](../enum.RowType/README.md), letReturnUndefined: `boolean`=false, skipColumns: `boolean`=false): Promise\<[ResultsetsInternal](../class.ResultsetsInternal/README.md)\<Row>>

> On success returns ResultsetsProtocol<Row>.
> On error throws exception.
> If `letReturnUndefined` and communication error occured on connection that was just taken form pool, returns undefined.



#### ⚙ disposePreparedStmt(stmtId: `number`): `void`

> This function can be called at any time, and the actual operation will be performed later when the connections enters idle state.



#### ⚙ execStmt(resultsets: [ResultsetsInternal](../class.ResultsetsInternal/README.md)\<`unknown`>, params: [Param](../type.Param/README.md)\[]): Promise\<`void`>



#### ⚙ fetch\<Row>(rowType: [RowType](../enum.RowType/README.md)): Promise\<Row>



#### ⚙ nextResultset(ignoreTerminated: `boolean`=false): Promise\<`boolean`>



#### ⚙ end(rollbackPreparedXaId: `string`="", recycleConnection: `boolean`=false, withDisposeSqlLogger: `boolean`=false): Promise\<Uint8Array | MyProtocol>

> Finalize session (skip unread resultsets, and execute COM_RESET_CONNECTION), then if the connection is alive, reinitialize it (set dsn.schema and execute dsn.initSql).
> If the connection was alive, and `recycleConnection` was true, returns new `MyProtocol` object with the same `Deno.Conn` to the database, and current object marks as terminated (method calls will throw `CanceledError`).
> If the connection was dead, returns Uint8Array buffer to be recycled.
> This function doesn't throw errors (errors can be considered fatal).



#### 🔧 `protected` `constructor`(writer: WritableStreamDefaultWriter\<Uint8Array>, reader: ReadableStreamBYOBReader, closer: Disposable, decoder: TextDecoder, useBuffer: Uint8Array | `undefined`, dsn: [Dsn](../class.Dsn/README.md), logger: [Logger](../interface.Logger/README.md)=console)



