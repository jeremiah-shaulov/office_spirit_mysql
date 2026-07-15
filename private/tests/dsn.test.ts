import {Dsn} from '../dsn.ts';
import {assertEquals} from 'jsr:@std/assert@1.0.19/equals';

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test
(	'Basic',
	() =>
	{	let error: Any;
		try
		{	new Dsn('http://example.com/');
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'Protocol not supported: http://example.com/');

		error = undefined;
		try
		{	new Dsn('Hello all');
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'Protocol not supported: Hello all');

		let dsnName = 'mysql://[::1]:3307';
		let dsn = new Dsn(dsnName);
		assertEquals(dsn.hostname, '::1');
		assertEquals(dsn.port, 3307);
		assertEquals(dsn.username, '');
		assertEquals(dsn.password, '');
		assertEquals(dsn.schema, '');
		assertEquals(dsn.pipe, '');
		assertEquals(isNaN(dsn.connectionTimeout), true);
		assertEquals(isNaN(dsn.reconnectInterval), true);
		assertEquals(isNaN(dsn.keepAliveTimeout), true);
		assertEquals(isNaN(dsn.keepAliveMax), true);
		assertEquals(isNaN(dsn.maxColumnLen), true);
		assertEquals(dsn.foundRows, false);
		assertEquals(dsn.ignoreSpace, false);
		assertEquals(dsn.multiStatements, false);
		assertEquals(isNaN(dsn.retryQueryTimes), true);
		assertEquals(dsn.initSql, '');
		assertEquals(dsn+'', 'mysql://[::1]:3307/');
		assertEquals(dsn.addr, {transport: 'tcp', hostname: '::1', port: 3307});

		dsnName = 'mysql://johnny@[::1]/?connectionTimeout=123&reconnectInterval=234&keepAliveTimeout=345&retryQueryTimes=456#SET group_concat_max_len=65000';
		dsn = new Dsn(dsnName);
		assertEquals(dsn.hostname, '::1');
		assertEquals(dsn.port, 3306);
		assertEquals(dsn.username, 'johnny');
		assertEquals(dsn.password, '');
		assertEquals(dsn.schema, '');
		assertEquals(dsn.pipe, '');
		assertEquals(dsn.connectionTimeout, 123);
		assertEquals(dsn.reconnectInterval, 234);
		assertEquals(dsn.keepAliveTimeout, 345);
		assertEquals(isNaN(dsn.keepAliveMax), true);
		assertEquals(isNaN(dsn.maxColumnLen), true);
		assertEquals(dsn.foundRows, false);
		assertEquals(dsn.ignoreSpace, false);
		assertEquals(dsn.multiStatements, false);
		assertEquals(dsn.retryQueryTimes, 456);
		assertEquals(dsn.initSql, 'SET group_concat_max_len=65000');
		assertEquals(dsn+'', 'mysql://johnny@[::1]/?connectionTimeout=123&reconnectInterval=234&keepAliveTimeout=345&retryQueryTimes=456#'+encodeURIComponent('SET group_concat_max_len=65000'));
		assertEquals(dsn.addr, {transport: 'tcp', hostname: '::1', port: 3306});

		dsnName = 'mysql://johnny:hello@localhost/information_schema?connectionTimeout=-123&reconnectInterval=-234&keepAliveTimeout=-345&retryQueryTimes=-456#SET group_concat_max_len=65000';
		dsn = new Dsn(dsnName);
		assertEquals(dsn.hostname, 'localhost');
		assertEquals(dsn.port, 3306);
		assertEquals(dsn.username, 'johnny');
		assertEquals(dsn.password, 'hello');
		assertEquals(dsn.schema, 'information_schema');
		assertEquals(dsn.pipe, '');
		assertEquals(dsn.connectionTimeout, 0);
		assertEquals(dsn.reconnectInterval, 0);
		assertEquals(dsn.keepAliveTimeout, 0);
		assertEquals(isNaN(dsn.keepAliveMax), true);
		assertEquals(isNaN(dsn.maxColumnLen), true);
		assertEquals(dsn.foundRows, false);
		assertEquals(dsn.ignoreSpace, false);
		assertEquals(dsn.multiStatements, false);
		assertEquals(dsn.retryQueryTimes, 0);
		assertEquals(dsn.initSql, 'SET group_concat_max_len=65000');
		assertEquals(dsn+'', 'mysql://johnny:hidden@localhost/information_schema?connectionTimeout=0&reconnectInterval=0&keepAliveTimeout=0&retryQueryTimes=0#'+encodeURIComponent('SET group_concat_max_len=65000'));
		assertEquals(dsn.addr, {transport: 'tcp', hostname: 'localhost', port: 3306});

		dsnName = 'mysql://johnny:hello@localhost/information_schema?connectionTimeout=0&keepAliveMax=1234.1&maxColumnLen=1000&foundRows&ignoreSpace# SET group_concat_max_len=65000  ';
		dsn = new Dsn(dsnName);
		assertEquals(dsn.hostname, 'localhost');
		assertEquals(dsn.port, 3306);
		assertEquals(dsn.username, 'johnny');
		assertEquals(dsn.password, 'hello');
		assertEquals(dsn.schema, 'information_schema');
		assertEquals(dsn.pipe, '');
		assertEquals(dsn.connectionTimeout, 0);
		assertEquals(isNaN(dsn.reconnectInterval), true);
		assertEquals(isNaN(dsn.keepAliveTimeout), true);
		assertEquals(dsn.keepAliveMax, 1234);
		assertEquals(dsn.maxColumnLen, 1000);
		assertEquals(dsn.foundRows, true);
		assertEquals(dsn.ignoreSpace, true);
		assertEquals(dsn.multiStatements, false);
		assertEquals(isNaN(dsn.retryQueryTimes), true);
		assertEquals(dsn.initSql, 'SET group_concat_max_len=65000');
		assertEquals(dsn+'', 'mysql://johnny:hidden@localhost/information_schema?connectionTimeout=0&keepAliveMax=1234&maxColumnLen=1000&foundRows&ignoreSpace#'+encodeURIComponent('SET group_concat_max_len=65000'));
		assertEquals(dsn.addr, {transport: 'tcp', hostname: 'localhost', port: 3306});

		dsnName = 'mysql://johnny:hello@www.example.com:22/var/run/my.sock/information_schema?multiStatements';
		dsn = new Dsn(dsnName);
		assertEquals(dsn.hostname, 'www.example.com');
		assertEquals(dsn.port, 22);
		assertEquals(dsn.username, 'johnny');
		assertEquals(dsn.password, 'hello');
		assertEquals(dsn.schema, 'information_schema');
		assertEquals(dsn.pipe, '/var/run/my.sock');
		assertEquals(isNaN(dsn.connectionTimeout), true);
		assertEquals(isNaN(dsn.reconnectInterval), true);
		assertEquals(isNaN(dsn.keepAliveTimeout), true);
		assertEquals(isNaN(dsn.keepAliveMax), true);
		assertEquals(isNaN(dsn.maxColumnLen), true);
		assertEquals(dsn.foundRows, false);
		assertEquals(dsn.ignoreSpace, false);
		assertEquals(dsn.multiStatements, true);
		assertEquals(isNaN(dsn.retryQueryTimes), true);
		assertEquals(dsn.initSql, '');
		assertEquals(dsn+'', 'mysql://johnny:hidden@www.example.com:22/var/run/my.sock/information_schema?multiStatements');
		assertEquals(dsn.addr, {transport: 'unix', path: '/var/run/my.sock'});

		dsn.hostname = '[::1:2:3]';
		assertEquals(dsn.hostname, '::1:2:3');
		assertEquals(dsn+'', 'mysql://johnny:hidden@[::1:2:3]:22/var/run/my.sock/information_schema?multiStatements');

		dsn.port = 23;
		assertEquals(dsn.port, 23);
		assertEquals(dsn+'', 'mysql://johnny:hidden@[::1:2:3]:23/var/run/my.sock/information_schema?multiStatements');
		dsn.port = 0;
		assertEquals(dsn.port, 3306);
		assertEquals(dsn+'', 'mysql://johnny:hidden@[::1:2:3]/var/run/my.sock/information_schema?multiStatements');
		dsn.port = 3305;
		assertEquals(dsn.port, 3305);
		assertEquals(dsn+'', 'mysql://johnny:hidden@[::1:2:3]:3305/var/run/my.sock/information_schema?multiStatements');
		dsn.port = 3306;
		assertEquals(dsn.port, 3306);
		assertEquals(dsn+'', 'mysql://johnny:hidden@[::1:2:3]/var/run/my.sock/information_schema?multiStatements');
		dsn.port = 3307;
		assertEquals(dsn.port, 3307);
		assertEquals(dsn+'', 'mysql://johnny:hidden@[::1:2:3]:3307/var/run/my.sock/information_schema?multiStatements');
		dsn.port = -Infinity;
		assertEquals(dsn.port, 3306);
		assertEquals(dsn+'', 'mysql://johnny:hidden@[::1:2:3]/var/run/my.sock/information_schema?multiStatements');
		dsn = new Dsn('mysql://johnny:hello@[::1:2:3]:0/var/run/my.sock/information_schema?multiStatements');
		assertEquals(dsn.port, 3306);
		assertEquals(dsn+'', 'mysql://johnny:hidden@[::1:2:3]/var/run/my.sock/information_schema?multiStatements');

		dsn.username = 'johnny';
		assertEquals(dsn.username, 'johnny');
		assertEquals(dsn+'', 'mysql://johnny:hidden@[::1:2:3]/var/run/my.sock/information_schema?multiStatements');
		dsn.username = '';
		assertEquals(dsn.username, '');
		assertEquals(dsn+'', 'mysql://[::1:2:3]/var/run/my.sock/information_schema?multiStatements');

		dsn.username = 'root';
		assertEquals(dsn.username, 'root');
		assertEquals(dsn.password, 'hello');
		assertEquals(dsn+'', 'mysql://root:hidden@[::1:2:3]/var/run/my.sock/information_schema?multiStatements');
		dsn.password = '';
		assertEquals(dsn.password, '');
		assertEquals(dsn+'', 'mysql://root@[::1:2:3]/var/run/my.sock/information_schema?multiStatements');

		dsn.schema = 'app';
		assertEquals(dsn.schema, 'app');
		assertEquals(dsn+'', 'mysql://root@[::1:2:3]/var/run/my.sock/app?multiStatements');
		dsn.schema = '';
		assertEquals(dsn.schema, '');
		assertEquals(dsn+'', 'mysql://root@[::1:2:3]/var/run/my.sock/?multiStatements');
		dsn = new Dsn('mysql://root@[::1:2:3]/var/run/my.sock/?multiStatements');
		assertEquals(dsn.pipe, '/var/run/my.sock');
		assertEquals(dsn.schema, '');

		dsn.pipe = 'abc';
		assertEquals(dsn.pipe, '/abc');
		assertEquals(dsn+'', 'mysql://root@[::1:2:3]/abc/?multiStatements');
		dsn.schema = 'def';
		assertEquals(dsn.schema, 'def');
		assertEquals(dsn+'', 'mysql://root@[::1:2:3]/abc/def?multiStatements');

		dsn.connectionTimeout = 3;
		assertEquals(dsn.connectionTimeout, 3);
		assertEquals(dsn+'', 'mysql://root@[::1:2:3]/abc/def?connectionTimeout=3&multiStatements');
		dsn.connectionTimeout = -3;
		assertEquals(dsn.connectionTimeout, 0);
		assertEquals(dsn+'', 'mysql://root@[::1:2:3]/abc/def?connectionTimeout=0&multiStatements');
		dsn.connectionTimeout = NaN;
		assertEquals(dsn.connectionTimeout, NaN);
		assertEquals(dsn+'', 'mysql://root@[::1:2:3]/abc/def?multiStatements');

		dsn.reconnectInterval = 3;
		assertEquals(dsn.reconnectInterval, 3);
		assertEquals(dsn+'', 'mysql://root@[::1:2:3]/abc/def?reconnectInterval=3&multiStatements');
		dsn.reconnectInterval = -3;
		assertEquals(dsn.reconnectInterval, 0);
		assertEquals(dsn+'', 'mysql://root@[::1:2:3]/abc/def?reconnectInterval=0&multiStatements');
		dsn.reconnectInterval = NaN;
		assertEquals(dsn.reconnectInterval, NaN);
		assertEquals(dsn+'', 'mysql://root@[::1:2:3]/abc/def?multiStatements');

		dsn.keepAliveTimeout = 3;
		assertEquals(dsn.keepAliveTimeout, 3);
		assertEquals(dsn+'', 'mysql://root@[::1:2:3]/abc/def?keepAliveTimeout=3&multiStatements');
		dsn.keepAliveTimeout = -3;
		assertEquals(dsn.keepAliveTimeout, 0);
		assertEquals(dsn+'', 'mysql://root@[::1:2:3]/abc/def?keepAliveTimeout=0&multiStatements');
		dsn.keepAliveTimeout = NaN;
		assertEquals(dsn.keepAliveTimeout, NaN);
		assertEquals(dsn+'', 'mysql://root@[::1:2:3]/abc/def?multiStatements');

		dsn.keepAliveMax = 3;
		assertEquals(dsn.keepAliveMax, 3);
		assertEquals(dsn+'', 'mysql://root@[::1:2:3]/abc/def?keepAliveMax=3&multiStatements');
		dsn.keepAliveMax = -3;
		assertEquals(dsn.keepAliveMax, 0);
		assertEquals(dsn+'', 'mysql://root@[::1:2:3]/abc/def?keepAliveMax=0&multiStatements');
		dsn.keepAliveMax = NaN;
		assertEquals(dsn.keepAliveMax, NaN);
		assertEquals(dsn+'', 'mysql://root@[::1:2:3]/abc/def?multiStatements');

		dsn.maxColumnLen = 3;
		assertEquals(dsn.maxColumnLen, 3);
		assertEquals(dsn+'', 'mysql://root@[::1:2:3]/abc/def?maxColumnLen=3&multiStatements');
		dsn.maxColumnLen = -3;
		assertEquals(dsn.maxColumnLen, 1);
		assertEquals(dsn+'', 'mysql://root@[::1:2:3]/abc/def?maxColumnLen=1&multiStatements');
		dsn.maxColumnLen = NaN;
		assertEquals(dsn.maxColumnLen, NaN);
		assertEquals(dsn+'', 'mysql://root@[::1:2:3]/abc/def?multiStatements');

		dsn.foundRows = true;
		assertEquals(dsn.foundRows, true);
		assertEquals(dsn+'', 'mysql://root@[::1:2:3]/abc/def?foundRows&multiStatements');
		dsn.foundRows = false;
		assertEquals(dsn.foundRows, false);
		assertEquals(dsn+'', 'mysql://root@[::1:2:3]/abc/def?multiStatements');

		dsn.ignoreSpace = true;
		assertEquals(dsn.ignoreSpace, true);
		assertEquals(dsn+'', 'mysql://root@[::1:2:3]/abc/def?ignoreSpace&multiStatements');
		dsn.ignoreSpace = false;
		assertEquals(dsn.ignoreSpace, false);
		assertEquals(dsn+'', 'mysql://root@[::1:2:3]/abc/def?multiStatements');

		dsn.multiStatements = false;
		assertEquals(dsn.multiStatements, false);
		assertEquals(dsn+'', 'mysql://root@[::1:2:3]/abc/def');
	}
);

