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
{	private m_hostname: string;
	private m_port: number;
	private m_username: string;
	private m_password: string;
	private m_schema: string;
	private m_pipe: string;
	private m_keep_alive_timeout: number;
	private m_keep_alive_max: number;
	private m_max_column_len: number;
	/** Use "found rows" instead of "affected rows" */
	private m_found_rows: boolean;
	/** Parser on server can ignore spaces before '(' in built-in function names */
	private m_ignore_space: boolean;
	/** SQL can contain multiple statements separated with ';', so you can upload dumps, but SQL injection attacks become more risky */
	private m_multi_statements: boolean;
	private m_init_sql: string;
	private m_name: string;

	get hostname()
	{	return this.m_hostname;
	}
	set hostname(value: string)
	{	if (value.charAt(0)=='[' && value.slice(-1)==']') // IPv6, like [::1]:3306
		{	value = value.slice(1, -1);
		}
		this.m_hostname = value;
		this.update_name();
	}

	get port()
	{	return this.m_port;
	}
	set port(value: number)
	{	this.m_port = !value || !isFinite(value) ? 3306 : value;
		this.update_name();
	}

	get username()
	{	return this.m_username;
	}
	set username(value: string)
	{	this.m_username = value;
		this.update_name();
	}

	get password()
	{	return this.m_password;
	}
	set password(value: string)
	{	this.m_password = value;
		this.update_name();
	}

	get schema()
	{	return this.m_schema;
	}
	set schema(value: string)
	{	this.m_schema = value;
		this.update_name();
	}

	get pipe()
	{	return this.m_pipe;
	}
	set pipe(value: string)
	{	if (value.length>0 && value.charAt(0)!='/')
		{	value = '/'+value;
		}
		this.m_pipe = value;
		this.update_name();
	}

	get keepAliveTimeout()
	{	return this.m_keep_alive_timeout;
	}
	set keepAliveTimeout(value: number)
	{	this.m_keep_alive_timeout = Math.max(0, value);
		this.update_name();
	}

	get keepAliveMax()
	{	return this.m_keep_alive_max;
	}
	set keepAliveMax(value: number)
	{	this.m_keep_alive_max = Math.max(0, value);
		this.update_name();
	}

	get maxColumnLen()
	{	return this.m_max_column_len;
	}
	set maxColumnLen(value: number)
	{	this.m_max_column_len = Math.max(1, value);
		this.update_name();
	}

	get foundRows()
	{	return this.m_found_rows;
	}
	set foundRows(value: boolean)
	{	this.m_found_rows = value;
		this.update_name();
	}

	get ignoreSpace()
	{	return this.m_ignore_space;
	}
	set ignoreSpace(value: boolean)
	{	this.m_ignore_space = value;
		this.update_name();
	}

	get multiStatements()
	{	return this.m_multi_statements;
	}
	set multiStatements(value: boolean)
	{	this.m_multi_statements = value;
		this.update_name();
	}

	get initSql()
	{	return this.m_init_sql;
	}
	set initSql(value: string)
	{	this.m_init_sql = value;
		this.update_name();
	}

	get name()
	{	return this.m_name;
	}

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
		this.m_hostname = hostname;
		this.m_port = !url.port ? 3306 : Number(url.port) || 3306;
		this.m_username = username;
		this.m_password = password;
		pos = pathname.lastIndexOf('/');
		this.m_pipe = pathname.slice(0, pos);
		this.m_schema = pathname.slice(pos + 1);
		// params
		let keep_alive_timeout = url.searchParams.get('keepAliveTimeout');
		let keep_alive_max = url.searchParams.get('keepAliveMax');
		let maxColumnLen = url.searchParams.get('maxColumnLen');
		let found_rows = url.searchParams.get('foundRows');
		let ignore_space = url.searchParams.get('ignoreSpace');
		let multi_statements = url.searchParams.get('multiStatements');
		this.m_keep_alive_timeout = keep_alive_timeout ? Math.max(0, Number(keep_alive_timeout)) : NaN;
		this.m_keep_alive_max = keep_alive_max ? Math.max(0, Math.round(Number(keep_alive_max))) : NaN;
		this.m_max_column_len = maxColumnLen ? Math.max(1, Number(maxColumnLen)) : NaN;
		this.m_found_rows = found_rows != null;
		this.m_ignore_space = ignore_space != null;
		this.m_multi_statements = multi_statements != null;
		// initSql
		this.m_init_sql = decodeURIComponent(url.hash.slice(1)).trim();
		this.m_name = '';
		this.update_name();
	}

	/**	Normalized name.
	 **/
	private update_name()
	{	let params =
		(	(!isNaN(this.m_keep_alive_timeout) ? '&keepAliveTimeout='+this.m_keep_alive_timeout : '') +
			(!isNaN(this.m_keep_alive_max) ? '&keepAliveMax='+this.m_keep_alive_max : '') +
			(!isNaN(this.m_max_column_len) ? '&maxColumnLen='+this.m_max_column_len : '') +
			(this.m_found_rows ? '&foundRows' : '') +
			(this.m_ignore_space ? '&ignoreSpace' : '') +
			(this.m_multi_statements ? '&multiStatements' : '')
		);
		this.m_name =
		(	'mysql://' +
			(!this.m_username ? '' : !this.m_password ? this.m_username+'@' : this.m_username+':'+this.m_password+'@') +
			(this.m_hostname.indexOf(':')==-1 ? this.m_hostname : '['+this.m_hostname+']') +
			(this.m_port==3306 ? '' : ':'+this.m_port) +
			this.m_pipe +
			'/' + this.m_schema +
			(!params ? '' : '?'+params.slice(1)) +
			(!this.m_init_sql ? '' : '#'+encodeURIComponent(this.m_init_sql))
		);
	}

	get addr(): Deno.ConnectOptions | Deno.UnixConnectOptions
	{	if (this.m_pipe)
		{	return {transport: 'unix', path: this.m_pipe};
		}
		else
		{	return {transport: 'tcp', hostname: this.m_hostname, port: this.m_port};
		}
	}

	toString()
	{	return this.m_name;
	}
}
