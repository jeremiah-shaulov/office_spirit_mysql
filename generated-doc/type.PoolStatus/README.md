# `type` PoolStatus

[Documentation Index](../README.md)

```ts
import {PoolStatus} from "https://deno.land/x/office_spirit_mysql@v0.20.1/mod.ts"
```

## This type has

- 3 properties:
[nBusy](#-nbusy-number),
[nIdle](#-nidle-number),
[healthStatus](#-healthstatus-number)


#### 📄 nBusy: `number`

> Number of connections that are in use.



#### 📄 nIdle: `number`

> Number of connections that are idle.



#### 📄 healthStatus: `number`

> Health status that reflects the ratio of successful and failed connection attempts.
> The connection attempts are those when no idle connection was found in the pool, and new connection was created.
> This library tracks the health status for the last 1 minute, and you can specify the period (1 - 60 sec) for which to return the status in [MyPool.getStatus()](../class.MyPool/README.md#-getstatushealthstatusforperiodsec-numbertrack_healh_status_for_period_sec-mapdsn-poolstatus).
> 0.0 - all failed, 1.0 - all successful, NaN - there were no connection attempts.



