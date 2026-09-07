# `type` PoolStatus

[Documentation Index](../README.md)

```ts
import {PoolStatus} from "jsr:@shaulov/office-spirit-mysql@0.29.0"
```

## This type has

- 4 properties:
[nBusy](#-nbusy-number),
[nIdle](#-nidle-number),
[nWaiting](#-nwaiting-number),
[healthStatus](#-healthstatus-number)


#### 📄 nBusy: `number`

> Number of connections that are in use.



#### 📄 nIdle: `number`

> Number of connections that are idle.



#### 📄 nWaiting: `number`

> Number of connection requests parked in this DSN's wait queue, waiting for a busy connection to be returned.
> Nonzero only while `nBusy` is at [maxConns](../class.Dsn/README.md#-accessor-maxconns-number), and capped at [maxConnsWaitQueue](../interface.MyPoolOptions/README.md#-readonly-maxconnswaitqueue-number),
> at which point further requests are rejected immediately instead of queuing.
> 
> This is what tells "at the ceiling, and draining" from "at the ceiling, and turning requests away": `nBusy` alone
> looks the same in both. A waiter that is between two wait iterations (its `reconnectInterval` slice elapsed and it
> has not re-parked yet) is not counted, so a saturated pool can report slightly fewer waiters than it has.



#### 📄 healthStatus: `number`

> Health status that reflects the ratio of successful and failed connection attempts.
> The connection attempts are those when no idle connection was found in the pool, and new connection was created.
> This library tracks the health status for the last 1 minute, and you can specify the period (1 - 60 sec) for which to return the status in [MyPool.getStatus()](../class.MyPool/README.md#-getstatushealthstatusforperiodsec-numbertrack_healh_status_for_period_sec-mapdsn-poolstatus).
> 0.0 - all failed, 1.0 - all successful, NaN - there were no connection attempts.



