import {crc32} from "./deps.ts";

const wantUrlDecodeUsername = new URL('http://ф@localhost/').username.charAt(0) == '%';
const wantUrlDecodePassword = new URL('http://u:ф@localhost/').password.charAt(0) == '%';
// The URL `pathname` always starts with `/`, so the first character can't be `%`. Inspect the next character to detect whether the runtime keeps percent-encoded bytes (which we then need to decode ourselves).
const wantUrlDecodePathname = new URL('http://localhost/ф').pathname.charAt(1) == '%';

// deno-lint-ignore no-explicit-any
type Any = any;

/**	Value of the {@link Dsn.compress} parameter:
	- `false` - don't compress;
	- `true` - compress with the best algorithm that the server and this runtime support: zstd (with the default level 3) is preferred, zlib is the fallback;
	- `zlib` - only zlib;
	- `zstd` - only zstd (with the default level 3);
	- `zstd:N` - only zstd with compression level N (1 - 22, e.g. `zstd:19`).
 **/
export type DsnCompress = boolean | 'zlib' | 'zstd' | `zstd:${number}`;

/**	Validate a {@link DsnCompress} coming from a DSN string parameter or from the property setter.
 **/
function parseCompress(value: string|boolean|null): DsnCompress
{	if (typeof(value) != 'string')
	{	return !!value;
	}
	switch (value)
	{	case '':
			return true;
		case 'zlib':
		case 'zstd':
			return value;
		default:
		{	if (value.startsWith('zstd:'))
			{	const level = Number(value.slice(5));
				if (Number.isInteger(level) && level>=1 && level<=22)
				{	return `zstd:${level}`;
				}
			}
			throw new Error(`Invalid "compress" value: ${value}. Can be "zlib", "zstd" or "zstd:N", where N is the zstd compression level (1 - 22)`);
		}
	}
}

/**	Extracts the base64 body from PEM public key, like "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----", dropping the armor lines and all whitespace.
	If there's no PEM armor, assumes that the whole string is the base64 body, and only strips whitespace and zero bytes (MySQL server terminates the key with zero byte when sending it during handshake).
 **/
export function publicKeyToBase64(publicKey: string)
{	const m = publicKey.match(/-----BEGIN[^-]*-----([^-]*)-----END[^-]*-----/);
	return (m ? m[1] : publicKey).replace(/[\s\0]+/g, '');
}

/** Data source name. URL string that specifies how to connect to MySQL server.
	Format: `mysql://user:password@host:port/schema?param1=value1&param2=value2#INITIAL_SQL`.
	Or: `mysql://user:password@localhost/path/to/named.pipe/schema`.

	Example: `mysql://root@localhost/` or `mysql://root:hello@[::1]/?keepAliveTimeout=10000&foundRows`.

	Possible parameters:
	- {@link connectionTimeout}
	- {@link reconnectInterval}
	- {@link keepAliveTimeout}
	- {@link keepAliveMax}
	- {@link maxConns}
	- {@link maxColumnLen}
	- {@link foundRows}
	- {@link ignoreSpace}
	- {@link retryLockWaitTimeout}
	- {@link retryQueryTimes}
	- {@link jsonAsString}
	- {@link datesAsString}
	- {@link correctDates}
	- {@link storeResultsetIfBigger}
	- {@link allowPublicKeyRetrieval}
	- {@link serverPublicKey}
	- {@link allowCleartextPasswords}
	- {@link compress}
	- {@link tls}
	- {@link tlsCaCert}
	- {@link tlsHostname}
 **/