Deno.test
(	'allowPublicKeyRetrieval and serverPublicKey',
	() =>
	{	const base64 = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0Zx6vB+sqLm4rF8/w2Qk3Zx6vB+sqLm4rF8/w2QkAQAB==';
		const pem = '-----BEGIN PUBLIC KEY-----\n'+base64.slice(0, 44)+'\n'+base64.slice(44)+'\n-----END PUBLIC KEY-----\n';

		let dsn = new Dsn('mysql://root@localhost/?allowPublicKeyRetrieval');
		assertEquals(dsn.allowPublicKeyRetrieval, true);
		assertEquals(dsn.serverPublicKey, '');
		assertEquals(dsn+'', 'mysql://root@localhost/?allowPublicKeyRetrieval');
		dsn.allowPublicKeyRetrieval = false;
		assertEquals(dsn.allowPublicKeyRetrieval, false);
		assertEquals(dsn+'', 'mysql://root@localhost/');

		// Percent-encoded PEM in the URL: the armor and whitespace are stripped
		dsn = new Dsn('mysql://root@localhost/?serverPublicKey='+encodeURIComponent(pem));
		assertEquals(dsn.allowPublicKeyRetrieval, false);
		assertEquals(dsn.serverPublicKey, base64);
		assertEquals(dsn+'', 'mysql://root@localhost/?serverPublicKey='+encodeURIComponent(base64));
		assertEquals(new Dsn(dsn+'').serverPublicKey, base64); // `name` round-trip

		// Raw (not percent-encoded) base64 in the URL: '+' chars decode to spaces, and the parser must convert them back
		dsn = new Dsn('mysql://root@localhost/?serverPublicKey='+base64);
		assertEquals(dsn.serverPublicKey, base64);

		// Copy-constructor
		dsn.allowPublicKeyRetrieval = true;
		const dsn2 = new Dsn(dsn);
		assertEquals(dsn2.allowPublicKeyRetrieval, true);
		assertEquals(dsn2.serverPublicKey, base64);

		// The setter accepts PEM (also zero-terminated, like MySQL server sends it) and bare base64
		dsn.serverPublicKey = pem+'\0';
		assertEquals(dsn.serverPublicKey, base64);
		dsn.serverPublicKey = base64;
		assertEquals(dsn.serverPublicKey, base64);
		dsn.serverPublicKey = '';
		assertEquals(dsn.serverPublicKey, '');
		assertEquals(dsn+'', 'mysql://root@localhost/?allowPublicKeyRetrieval');
	}
);

