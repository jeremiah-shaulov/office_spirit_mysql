import {Dsn} from '../dsn.ts';
import {assertEquals} from "https://deno.land/std@0.117.0/testing/asserts.ts";

Deno.test
(	'Basic',
	() =>
	{	let error;
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
		assertEquals(dsn+'', 'mysql://johnny:hello@localhost/information_schema?connectionTimeout=0&reconnectInterval=0&keepAliveTimeout=0&retryQueryTimes=0#'+encodeURIComponent('SET group_concat_max_len=65000'));
		assertEquals(dsn.addr, {transport: 'tcp', hostname: 'localhost', port: 3306});

		dsnName = 'mysql://johnny:hello@localhost/information_schema?keepAliveMax=1234.1&maxColumnLen=1000&foundRows&ignoreSpace# SET group_concat_max_len=65000  ';
		dsn = new Dsn(dsnName);
		assertEquals(dsn.hostname, 'localhost');
		assertEquals(dsn.port, 3306);
		assertEquals(dsn.username, 'johnny');
		assertEquals(dsn.password, 'hello');
		assertEquals(dsn.schema, 'information_schema');
		assertEquals(dsn.pipe, '');
		assertEquals(isNaN(dsn.connectionTimeout), true);
		assertEquals(isNaN(dsn.reconnectInterval), true);
		assertEquals(isNaN(dsn.keepAliveTimeout), true);
		assertEquals(dsn.keepAliveMax, 1234);
		assertEquals(dsn.maxColumnLen, 1000);
		assertEquals(dsn.foundRows, true);
		assertEquals(dsn.ignoreSpace, true);
		assertEquals(dsn.multiStatements, false);
		assertEquals(isNaN(dsn.retryQueryTimes), true);
		assertEquals(dsn.initSql, 'SET group_concat_max_len=65000');
		assertEquals(dsn+'', 'mysql://johnny:hello@localhost/information_schema?keepAliveMax=1234&maxColumnLen=1000&foundRows&ignoreSpace#'+encodeURIComponent('SET group_concat_max_len=65000'));
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
		assertEquals(dsn+'', 'mysql://johnny:hello@www.example.com:22/var/run/my.sock/information_schema?multiStatements');
		assertEquals(dsn.addr, {transport: 'unix', path: '/var/run/my.sock'});

		dsn.hostname = '[::1:2:3]';
		assertEquals(dsn.hostname, '::1:2:3');
		assertEquals(dsn+'', 'mysql://johnny:hello@[::1:2:3]:22/var/run/my.sock/information_schema?multiStatements');

		dsn.port = 23;
		assertEquals(dsn.port, 23);
		assertEquals(dsn+'', 'mysql://johnny:hello@[::1:2:3]:23/var/run/my.sock/information_schema?multiStatements');
		dsn.port = 0;
		assertEquals(dsn.port, 3306);
		assertEquals(dsn+'', 'mysql://johnny:hello@[::1:2:3]/var/run/my.sock/information_schema?multiStatements');
		dsn.port = 3305;
		assertEquals(dsn.port, 3305);
		assertEquals(dsn+'', 'mysql://johnny:hello@[::1:2:3]:3305/var/run/my.sock/information_schema?multiStatements');
		dsn.port = 3306;
		assertEquals(dsn.port, 3306);
		assertEquals(dsn+'', 'mysql://johnny:hello@[::1:2:3]/var/run/my.sock/information_schema?multiStatements');
		dsn.port = 3307;
		assertEquals(dsn.port, 3307);
		assertEquals(dsn+'', 'mysql://johnny:hello@[::1:2:3]:3307/var/run/my.sock/information_schema?multiStatements');
		dsn.port = -Infinity;
		assertEquals(dsn.port, 3306);
		assertEquals(dsn+'', 'mysql://johnny:hello@[::1:2:3]/var/run/my.sock/information_schema?multiStatements');
		dsn = new Dsn('mysql://johnny:hello@[::1:2:3]:0/var/run/my.sock/information_schema?multiStatements');
		assertEquals(dsn.port, 3306);
		assertEquals(dsn+'', 'mysql://johnny:hello@[::1:2:3]/var/run/my.sock/information_schema?multiStatements');

		dsn.username = 'johnny';
		assertEquals(dsn.username, 'johnny');
		assertEquals(dsn+'', 'mysql://johnny:hello@[::1:2:3]/var/run/my.sock/information_schema?multiStatements');
		dsn.username = '';
		assertEquals(dsn.username, '');
		assertEquals(dsn+'', 'mysql://[::1:2:3]/var/run/my.sock/information_schema?multiStatements');

		dsn.username = 'root';
		assertEquals(dsn.username, 'root');
		assertEquals(dsn.password, 'hello');
		assertEquals(dsn+'', 'mysql://root:hello@[::1:2:3]/var/run/my.sock/information_schema?multiStatements');
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