export class Dsn
{	#hostname: string;
	#port: number;
	#username: string;
	#password: string;
	#schema: string;
	#pipe: string;
	#connectionTimeout: number;
	#reconnectInterval: number;
	#keepAliveTimeout: number;
	#keepAliveMax: number;
	#maxConns: number;
	#maxColumnLen: number;
	/** Use "found rows" instead of "affected rows" */
	#foundRows: boolean;
	/** Parser on server can ignore spaces before '(' in built-in function names */
	#ignoreSpace: boolean;
	/**	SQL can contain multiple statements separated with ';', so you can upload dumps, but SQL injection attacks become more risky.
		@deprecated To execute multiple statements use `queriesVoid()` function and the such.
	 **/
	#multiStatements: boolean;
	#retryLockWaitTimeout: boolean;
	#retryQueryTimes: number;
	#jsonAsString: boolean;
	#datesAsString: boolean;
	#correctDates: boolean;
	#storeResultsetIfBigger: number;
	/** Allow to retrieve the server RSA public key through the untrusted connection during `caching_sha2_password` full authentication */
	#allowPublicKeyRetrieval: boolean;
	/** Pinned server RSA public key (base64 body of the PEM) for `caching_sha2_password` full authentication */
	#serverPublicKey: string;
	/** Allow to send the password in clear text through the untrusted connection, if the server requests `mysql_clear_password` authentication */
	#allowCleartextPasswords: boolean;
	/** Use the compressed protocol */
	#compress: DsnCompress;
	/** Connect over TLS */
	#tls: boolean;
	/** CA certificate(s) in PEM format, to validate the server certificate against (in addition to the built-in root certificates) */
	#tlsCaCert: string;
	/** Server host name that the server certificate must be issued to, if different from `hostname` */
	#tlsHostname: string;
	#initSql: string;
	#name: string;
	#hash: number;
	#hashNoSchema: number;

	get hostname()
	{	return this.#hostname;
	}
	set hostname(value: string)
	{	if (value.charAt(0)=='[' && value.slice(-1)==']') // IPv6, like [::1]:3306
		{	value = value.slice(1, -1);
		}
		this.#hostname = value;
		this.#updateNameAndHash();
	}

	get port()
	{	return this.#port;
	}
	set port(value: number)
	{	this.#port = !value || !isFinite(value) ? 3306 : value;
		this.#updateNameAndHash();
	}

	get username()
	{	return this.#username;
	}
	set username(value: string)
	{	this.#username = value;
		this.#updateNameAndHash();
	}

	get password()
	{	return this.#password;
	}
	set password(value: string)
	{	this.#password = value;
		this.#updateNameAndHash();
	}

	get schema()
	{	return this.#schema;
	}
	set schema(value: string)
	{	this.#schema = value;
		this.#updateNameAndHash();
	}

	/**	Path to unix-domain socket file, through which to connect to the server.
	 **/
	get pipe()
	{	return this.#pipe;
	}
	set pipe(value: string)
	{	if (value.length>0 && value.charAt(0)!='/')
		{	value = '/'+value;
		}
		this.#pipe = value;
		this.#updateNameAndHash();
	}

	/**	Milliseconds. If connection to the server is failing, it will be retried during this period of time, each `reconnectInterval` milliseconds.
		@default 5000
	 **/
	get connectionTimeout()
	{	return this.#connectionTimeout;
	}
	set connectionTimeout(value: number)
	{	this.#connectionTimeout = Math.max(0, value);
		this.#updateNameAndHash();
	}

	/**	Milliseconds. Will retry connecting to the server each this number of milliseconds, during the `connectionTimeout`.
		@default 500
	 **/
	get reconnectInterval()
	{	return this.#reconnectInterval;
	}
	set reconnectInterval(value: number)
	{	this.#reconnectInterval = Math.max(0, value);
		this.#updateNameAndHash();
	}

	/**	Milliseconds. Each connection will persist for this period of time, before termination, so it can be reused when someone else asks for the same connection.
		@default 10000
	 **/
	get keepAliveTimeout()
	{	return this.#keepAliveTimeout;
	}
	set keepAliveTimeout(value: number)
	{	this.#keepAliveTimeout = Math.max(0, value);
		this.#updateNameAndHash();
	}

	/**	How many times at most to recycle each connection.
		@default Infinity
	 **/
	get keepAliveMax()
	{	return this.#keepAliveMax;
	}
	set keepAliveMax(value: number)
	{	this.#keepAliveMax = Math.max(0, value);
		this.#updateNameAndHash();
	}

