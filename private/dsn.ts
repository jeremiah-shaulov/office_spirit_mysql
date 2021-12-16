const wantUrlDecodeUsername = new URL('http://ф@localhost/').username.charAt(0) == '%';
const wantUrlDecodePassword = new URL('http://u:ф@localhost/').password.charAt(0) == '%';

/** Data source name. URL string that specifies how to connect to MySQL server.
	Format: `mysql://user:password@host:port/schema?param1=value1&param2=value2#INITIAL_SQL`.
	Or: `mysql://user:password@localhost/path/to/named.pipe/schema`.
	Example: `mysql://root@localhost/` or `mysql://root:hello@[::1]/?keepAliveTimeout=10000&foundRows`.
	Possible parameters:
	`keepAliveTimeout` (number) milliseconds - each connection will persist for this period of time, before termination, so it can be reused when someone else asks for the same connection;
	`keepAliveMax` (number) - how many times at most to recycle each connection;
	`maxColumnLen` (number) bytes - if a column was longer, it's value is skipped, and it will be returned as NULL;
	`foundRows` (boolean) - if present, will use "found rows" instead of "affected rows" in resultsets;
	`ignoreSpace` (boolean) - if present, parser on server side can ignore spaces before '(' in built-in function names;
	`multiStatements` (boolean) - if present, SQL can contain multiple statements separated with ';', so you can upload dumps, but SQL injection attacks become more risky;
 **/
export class Dsn
{	private mHostname: string;
	private mPort: number;
	private mUsername: string;
	private mPassword: string;
	private mSchema: string;
	private mPipe: string;
	private mKeepAliveTimeout: number;
	private mKeepAliveMax: number;
	private mMaxColumnLen: number;
	/** Use "found rows" instead of "affected rows" */
	private mFoundRows: boolean;
	/** Parser on server can ignore spaces before '(' in built-in function names */
	private mIgnoreSpace: boolean;
	/** SQL can contain multiple statements separated with ';', so you can upload dumps, but SQL injection attacks become more risky */
	private mMultiStatements: boolean;
	private mInitSql: string;
	private mName: string;

	get hostname()
	{	return this.mHostname;
	}
	set hostname(value: string)
	{	if (value.charAt(0)=='[' && value.slice(-1)==']') // IPv6, like [::1]:3306
		{	value = value.slice(1, -1);
		}
		this.mHostname = value;
		this.updateName();
	}

	get port()
	{	return this.mPort;
	}
	set port(value: number)
	{	this.mPort = !value || !isFinite(value) ? 3306 : value;
		this.updateName();
	}

	get username()
	{	return this.mUsername;
	}
	set username(value: string)
	{	this.mUsername = value;
		this.updateName();
	}

	get password()
	{	return this.mPassword;
	}
	set password(value: string)
	{	this.mPassword = value;
		this.updateName();
	}

	get schema()
	{	return this.mSchema;
	}
	set schema(value: string)
	{	this.mSchema = value;
		this.updateName();
	}

	get pipe()
	{	return this.mPipe;
	}
	set pipe(value: string)
	{	if (value.length>0 && value.charAt(0)!='/')
		{	value = '/'+value;
		}
		this.mPipe = value;
		this.updateName();
	}

	get keepAliveTimeout()
	{	return this.mKeepAliveTimeout;
	}
	set keepAliveTimeout(value: number)
	{	this.mKeepAliveTimeout = Math.max(0, value);
		this.updateName();
	}

	get keepAliveMax()
	{	return this.mKeepAliveMax;
	}
	set keepAliveMax(value: number)
	{	this.mKeepAliveMax = Math.max(0, value);
		this.updateName();
	}

	get maxColumnLen()
	{	return this.mMaxColumnLen;
	}
	set maxColumnLen(value: number)
	{	this.mMaxColumnLen = Math.max(1, value);
		this.updateName();
	}

	get foundRows()
	{	return this.mFoundRows;
	}
	set foundRows(value: boolean)
	{	this.mFoundRows = value;
		this.updateName();
	}

	get ignoreSpace()
	{	return this.mIgnoreSpace;
	}
	set ignoreSpace(value: boolean)
	{	this.mIgnoreSpace = value;
		this.updateName();
	}

