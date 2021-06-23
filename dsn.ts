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
{	name: string;
	hostname: string;
	port: number;
	username: string;
	password: string;
	schema: string;
	pipe: string;
	keepAliveTimeout: number;
	keepAliveMax: number;
	maxColumnLen: number;
	/** Use "found rows" instead of "affected rows" */
	foundRows: boolean;
	/** Parser on server can ignore spaces before '(' in built-in function names */
	ignoreSpace: boolean;
	/** SQL can contain multiple statements separated with ';', so you can upload dumps, but SQL injection attacks become more risky */
	multiStatements: boolean;
	initSql: string;

	constructor(dsn: string)
	{	let pos = dsn.indexOf(':');
		if (pos!=5 || dsn.slice(0, pos).toLowerCase()!='mysql')
		{	throw new Error(`Protocol not supported: ${dsn}`);
		}
		let url = new URL('http'+dsn.slice(5));
		let {hostname, username, password, pathname} = url;
		if (hostname.charAt(0)=='[' && hostname.slice(-1)==']') // IPv6, like [::1]:3306
		{	hostname = hostname.slice(1, -1);
		}
		this.hostname = hostname;
		this.port = !url.port ? 3306 : Number(url.port);
		this.username = username;
		this.password = password;
		pos = pathname.lastIndexOf('/');
		this.pipe = pathname.slice(0, pos);
		this.schema = pathname.slice(pos + 1);
		// params
		let keepAliveTimeout = url.searchParams.get('keepAliveTimeout');
		let keepAliveMax = url.searchParams.get('keepAliveMax');
		let maxColumnLen = url.searchParams.get('maxColumnLen');
		let foundRows = url.searchParams.get('foundRows');
		let ignoreSpace = url.searchParams.get('ignoreSpace');
		let multiStatements = url.searchParams.get('multiStatements');
		this.keepAliveTimeout = keepAliveTimeout ? Math.max(0, Number(keepAliveTimeout)) : NaN;
		this.keepAliveMax = keepAliveMax ? Math.max(0, Math.round(Number(keepAliveMax))) : NaN;
		this.maxColumnLen = maxColumnLen ? Math.max(1, Number(maxColumnLen)) : NaN;
		this.foundRows = foundRows != null;
		this.ignoreSpace = ignoreSpace != null;
		this.multiStatements = multiStatements != null;
		// initSql
		this.initSql = decodeURIComponent(url.hash.slice(1)).trim();
		// normalized name
		let params =
		(	(!isNaN(this.keepAliveTimeout) ? '&keepAliveTimeout='+this.keepAliveTimeout : '') +
			(!isNaN(this.keepAliveMax) ? '&keepAliveMax='+this.keepAliveMax : '') +
			(!isNaN(this.maxColumnLen) ? '&maxColumnLen='+this.maxColumnLen : '') +
			(this.foundRows ? '&foundRows' : '') +
			(this.ignoreSpace ? '&ignoreSpace' : '') +
			(this.multiStatements ? '&multiStatements' : '')
		);
		this.name = 'mysql://' + (!username ? '' : !password ? username+'@' : username+':'+password+'@') + url.host + pathname + (!params ? '' : '?'+params.slice(1)) + (!this.initSql ? '' : '#'+encodeURIComponent(this.initSql));
	}

	get addr(): Deno.ConnectOptions | Deno.UnixConnectOptions
	{	if (this.pipe)
		{	return {transport: 'unix', path: this.pipe};
		}
		else
		{	return {transport: 'tcp', hostname: this.hostname, port: this.port};
		}
	}

	toString()
	{	return this.name;
	}
}
