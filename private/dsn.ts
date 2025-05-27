import {crc32} from "./deps.ts";

const wantUrlDecodeUsername = new URL('http://ф@localhost/').username.charAt(0) == '%';
const wantUrlDecodePassword = new URL('http://u:ф@localhost/').password.charAt(0) == '%';
const wantUrlDecodePathname = new URL('http://localhost/ф').pathname.charAt(0) == '%';

// deno-lint-ignore no-explicit-any
type Any = any;

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
	- {@link datesAsString}
	- {@link correctDates}
	- {@link storeResultsetIfBigger}
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
	#datesAsString: boolean;
	#correctDates: boolean;
	#storeResultsetIfBigger: number;
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

	/**	When using {@link Resultsets.store()} and the resultset is bigger than this number of bytes, it will be stored on disk, rather than in RAM (array).
		@default 64KiB
	 **/
	get storeResultsetIfBigger()
	{	return this.#storeResultsetIfBigger;
	}
	set storeResultsetIfBigger(value: number)
	{	this.#storeResultsetIfBigger = value>=0 ? value : NaN;
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
			this.#datesAsString = dsn.#datesAsString;
			this.#correctDates = dsn.#correctDates;
			this.#storeResultsetIfBigger = dsn.#storeResultsetIfBigger;
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
			const datesAsString = url.searchParams.get('datesAsString');
			const correctDates = url.searchParams.get('correctDates');
			const storeResultsetIfBigger = url.searchParams.get('storeResultsetIfBigger');
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
			this.#datesAsString = datesAsString != null;
			this.#correctDates = correctDates != null;
			this.#storeResultsetIfBigger = storeResultsetIfBigger!=null ? Math.max(0, Number(storeResultsetIfBigger) || 0) : NaN;
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
			(this.#datesAsString ? '&datesAsString' : '') +
			(this.#correctDates ? '&correctDates' : '') +
			(!isNaN(this.#storeResultsetIfBigger) ? '&storeResultsetIfBigger='+this.#storeResultsetIfBigger : '')
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
