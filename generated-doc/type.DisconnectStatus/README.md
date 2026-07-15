# `type` DisconnectStatus

[Documentation Index](../README.md)

```ts
import {DisconnectStatus} from "https://deno.land/x/office_spirit_mysql@v0.28.0/mod.ts"
```

Object that [MyConn.forceImmediateDisconnect()](../class.MyConn/README.md#-forceimmediatedisconnectnorollbackcurxa-booleanfalse-nokillcurquery-booleanfalse-disconnectstatus) returns.

## This type has

- 4 properties:
[dsn](#-dsn-dsn),
[connectionId](#-connectionid-number),
[wasInQueryingState](#-wasinqueryingstate-boolean),
[preparedXaId](#-preparedxaid-string)


#### 📄 dsn: [Dsn](../class.Dsn/README.md)

> DSN of the connection.



#### 📄 connectionId: `number`

> Thread ID of the connection that `SHOW PROCESSLIST` shows.
> You can use it to KILL running query if there's one (after reconnecting).



#### 📄 wasInQueryingState: `boolean`

> True if the connection was in "querying" state (so you may want to KILL the running query).



#### 📄 preparedXaId: `string`

> If at the moment of termination there was a distributed transaction in "prepared" state, this field contains XA ID of the transaction.
> You need to reconnect and ROLLBACK it.
> 
> Contains empty string if there was no such transaction.