	get multiStatements()
	{	return this.mMultiStatements;
	}
	set multiStatements(value: boolean)
	{	this.mMultiStatements = value;
		this.updateName();
	}

	get initSql()
	{	return this.mInitSql;
	}
	set initSql(value: string)
	{	this.mInitSql = value;
		this.updateName();
	}

	get name()
	{	return this.mName;
	}

	constructor(dsn: string)
	{	let pos = dsn.indexOf(':');
		if (pos!=5 || dsn.slice(0, pos).toLowerCase()!='mysql')
		{	throw new Error(`Protocol not supported: ${dsn}`);
		}
		const url = new URL('http'+dsn.slice(5));
		let {hostname, username, password, pathname} = url;
		if (hostname.charAt(0)=='[' && hostname.slice(-1)==']') // IPv6, like [::1]:3306
		{	hostname = hostname.slice(1, -1);
		}
		this.mHostname = hostname;
		this.mPort = !url.port ? 3306 : Number(url.port) || 3306;
		this.mUsername = wantUrlDecodeUsername ? decodeURIComponent(username) : username;
		this.mPassword = wantUrlDecodePassword ? decodeURIComponent(password) : password;
		pos = pathname.lastIndexOf('/');
		this.mPipe = pathname.slice(0, pos);
		this.mSchema = pathname.slice(pos + 1);
		// params
		const keepAliveTimeout = url.searchParams.get('keepAliveTimeout');
		const keepAliveMax = url.searchParams.get('keepAliveMax');
		const maxColumnLen = url.searchParams.get('maxColumnLen');
		const foundRows = url.searchParams.get('foundRows');
		const ignoreSpace = url.searchParams.get('ignoreSpace');
		const multiStatements = url.searchParams.get('multiStatements');
		this.mKeepAliveTimeout = keepAliveTimeout ? Math.max(0, Number(keepAliveTimeout)) : NaN;
		this.mKeepAliveMax = keepAliveMax ? Math.max(0, Math.round(Number(keepAliveMax))) : NaN;
		this.mMaxColumnLen = maxColumnLen ? Math.max(1, Number(maxColumnLen)) : NaN;
		this.mFoundRows = foundRows != null;
		this.mIgnoreSpace = ignoreSpace != null;
		this.mMultiStatements = multiStatements != null;
		// initSql
		this.mInitSql = decodeURIComponent(url.hash.slice(1)).trim();
		this.mName = '';
		this.updateName();
	}

	/**	Normalized name.
	 **/
	private updateName()
	{	const params =
		(	(!isNaN(this.mKeepAliveTimeout) ? '&keepAliveTimeout='+this.mKeepAliveTimeout : '') +
			(!isNaN(this.mKeepAliveMax) ? '&keepAliveMax='+this.mKeepAliveMax : '') +
			(!isNaN(this.mMaxColumnLen) ? '&maxColumnLen='+this.mMaxColumnLen : '') +
			(this.mFoundRows ? '&foundRows' : '') +
			(this.mIgnoreSpace ? '&ignoreSpace' : '') +
			(this.mMultiStatements ? '&multiStatements' : '')
		);
		this.mName =
		(	'mysql://' +
			(!this.mUsername ? '' : !this.mPassword ? this.mUsername+'@' : this.mUsername+':'+this.mPassword+'@') +
			(this.mHostname.indexOf(':')==-1 ? this.mHostname : '['+this.mHostname+']') +
			(this.mPort==3306 ? '' : ':'+this.mPort) +
			this.mPipe +
			'/' + this.mSchema +
			(!params ? '' : '?'+params.slice(1)) +
			(!this.mInitSql ? '' : '#'+encodeURIComponent(this.mInitSql))
		);
	}

	get addr(): Deno.ConnectOptions | Deno.UnixConnectOptions
	{	if (this.mPipe)
		{	return {transport: 'unix', path: this.mPipe};
		}
		else
		{	return {transport: 'tcp', hostname: this.mHostname, port: this.mPort};
		}
	}

	toString()
	{	return this.mName;
	}
}