	/**	Limit number of simultaneous connections to this DSN in pool.
		@default 250
	 **/
	get maxConns()
	{	return this.#maxConns;
	}
	set maxConns(value: number)
	{	this.#maxConns = Math.max(1, value);
		this.#updateNameAndHash();
	}

	/**	Bytes. If a column was longer, it's value is skipped, and it will be returned as NULL.
		@default 10MiB
	 **/
	get maxColumnLen()
	{	return this.#maxColumnLen;
	}
	set maxColumnLen(value: number)
	{	this.#maxColumnLen = Math.max(1, value);
		this.#updateNameAndHash();
	}

	/**	If present, will use "found rows" instead of "affected rows" in resultsets.
		@default false
	 **/
	get foundRows()
	{	return this.#foundRows;
	}
	set foundRows(value: boolean)
	{	this.#foundRows = value;
		this.#updateNameAndHash();
	}

	/**	If present, parser on server side can ignore spaces before '(' in built-in function names.
		@default false
	 **/
	get ignoreSpace()
	{	return this.#ignoreSpace;
	}
	set ignoreSpace(value: boolean)
	{	this.#ignoreSpace = value;
		this.#updateNameAndHash();
	}

	/**	SQL can contain multiple statements separated with ';', so you can upload dumps, but SQL injection attacks become more risky.
		@deprecated To execute multiple statements use `queriesVoid()` function and the such.
	 **/
	get multiStatements()
	{	return this.#multiStatements;
	}
	set multiStatements(value: boolean)
	{	this.#multiStatements = value;
		this.#updateNameAndHash();
	}

	/**	If set, and `retryQueryTimes` is also set, will retry query that failed with "lock wait timeout" error. The query will be retried `retryQueryTimes` times.
		@default false
	 **/
	get retryLockWaitTimeout()
	{	return this.#retryLockWaitTimeout;
	}
	set retryLockWaitTimeout(value: boolean)
	{	this.#retryLockWaitTimeout = value;
		this.#updateNameAndHash();
	}

	/**	Automatically reissue queries this number of attempts, if error was "deadlock" in autocommit mode, or (if `retryLockWaitTimeout` was set) "lock wait timeout" in both modes.
		Please note, that this will also rerun queries like `CALL`.
		@default 0
	 **/
	get retryQueryTimes()
	{	return this.#retryQueryTimes;
	}
	set retryQueryTimes(value: number)
	{	this.#retryQueryTimes = value>=0 ? value : NaN;
		this.#updateNameAndHash();
	}

	/**	If present, json columns will not be parsed when selected from MySQL, so they'll be returned as strings.
		@default false
	 **/
	get jsonAsString()
	{	return this.#jsonAsString;
	}
	set jsonAsString(value: boolean)
	{	this.#jsonAsString = value;
		this.#updateNameAndHash();
	}

	/**	If present, date, datetime and timestamp columns will not be converted to `Date` objects when selected from MySQL, so they'll be returned as strings.
		@default false
	 **/
	get datesAsString()
	{	return this.#datesAsString;
	}
	set datesAsString(value: boolean)
	{	this.#datesAsString = value;
		this.#updateNameAndHash();
	}

	/**	Enables timezone correction when converting between Javascript `Date` objects and MySQL date, datetime and timestamp types.
		This is only supported on MySQL 5.7+, and this is not supported on MariaDB at least up to v10.7.
		@default false
	 **/
	get correctDates()
	{	return this.#correctDates;
	}
	set correctDates(value: boolean)
	{	this.#correctDates = value;
		this.#updateNameAndHash();
	}

	/**	When using {@link Resultsets.buffered()} and the resultset is bigger than this number of bytes, it will be stored on disk, rather than in RAM (array).
		@default 64KiB
	 **/
	get storeResultsetIfBigger()
	{	return this.#storeResultsetIfBigger;
	}
	set storeResultsetIfBigger(value: number)
	{	this.#storeResultsetIfBigger = value>=0 ? value : NaN;
		this.#updateNameAndHash();
	}