Deno.test
(	'tls, tlsCaCert and tlsHostname',
	() =>
	{	// '+' and '/' are legitimate base64 chars, so the PEM must survive percent-encoding round-trip byte-to-byte
		const pem = '-----BEGIN CERTIFICATE-----\nMIIBhTCCASugAwIBAgIQIRi6zePL6mKjOipn+dNuaTAKBggqhkjOPQQDAjASMRAw\nDgYDVQQKEwdBY21lIENvMB4XDTIzMDEwMTAwMDAwMFoXDTI0MDEwMTAwMDAwMFow\nEjEQMA4GA1UEChMHQWNtZSBDbw+/PQ==\n-----END CERTIFICATE-----\n';

		let dsn = new Dsn('mysql://root@localhost/?tls');
		assertEquals(dsn.tls, true);
		assertEquals(dsn.tlsCaCert, '');
		assertEquals(dsn.tlsHostname, '');
		assertEquals(dsn+'', 'mysql://root@localhost/?tls');
		dsn.tls = false;
		assertEquals(dsn.tls, false);
		assertEquals(dsn+'', 'mysql://root@localhost/');

		// Percent-encoded PEM in the URL is preserved byte-to-byte
		dsn = new Dsn('mysql://root@localhost/?tlsCaCert='+encodeURIComponent(pem));
		assertEquals(dsn.tls, true); // `tlsCaCert` enables `tls`
		assertEquals(dsn.tlsCaCert, pem);
		assertEquals(dsn+'', 'mysql://root@localhost/?tls&tlsCaCert='+encodeURIComponent(pem));
		assertEquals(new Dsn(dsn+'').tlsCaCert, pem); // `name` round-trip

		// `tlsHostname` enables `tls` too
		dsn = new Dsn('mysql://root@127.0.0.1/?tlsHostname=db.example.com');
		assertEquals(dsn.tls, true);
		assertEquals(dsn.tlsHostname, 'db.example.com');
		assertEquals(dsn+'', 'mysql://root@127.0.0.1/?tls&tlsHostname=db.example.com');

		// Copy-constructor
		dsn.tlsCaCert = pem;
		const dsn2 = new Dsn(dsn);
		assertEquals(dsn2.tls, true);
		assertEquals(dsn2.tlsCaCert, pem);
		assertEquals(dsn2.tlsHostname, 'db.example.com');

		// The setters also enable `tls`
		dsn = new Dsn('mysql://root@localhost/');
		assertEquals(dsn.tls, false);
		dsn.tlsCaCert = pem;
		assertEquals(dsn.tls, true);
		dsn = new Dsn('mysql://root@localhost/');
		dsn.tlsHostname = 'db.example.com';
		assertEquals(dsn.tls, true);

		// Clearing them doesn't disable `tls` (it was enabled, maybe also explicitly)
		dsn.tlsHostname = '';
		assertEquals(dsn.tls, true);
		dsn.tls = false;
		assertEquals(dsn+'', 'mysql://root@localhost/');
	}
);

