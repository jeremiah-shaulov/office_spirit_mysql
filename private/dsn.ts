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
	`connectionTimeout` (number) milliseconds - will try to reconnect this amount of time;
	`keepAliveTimeout` (number) milliseconds - each connection will persist for this period of time, before termination, so it can be reused when someone else asks for the same connection;
	`keepAliveMax` (number) - how many times at most to recycle each connection;
	`maxColumnLen` (number) bytes - if a column was longer, it's value is skipped, and it will be returned as NULL;
	`foundRows` (boolean) - if present, will use "found rows" instead of "affected rows" in resultsets;
	`ignoreSpace` (boolean) - if present, parser on server side can ignore spaces before '(' in built-in function names;
	`multiStatements` (boolean) - if present, SQL can contain multiple statements separated with ';', so you can upload dumps, but SQL injection attacks become more risky;
 **/
export class Dsn
{	#hostname: string;
	#port: number;
	#username: string;
	#password: string;
	#schema: string;
	#pipe: string;
	#connectionTimeout: number;
	#keepAliveTimeout: number;
	#keepAliveMax: number;
	#maxColumnLen: number;
	/** Use "found rows" instead of "affected rows" */
	#foundRows: boolean;
	/** Parser on server can ignore spaces before '(' in built-in function names */
	#ignoreSpace: boolean;
	/** SQL can contain multiple statements separated with ';', so you can upload dumps, but SQL injection attacks become more risky */
	#multiStatements: boolean;
	#initSql: string;
	#name: string;

	get hostname()
	{	return this.#hostname;
	}
	set hostname(value: string)
	{	if (value.charAt(0)=='[' && value.slice(-1)==']') // IPv6, like [::1]:3306
		{	value = value.slice(1, -1);
		}
		this.#hostname = value;
		this.updateName();
	}

	get port()
	{	return this.#port;
	}
	set port(value: number)
	{	this.#port = !value || !isFinite(value) ? 3306 : value;
		this.updateName();
	}

	get username()
	{	return this.#username;
	}
	set username(value: string)
	{	this.#username = value;
		this.updateName();
	}

	get password()
	{	return this.#password;
	}
	set password(value: string)
	{	this.#password = value;
		this.updateName();
	}

	get schema()
	{	return this.#schema;
	}
	set schema(value: string)
	{	this.#schema = value;
		this.updateName();
	}

	get pipe()
	{	return this.#pipe;
	}
	set pipe(value: string)
	{	if (value.length>0 && value.charAt(0)!='/')
		{	value = '/'+value;
		}
		this.#pipe = value;
		this.updateName();
	}

	get connectionTimeout()
	{	return this.#connectionTimeout;
	}
	set connectionTimeout(value: number)
	{	this.#connectionTimeout = Math.max(0, value);
		this.updateName();
	}

	get keepAliveTimeout()
	{	return this.#keepAliveTimeout;
	}
	set keepAliveTimeout(value: number)
	{	this.#keepAliveTimeout = Math.max(0, value);
		this.updateName();
	}

	get keepAliveMax()
	{	return this.#keepAliveMax;
	}
	set keepAliveMax(value: number)
	{	this.#keepAliveMax = Math.max(0, value);
		this.updateName();
	}

	get maxColumnLen()
	{	return this.#maxColumnLen;
	}
	set maxColumnLen(value: number)
	{	this.#maxColumnLen = Math.max(1, value);
		this.updateName();
	}

	get foundRows()
	{	return this.#foundRows;
	}
	set foundRows(value: boolean)
	{	this.#foundRows = value;
		this.updateName();
	}

	get ignoreSpace()
	{	return this.#ignoreSpace;
	}
	set ignoreSpace(value: boolean)
	{	this.#ignoreSpace = value;
		this.updateName();
	}

	get multiStatements()
	{	return this.#multiStatements;
	}
	set multiStatements(value: boolean)
	{	this.#multiStatements = value;
		this.updateName();
	}

	get initSql()
	{	return this.#initSql;
	}
	set initSql(value: string)
	{	this.#initSql = value;
		this.updateName();
	}

	get name()
	{	return this.#name;
	}

	constructor(dsn: string)
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
		const keepAliveTimeout = url.searchParams.get('keepAliveTimeout');
		const keepAliveMax = url.searchParams.get('keepAliveMax');
		const maxColumnLen = url.searchParams.get('maxColumnLen');
		const foundRows = url.searchParams.get('foundRows');
		const ignoreSpace = url.searchParams.get('ignoreSpace');
		const multiStatements = url.searchParams.get('multiStatements');
		this.#connectionTimeout = connectionTimeout ? Math.max(0, Number(connectionTimeout)) : NaN;
		this.#keepAliveTimeout = keepAliveTimeout ? Math.max(0, Number(keepAliveTimeout)) : NaN;
		this.#keepAliveMax = keepAliveMax ? Math.max(0, Math.round(Number(keepAliveMax))) : NaN;
		this.#maxColumnLen = maxColumnLen ? Math.max(1, Number(maxColumnLen)) : NaN;
		this.#foundRows = foundRows != null;
		this.#ignoreSpace = ignoreSpace != null;
		this.#multiStatements = multiStatements != null;
		// initSql
		this.#initSql = decodeURIComponent(url.hash.slice(1)).trim();
		this.#name = '';
		this.updateName();
	}

	/**	Normalized name.
	 **/
	private updateName()
	{	const params =
		(	(!isNaN(this.#connectionTimeout) ? '&connectionTimeout='+this.#connectionTimeout : '') +
			(!isNaN(this.#keepAliveTimeout) ? '&keepAliveTimeout='+this.#keepAliveTimeout : '') +
			(!isNaN(this.#keepAliveMax) ? '&keepAliveMax='+this.#keepAliveMax : '') +
			(!isNaN(this.#maxColumnLen) ? '&maxColumnLen='+this.#maxColumnLen : '') +
			(this.#foundRows ? '&foundRows' : '') +
			(this.#ignoreSpace ? '&ignoreSpace' : '') +
			(this.#multiStatements ? '&multiStatements' : '')
		);
		this.#name =
		(	'mysql://' +
			(!this.#username ? '' : !this.#password ? this.#username+'@' : this.#username+':'+this.#password+'@') +
			(this.#hostname.indexOf(':')==-1 ? this.#hostname : '['+this.#hostname+']') +
			(this.#port==3306 ? '' : ':'+this.#port) +
			this.#pipe +
			'/' + this.#schema +
			(!params ? '' : '?'+params.slice(1)) +
			(!this.#initSql ? '' : '#'+encodeURIComponent(this.#initSql))
		);
	}

	get addr(): Deno.ConnectOptions | {transport: 'unix', path: string}
	{	if (this.#pipe)
		{	return {transport: 'unix', path: this.#pipe} as Any; // "as any" in order to avoid requireing --unstable
		}
		else
		{	return {transport: 'tcp', hostname: this.#hostname, port: this.#port};
		}
	}

	toString()
	{	return this.#name;
	}
}