	/**	If the server requests `caching_sha2_password` full authentication or `sha256_password` authentication over unencrypted TCP connection, this library needs the server RSA public key to encrypt the password.
		If this parameter is present, the key will be requested from the server itself, through the untrusted connection.
		This is vulnerable to man-in-the-middle attacks, where the attacker can substitute the key, and decrypt the password.
		To avoid the risk, enable {@link tls}, or pin the trusted key in {@link serverPublicKey}, or connect through Unix-domain socket.
		@default false
	 **/
	get allowPublicKeyRetrieval()
	{	return this.#allowPublicKeyRetrieval;
	}
	set allowPublicKeyRetrieval(value: boolean)
	{	this.#allowPublicKeyRetrieval = value;
		this.#updateNameAndHash();
	}

	/**	Server RSA public key, used to encrypt the password during `caching_sha2_password` full authentication or `sha256_password` authentication over unencrypted connection.
		If this parameter is set, the key will not be requested from the server.
		You can get the key by executing `SHOW STATUS LIKE 'Caching_sha2_password_rsa_public_key'` (for `sha256_password` - `SHOW STATUS LIKE 'Rsa_public_key'`) on the server.
		The setter accepts PEM string ("-----BEGIN PUBLIC KEY-----...") or only it's base64 body. The value is stored without the PEM armor and whitespace.
		In DSN string this parameter must be percent-encoded (e.g. with `encodeURIComponent()`).
		@default empty string
	 **/
	get serverPublicKey()
	{	return this.#serverPublicKey;
	}
	set serverPublicKey(value: string)
	{	this.#serverPublicKey = publicKeyToBase64(value);
		this.#updateNameAndHash();
	}

	/**	If the server requests `mysql_clear_password` authentication (usually because the account uses PAM or LDAP on the server side), this library needs to send the password in clear text.
		If this parameter is present, the password will be sent through the unencrypted TCP connection, where an eavesdropper can read it, so only use it when the network path is trusted.
		Connections through Unix-domain socket are always allowed to use this authentication method.
		@default false
	 **/
	get allowCleartextPasswords()
	{	return this.#allowCleartextPasswords;
	}
	set allowCleartextPasswords(value: boolean)
	{	this.#allowCleartextPasswords = value;
		this.#updateNameAndHash();
	}

	/**	If present, and the server supports the compressed protocol, the packets between the client and the server will be compressed.
		This reduces the network traffic at the cost of some CPU time, so it pays off on slow or metered links, or when large query results travel the network.
		There are 2 algorithms: zlib (deflate), that every server supports, and zstd (usually better and faster), that only MySQL 8.0.18+ supports (and this runtime must have zstd in `node:zlib` - Deno 2.7+).
		The plain `compress` (`true`) negotiates the best of what's supported: zstd if possible, else zlib. `compress=zlib` and `compress=zstd` pin the algorithm
		(if the server doesn't support the pinned one, the connection is not compressed). `compress=zstd:N` also sets the zstd compression level (1 - 22, default 3),
		that both sides will use (the level is sent to the server during the handshake).
		The compression starts after the authentication. When used together with {@link tls}, the packets are compressed before being encrypted.
		@default false
	 **/
	get compress()
	{	return this.#compress;
	}
	set compress(value: DsnCompress)
	{	this.#compress = parseCompress(value);
		this.#updateNameAndHash();
	}

	/**	If present, the connection will be upgraded to TLS before the authentication (and so before any credentials are sent).
		The server certificate will be validated against the operating system root certificates (or the ones from `DENO_CERT` environment variable), plus {@link tlsCaCert} if set.
		This only applies to TCP connections. For Unix-domain socket (see {@link pipe}) this parameter is ignored.
		@default false
	 **/
	get tls()
	{	return this.#tls;
	}
	set tls(value: boolean)
	{	this.#tls = value;
		this.#updateNameAndHash();
	}