Deno.test
(	'compress',
	() =>
	{	let dsn = new Dsn('mysql://root@localhost/?compress');
		assertEquals(dsn.compress, true);
		assertEquals(dsn+'', 'mysql://root@localhost/?compress');
		assertEquals(new Dsn(dsn+'').compress, true); // `name` round-trip

		// Copy-constructor
		const dsn2 = new Dsn(dsn);
		assertEquals(dsn2.compress, true);

		// Setter
		dsn.compress = false;
		assertEquals(dsn.compress, false);
		assertEquals(dsn+'', 'mysql://root@localhost/');
		dsn = new Dsn('mysql://root@localhost/');
		assertEquals(dsn.compress, false);
		dsn.compress = true;
		assertEquals(dsn+'', 'mysql://root@localhost/?compress');
	}
);

Deno.test
(	'Pipe path with non-ASCII bytes is URL-decoded',
	() =>
	{	// User encodes a non-ASCII char (Cyrillic ф = U+0444, UTF-8 = D1 84) in the pipe path. The DSN parser should percent-decode the path bytes the same way it does for username/password — otherwise the resulting `pipe` is a literal `/%D1%84/sock` instead of the intended `/ф/sock`.
		const dsn = new Dsn('mysql://localhost/%D1%84/sock/schema');
		assertEquals(dsn.pipe, '/ф/sock');
		assertEquals(dsn.schema, 'schema');
	}
);
