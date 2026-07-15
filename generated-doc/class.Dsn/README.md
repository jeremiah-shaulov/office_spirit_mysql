# `class` Dsn

[Documentation Index](../README.md)

```ts
import {Dsn} from "https://deno.land/x/office_spirit_mysql@v0.28.0/mod.ts"
```

Data source name. URL string that specifies how to connect to MySQL server.
Format: `mysql://user:password@host:port/schema?param1=value1&param2=value2#INITIAL_SQL`.
Or: `mysql://user:password@localhost/path/to/named.pipe/schema`.

Example: `mysql://root@localhost/` or `mysql://root:hello@[::1]/?keepAliveTimeout=10000&foundRows`.

Possible parameters:
- [connectionTimeout](../class.Dsn/README.md#-accessor-connectiontimeout-number)
- [reconnectInterval](../class.Dsn/README.md#-accessor-reconnectinterval-number)
- [keepAliveTimeout](../class.Dsn/README.md#-accessor-keepalivetimeout-number)
- [keepAliveMax](../class.Dsn/README.md#-accessor-keepalivemax-number)
- [maxConns](../class.Dsn/README.md#-accessor-maxconns-number)
- [maxColumnLen](../class.Dsn/README.md#-accessor-maxcolumnlen-number)
- [foundRows](../class.Dsn/README.md#-accessor-foundrows-boolean)
- [ignoreSpace](../class.Dsn/README.md#-accessor-ignorespace-boolean)
- [retryLockWaitTimeout](../class.Dsn/README.md#-accessor-retrylockwaittimeout-boolean)
- [retryQueryTimes](../class.Dsn/README.md#-accessor-retryquerytimes-number)
- [jsonAsString](../class.Dsn/README.md#-accessor-jsonasstring-boolean)
- [datesAsString](../class.Dsn/README.md#-accessor-datesasstring-boolean)
- [correctDates](../class.Dsn/README.md#-accessor-correctdates-boolean)
- [storeResultsetIfBigger](../class.Dsn/README.md#-accessor-storeresultsetifbigger-number)
- [allowPublicKeyRetrieval](../class.Dsn/README.md#-accessor-allowpublickeyretrieval-boolean)
- [serverPublicKey](../class.Dsn/README.md#-accessor-serverpublickey-string)
- [allowCleartextPasswords](../class.Dsn/README.md#-accessor-allowcleartextpasswords-boolean)
- [compress](../class.Dsn/README.md#-accessor-compress-dsncompress)
- [tls](../class.Dsn/README.md#-accessor-tls-boolean)
- [tlsCaCert](../class.Dsn/README.md#-accessor-tlscacert-string)
- [tlsHostname](../class.Dsn/README.md#-accessor-tlshostname-string)

## This class has

- [constructor](#-constructordsn-string--dsn)
- 32 properties:
[hostname](#-accessor-hostname-string),
[port](#-accessor-port-number),
[username](#-accessor-username-string),
[password](#-accessor-password-string),
[schema](#-accessor-schema-string),
[pipe](#-accessor-pipe-string),
[connectionTimeout](#-accessor-connectiontimeout-number),
[reconnectInterval](#-accessor-reconnectinterval-number),
[keepAliveTimeout](#-accessor-keepalivetimeout-number),
[keepAliveMax](#-accessor-keepalivemax-number),
[maxConns](#-accessor-maxconns-number),
[maxColumnLen](#-accessor-maxcolumnlen-number),
[foundRows](#-accessor-foundrows-boolean),
[ignoreSpace](#-accessor-ignorespace-boolean),
[retryLockWaitTimeout](#-accessor-retrylockwaittimeout-boolean),
[retryQueryTimes](#-accessor-retryquerytimes-number),
[jsonAsString](#-accessor-jsonasstring-boolean),
[datesAsString](#-accessor-datesasstring-boolean),
[correctDates](#-accessor-correctdates-boolean),
[storeResultsetIfBigger](#-accessor-storeresultsetifbigger-number),
[allowPublicKeyRetrieval](#-accessor-allowpublickeyretrieval-boolean),
[serverPublicKey](#-accessor-serverpublickey-string),
[allowCleartextPasswords](#-accessor-allowcleartextpasswords-boolean),
[compress](#-accessor-compress-dsncompress),
[tls](#-accessor-tls-boolean),
[tlsCaCert](#-accessor-tlscacert-string),
[tlsHostname](#-accessor-tlshostname-string),
[initSql](#-accessor-initsql-string),
[name](#-get-name-string),
[hash](#-get-hash-number),
[hashNoSchema](#-get-hashnoschema-number),
[addr](#-get-addr-connectoptions--transport-unix-path-string)
- method [toString](#-tostring-string)
- [deprecated symbol](#-deprecated-accessor-multistatements-boolean)


#### 🔧 `constructor`(dsn: `string` | [Dsn](../class.Dsn/README.md))



#### 📄 `accessor` hostname: `string`



#### 📄 `accessor` port: `number`



#### 📄 `accessor` username: `string`



#### 📄 `accessor` password: `string`



#### 📄 `accessor` schema: `string`



#### 📄 `accessor` pipe: `string`

> Path to unix-domain socket file, through which to connect to the server.



#### 📄 `accessor` connectionTimeout: `number`

> Default value: `5000`
> 
> Milliseconds. If connection to the server is failing, it will be retried during this period of time, each `reconnectInterval` milliseconds.



#### 📄 `accessor` reconnectInterval: `number`

> Default value: `500`
> 
> Milliseconds. Will retry connecting to the server each this number of milliseconds, during the `connectionTimeout`.



#### 📄 `accessor` keepAliveTimeout: `number`

> Default value: `10000`
> 
> Milliseconds. Each connection will persist for this period of time, before termination, so it can be reused when someone else asks for the same connection.



#### 📄 `accessor` keepAliveMax: `number`

> Default value: `Infinity`
> 
> How many times at most to recycle each connection.



#### 📄 `accessor` maxConns: `number`

> Default value: `250`
> 
> Limit number of simultaneous connections to this DSN in pool.



#### 📄 `accessor` maxColumnLen: `number`

> Default value: `10MiB`
> 
> Bytes. If a column was longer, it's value is skipped, and it will be returned as NULL.



#### 📄 `accessor` foundRows: `boolean`

> Default value: `false`
> 
> If present, will use "found rows" instead of "affected rows" in resultsets.



#### 📄 `accessor` ignoreSpace: `boolean`

> Default value: `false`
> 
> If present, parser on server side can ignore spaces before '(' in built-in function names.



#### 📄 `accessor` retryLockWaitTimeout: `boolean`

> Default value: `false`
> 
> If set, and `retryQueryTimes` is also set, will retry query that failed with "lock wait timeout" error. The query will be retried `retryQueryTimes` times.



#### 📄 `accessor` retryQueryTimes: `number`

> Default value: `0`
> 
> Automatically reissue queries this number of attempts, if error was "deadlock" in autocommit mode, or (if `retryLockWaitTimeout` was set) "lock wait timeout" in both modes.
> Please note, that this will also rerun queries like `CALL`.



#### 📄 `accessor` jsonAsString: `boolean`

> Default value: `false`
> 
> If present, json columns will not be parsed when selected from MySQL, so they'll be returned as strings.



#### 📄 `accessor` datesAsString: `boolean`

> Default value: `false`
> 
> If present, date, datetime and timestamp columns will not be converted to `Date` objects when selected from MySQL, so they'll be returned as strings.



#### 📄 `accessor` correctDates: `boolean`

> Default value: `false`
> 
> Enables timezone correction when converting between Javascript `Date` objects and MySQL date, datetime and timestamp types.
> This is only supported on MySQL 5.7+, and this is not supported on MariaDB at least up to v10.7.



#### 📄 `accessor` storeResultsetIfBigger: `number`

> Default value: `64KiB`
> 
> When using [Resultsets.buffered()](../class.Resultsets/README.md#-buffered-promisethis) and the resultset is bigger than this number of bytes, it will be stored on disk, rather than in RAM (array).



#### 📄 `accessor` allowPublicKeyRetrieval: `boolean`

> Default value: `false`
> 
> If the server uses `caching_sha2_password` or `sha256_password` authentication over unencrypted TCP connection, this library can need the server RSA public key to encrypt the password.
> `sha256_password` always needs it, and `caching_sha2_password` needs it when the server asks for the full authentication - that happens when the password is not in the server side cache, like on the first connection after the server restart.
> The client cannot see the state of that cache, so such connection is refused before the authentication starts, rather than only when the server happens to ask for the key.
> If this parameter is present, the key will be requested from the server itself, through the untrusted connection.
> This is vulnerable to man-in-the-middle attacks, where the attacker can substitute the key, and decrypt the password.
> To avoid the risk, enable [tls](../class.Dsn/README.md#-accessor-tls-boolean), or pin the trusted key in [serverPublicKey](../class.Dsn/README.md#-accessor-serverpublickey-string), or connect through Unix-domain socket.



#### 📄 `accessor` serverPublicKey: `string`

> Default value: `empty string`
> 
> Server RSA public key, used to encrypt the password during `caching_sha2_password` full authentication or `sha256_password` authentication over unencrypted connection.
> If this parameter is set, the key will not be requested from the server.
> You can get the key by executing `SHOW STATUS LIKE 'Caching_sha2_password_rsa_public_key'` (for `sha256_password` - `SHOW STATUS LIKE 'Rsa_public_key'`) on the server.
> The setter accepts PEM string ("-----BEGIN PUBLIC KEY-----...") or only it's base64 body. The value is stored without the PEM armor and whitespace.
> In DSN string this parameter must be percent-encoded (e.g. with `encodeURIComponent()`).



#### 📄 `accessor` allowCleartextPasswords: `boolean`

> Default value: `false`
> 
> If the server requests `mysql_clear_password` authentication (usually because the account uses PAM or LDAP on the server side), this library needs to send the password in clear text.
> If this parameter is present, the password will be sent through the unencrypted TCP connection, where an eavesdropper can read it, so only use it when the network path is trusted.
> Connections through Unix-domain socket are always allowed to use this authentication method.



#### 📄 `accessor` compress: DsnCompress

> Default value: `false`
> 
> If present, and the server supports the compressed protocol, the packets between the client and the server will be compressed.
> This reduces the network traffic at the cost of some CPU time, so it pays off on slow or metered links, or when large query results travel the network.
> There are 2 algorithms: zlib (deflate), that every server supports, and zstd (usually better and faster), that only MySQL 8.0.18+ supports (and this runtime must have zstd in `node:zlib` - Deno 2.7+).
> The plain `compress` (`true`) negotiates the best of what's supported: zstd if possible, else zlib. `compress=zlib` and `compress=zstd` pin the algorithm
> (if the server doesn't support the pinned one, the connection is not compressed). `compress=zstd:N` also sets the zstd compression level (1 - 22, default 3),
> that both sides will use (the level is sent to the server during the handshake).
> The compression starts after the authentication. When used together with [tls](../class.Dsn/README.md#-accessor-tls-boolean), the packets are compressed before being encrypted.



#### 📄 `accessor` tls: `boolean`

> Default value: `false`
> 
> If present, the connection will be upgraded to TLS before the authentication (and so before any credentials are sent).
> The server certificate will be validated against the operating system root certificates (or the ones from `DENO_CERT` environment variable), plus [tlsCaCert](../class.Dsn/README.md#-accessor-tlscacert-string) if set.
> This only applies to TCP connections. For Unix-domain socket (see [pipe](../class.Dsn/README.md#-accessor-pipe-string)) this parameter is ignored.



#### 📄 `accessor` tlsCaCert: `string`

> Default value: `empty string`
> 
> CA certificate (or several certificates concatenated) in PEM format, that the server certificate will be validated against, in addition to the built-in root certificates.
> Use it when the server has a self-signed certificate, or a certificate issued by your private CA.
> Setting this to nonempty string also enables [tls](../class.Dsn/README.md#-accessor-tls-boolean).
> In DSN string this parameter must be percent-encoded (e.g. with `encodeURIComponent()`).



#### 📄 `accessor` tlsHostname: `string`

> Default value: `empty string`
> 
> Host name that the server certificate must be issued to.
> Set it when you connect by IP address or through a tunnel, and the certificate is issued to the server domain name.
> If empty, [hostname](../class.Dsn/README.md#-accessor-hostname-string) is used.
> Setting this to nonempty string also enables [tls](../class.Dsn/README.md#-accessor-tls-boolean).



#### 📄 `accessor` initSql: `string`

> SQL statement, or several statements separated with `;`, that will be executed to initialize each connection right after connecting.



#### 📄 `get` name(): `string`

> String representation of this object. Synonym of [toString()](../class.Dsn/README.md#-tostring-string).



#### 📄 `get` hash(): `number`

> Numeric hash of [name](../class.Dsn/README.md#-get-name-string) string.



#### 📄 `get` hashNoSchema(): `number`

> Numeric hash of string that represents all parts of this object except schema name.



#### 📄 `get` addr(): ConnectOptions | \{transport: <mark>"unix"</mark>, path: `string`}

> `Deno.ConnectOptions` object for hostname and port, or unix-domain socket.



#### ⚙ toString(): `string`



<div style="opacity:0.6">

#### 📄 `deprecated` `accessor` multiStatements: `boolean`

> SQL can contain multiple statements separated with ';', so you can upload dumps, but SQL injection attacks become more risky.
> 
> `deprecated`
> 
> To execute multiple statements use `queriesVoid()` function and the such.



</div>