	/**	CA certificate (or several certificates concatenated) in PEM format, that the server certificate will be validated against, in addition to the built-in root certificates.
		Use it when the server has a self-signed certificate, or a certificate issued by your private CA.
		Setting this to nonempty string also enables {@link tls}.
		In DSN string this parameter must be percent-encoded (e.g. with `encodeURIComponent()`).
		@default empty string
	 **/
	get tlsCaCert()
	{	return this.#tlsCaCert;
	}
	set tlsCaCert(value: string)
	{	this.#tlsCaCert = value;
		if (value)
		{	this.#tls = true;
		}
		this.#updateNameAndHash();
	}

	/**	Host name that the server certificate must be issued to.
		Set it when you connect by IP address or through a tunnel, and the certificate is issued to the server domain name.
		If empty, {@link hostname} is used.
		Setting this to nonempty string also enables {@link tls}.
		@default empty string
	 **/
	get tlsHostname()
	{	return this.#tlsHostname;
	}
	set tlsHostname(value: string)
	{	this.#tlsHostname = value;
		if (value)
		{	this.#tls = true;
		}
		this.#updateNameAndHash();
	}

	/**	SQL statement, or several statements separated with `;`, that will be executed to initialize each connection right after connecting.
	 **/
	get initSql()
	{	return this.#initSql;
	}
	set initSql(value: string)
	{	this.#initSql = value;
		this.#updateNameAndHash();
	}

	/**	String representation of this object. Synonym of {@link toString()}.
	 **/
	get name()
	{	return this.#name;
	}

	/**	Numeric hash of {@link name} string.
	 **/
	get hash()
	{	return this.#hash;
	}

	/**	Numeric hash of string that represents all parts of this object except schema name.
	 **/
	get hashNoSchema()
	{	return this.#hashNoSchema;
	}

