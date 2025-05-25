# `const` `enum` CanRetry

[Documentation Index](../README.md)

```ts
import {CanRetry} from "https://deno.land/x/office_spirit_mysql@v0.22.0/mod.ts"
```

How fatal is the SQL error. Maybe just the same query can be retried second time, and there's chance that it'll succeed.
Maybe the current transaction can be retried with the same sequence of queries, and it can succeed.
Maybe disconnecting and reconnecting can solve the error.
Or nothing of the above.

#### NONE = <mark>0</mark>



#### CONN = <mark>1</mark>



#### TRX = <mark>2</mark>



#### QUERY = <mark>3</mark>