	/**	`Deno.ConnectOptions` object for hostname and port, or unix-domain socket.
	 **/
	get addr(): Deno.ConnectOptions | {transport: 'unix', path: string}
	{	if (this.#pipe)
		{	return {transport: 'unix', path: this.#pipe} as Any; // "as any" in order to avoid requireing --unstable
		}
		else
		{	return {transport: 'tcp', hostname: this.#hostname, port: this.#port};
		}
	}

	constructor(dsn: string|Dsn)
	{	if (typeof(dsn) != 'string')
		{	this.#hostname = dsn.#hostname;
			this.#port = dsn.#port;
			this.#username = dsn.#username;
			this.#password = dsn.#password;
			this.#schema = dsn.#schema;
			this.#pipe = dsn.#pipe;
			this.#connectionTimeout = dsn.#connectionTimeout;
			this.#reconnectInterval = dsn.#reconnectInterval;
			this.#keepAliveTimeout = dsn.#keepAliveTimeout;
			this.#keepAliveMax = dsn.#keepAliveMax;
			this.#maxConns = dsn.#maxConns;
			this.#maxColumnLen = dsn.#maxColumnLen;
			this.#foundRows = dsn.#foundRows;
			this.#ignoreSpace = dsn.#ignoreSpace;
			this.#multiStatements = dsn.#multiStatements;
			this.#retryLockWaitTimeout = dsn.#retryLockWaitTimeout;
			this.#retryQueryTimes = dsn.#retryQueryTimes;
			this.#jsonAsString = dsn.#jsonAsString;
			this.#datesAsString = dsn.#datesAsString;
			this.#correctDates = dsn.#correctDates;
			this.#storeResultsetIfBigger = dsn.#storeResultsetIfBigger;
			this.#allowPublicKeyRetrieval = dsn.#allowPublicKeyRetrieval;
			this.#serverPublicKey = dsn.#serverPublicKey;
			this.#allowCleartextPasswords = dsn.#allowCleartextPasswords;
			this.#compress = dsn.#compress;
			this.#tls = dsn.#tls;
			this.#tlsCaCert = dsn.#tlsCaCert;
			this.#tlsHostname = dsn.#tlsHostname;
			this.#initSql = dsn.#initSql;
			this.#name = dsn.#name;
			this.#hash = dsn.#hash;
			this.#hashNoSchema = dsn.#hashNoSchema;
		}
		else
		{	if (!dsn)
			{	throw new Error(`No DSN string provided`);
			}
			let pos = dsn.indexOf(':');
			if (pos!=5 || dsn.slice(0, pos).toLowerCase()!='mysql')
			{	throw new Error(`Protocol not supported: ${dsn}`);
			}
			const url = new URL('http'+dsn.slice(5));
			let {hostname, username, password, pathname} = url;
			if (hostname.charAt(0)=='[' && hostname.slice(-1)==']') // IPv6, like [::1]:3306
			{	hostname = hostname.slice(1, -1);
			}
			this.#hostname = hostname;
			this.#port = !url.port ? 3306 : Number(url.port) || 3306;
			this.#username = wantUrlDecodeUsername ? decodeURIComponent(username) : username;
			this.#password = wantUrlDecodePassword ? decodeURIComponent(password) : password;
			pathname = wantUrlDecodePathname ? decodeURIComponent(pathname) : pathname;
			pos = pathname.lastIndexOf('/');
			this.#pipe = pathname.slice(0, pos);
			this.#schema = pathname.slice(pos + 1);
			// params
			const connectionTimeout = url.searchParams.get('connectionTimeout');
			const reconnectInterval = url.searchParams.get('reconnectInterval');
			const keepAliveTimeout = url.searchParams.get('keepAliveTimeout');
			const keepAliveMax = url.searchParams.get('keepAliveMax');
			const maxConns = url.searchParams.get('maxConns');
			const maxColumnLen = url.searchParams.get('maxColumnLen');
			const foundRows = url.searchParams.get('foundRows');
			const ignoreSpace = url.searchParams.get('ignoreSpace');
			const multiStatements = url.searchParams.get('multiStatements');
			const retryLockWaitTimeout = url.searchParams.get('retryLockWaitTimeout');
			const retryQueryTimes = url.searchParams.get('retryQueryTimes');
			const jsonAsString = url.searchParams.get('jsonAsString');
			const datesAsString = url.searchParams.get('datesAsString');
			const correctDates = url.searchParams.get('correctDates');
			const storeResultsetIfBigger = url.searchParams.get('storeResultsetIfBigger');
			const allowPublicKeyRetrieval = url.searchParams.get('allowPublicKeyRetrieval');
			const serverPublicKey = url.searchParams.get('serverPublicKey');
			const allowCleartextPasswords = url.searchParams.get('allowCleartextPasswords');
			const compress = url.searchParams.get('compress');
			const tls = url.searchParams.get('tls');
			const tlsCaCert = url.searchParams.get('tlsCaCert');
			const tlsHostname = url.searchParams.get('tlsHostname');
			this.#connectionTimeout = connectionTimeout!=null ? Math.max(0, Number(connectionTimeout)) : NaN;
			this.#reconnectInterval = reconnectInterval ? Math.max(0, Number(reconnectInterval)) : NaN;
			this.#keepAliveTimeout = keepAliveTimeout ? Math.max(0, Number(keepAliveTimeout)) : NaN;
			this.#keepAliveMax = keepAliveMax ? Math.max(0, Math.round(Number(keepAliveMax))) : NaN;
			this.#maxConns = maxConns ? Math.max(1, Number(maxConns)) : NaN;
			this.#maxColumnLen = maxColumnLen ? Math.max(1, Number(maxColumnLen)) : NaN;
			this.#foundRows = foundRows != null;
			this.#ignoreSpace = ignoreSpace != null;
			this.#multiStatements = multiStatements != null;
			this.#retryLockWaitTimeout = retryLockWaitTimeout != null;
			this.#retryQueryTimes = retryQueryTimes!=null ? Math.max(0, Number(retryQueryTimes)) : NaN;
			this.#jsonAsString = jsonAsString != null;
			this.#datesAsString = datesAsString != null;
			this.#correctDates = correctDates != null;
			this.#storeResultsetIfBigger = storeResultsetIfBigger!=null ? Math.max(0, Number(storeResultsetIfBigger) || 0) : NaN;
			this.#allowPublicKeyRetrieval = allowPublicKeyRetrieval != null;
			// `URLSearchParams` decodes '+' to space, and base64 contains '+' chars, so convert spaces back to '+' (legitimate spaces can only appear in the PEM armor, that is stripped anyway)
			this.#serverPublicKey = serverPublicKey ? publicKeyToBase64(serverPublicKey.replaceAll(' ', '+')) : '';
			this.#allowCleartextPasswords = allowCleartextPasswords != null;
			this.#compress = compress==null ? false : parseCompress(compress);
			this.#tlsCaCert = tlsCaCert ?? '';
			this.#tlsHostname = tlsHostname ?? '';
			this.#tls = tls!=null || !!this.#tlsCaCert || !!this.#tlsHostname;
			// initSql
			this.#initSql = decodeURIComponent(url.hash.slice(1)).trim();
			this.#name = '';
			this.#hash = 0;
			this.#hashNoSchema = 0;
			this.#updateNameAndHash();
		}
	}

	/**	Normalized name.
	 **/
	#updateNameAndHash()
	{	const params =
		(	(!isNaN(this.#connectionTimeout) ? '&connectionTimeout='+this.#connectionTimeout : '') +
			(!isNaN(this.#reconnectInterval) ? '&reconnectInterval='+this.#reconnectInterval : '') +
			(!isNaN(this.#keepAliveTimeout) ? '&keepAliveTimeout='+this.#keepAliveTimeout : '') +
			(!isNaN(this.#keepAliveMax) ? '&keepAliveMax='+this.#keepAliveMax : '') +
			(!isNaN(this.#maxConns) ? '&maxConns='+this.#maxConns : '') +
			(!isNaN(this.#maxColumnLen) ? '&maxColumnLen='+this.#maxColumnLen : '') +
			(this.#foundRows ? '&foundRows' : '') +
			(this.#ignoreSpace ? '&ignoreSpace' : '') +
			(this.#multiStatements ? '&multiStatements' : '') +
			(this.#retryLockWaitTimeout ? '&retryLockWaitTimeout' : '') +
			(!isNaN(this.#retryQueryTimes) ? '&retryQueryTimes='+this.#retryQueryTimes : '') +
			(this.#jsonAsString ? '&jsonAsString' : '') +
			(this.#datesAsString ? '&datesAsString' : '') +
			(this.#correctDates ? '&correctDates' : '') +
			(!isNaN(this.#storeResultsetIfBigger) ? '&storeResultsetIfBigger='+this.#storeResultsetIfBigger : '') +
			(this.#allowPublicKeyRetrieval ? '&allowPublicKeyRetrieval' : '') +
			(this.#serverPublicKey ? '&serverPublicKey='+encodeURIComponent(this.#serverPublicKey) : '') +
			(this.#allowCleartextPasswords ? '&allowCleartextPasswords' : '') +
			(this.#compress ? (this.#compress===true ? '&compress' : '&compress='+this.#compress) : '') +
			(this.#tls ? '&tls' : '') +
			(this.#tlsCaCert ? '&tlsCaCert='+encodeURIComponent(this.#tlsCaCert) : '') +
			(this.#tlsHostname ? '&tlsHostname='+encodeURIComponent(this.#tlsHostname) : '')
		);
		const name0 =
		(	'mysql://' +
			(!this.#username ? '' : !this.#password ? this.#username+'@' : this.#username+':hidden@') +
			(this.#hostname.indexOf(':')==-1 ? this.#hostname : '['+this.#hostname+']') +
			(this.#port==3306 ? '' : ':'+this.#port) +
			this.#pipe +
			'/'
		);
		const name1 = (!params ? '' : '?'+params.slice(1)) + (!this.#initSql ? '' : '#'+encodeURIComponent(this.#initSql));
		const name = name0 + this.#schema + name1;
		this.#name = name;
		this.#hash = crc32(name);
		this.#hashNoSchema = crc32(name0 + name1);
	}

	toString()
	{	return this.#name;
	}
}
