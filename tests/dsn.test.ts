import {Dsn} from '../dsn.ts';
import {assert, assertEquals} from "https://deno.land/std@0.97.0/testing/asserts.ts";

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

		let dsn_name = 'mysql://[::1]:3307';
		let dsn = new Dsn(dsn_name);
		assertEquals(dsn.hostname, '::1');
		assertEquals(dsn.port, 3307);
		assertEquals(dsn.username, '');
		assertEquals(dsn.password, '');
		assertEquals(dsn.schema, '');
		assertEquals(dsn.pipe, '');
		assertEquals(isNaN(dsn.keepAliveTimeout), true);
		assertEquals(isNaN(dsn.keepAliveMax), true);
		assertEquals(isNaN(dsn.maxColumnLen), true);
		assertEquals(dsn.foundRows, false);
		assertEquals(dsn.ignoreSpace, false);
		assertEquals(dsn.multiStatements, false);
		assertEquals(dsn.initSql, '');
		assertEquals(dsn+'', 'mysql://[::1]:3307/');
		assertEquals(dsn.addr, {transport: 'tcp', hostname: '::1', port: 3307});

		dsn_name = 'mysql://johnny@[::1]/?keepAliveTimeout=123#SET group_concat_max_len=65000';
		dsn = new Dsn(dsn_name);
		assertEquals(dsn.hostname, '::1');
		assertEquals(dsn.port, 3306);
		assertEquals(dsn.username, 'johnny');
		assertEquals(dsn.password, '');
		assertEquals(dsn.schema, '');
		assertEquals(dsn.pipe, '');
		assertEquals(dsn.keepAliveTimeout, 123);
		assertEquals(isNaN(dsn.keepAliveMax), true);
		assertEquals(isNaN(dsn.maxColumnLen), true);
		assertEquals(dsn.foundRows, false);
		assertEquals(dsn.ignoreSpace, false);
		assertEquals(dsn.multiStatements, false);
		assertEquals(dsn.initSql, 'SET group_concat_max_len=65000');
		assertEquals(dsn+'', 'mysql://johnny@[::1]/?keepAliveTimeout=123#'+encodeURIComponent('SET group_concat_max_len=65000'));
		assertEquals(dsn.addr, {transport: 'tcp', hostname: '::1', port: 3306});

		dsn_name = 'mysql://johnny:hello@localhost/information_schema?keepAliveTimeout=-123#SET group_concat_max_len=65000';
		dsn = new Dsn(dsn_name);
		assertEquals(dsn.hostname, 'localhost');
		assertEquals(dsn.port, 3306);
		assertEquals(dsn.username, 'johnny');
		assertEquals(dsn.password, 'hello');
		assertEquals(dsn.schema, 'information_schema');
		assertEquals(dsn.pipe, '');
		assertEquals(dsn.keepAliveTimeout, 0);
		assertEquals(isNaN(dsn.keepAliveMax), true);
		assertEquals(isNaN(dsn.maxColumnLen), true);
		assertEquals(dsn.foundRows, false);
		assertEquals(dsn.ignoreSpace, false);
		assertEquals(dsn.multiStatements, false);
		assertEquals(dsn.initSql, 'SET group_concat_max_len=65000');
		assertEquals(dsn+'', 'mysql://johnny:hello@localhost/information_schema?keepAliveTimeout=0#'+encodeURIComponent('SET group_concat_max_len=65000'));
		assertEquals(dsn.addr, {transport: 'tcp', hostname: 'localhost', port: 3306});

		dsn_name = 'mysql://johnny:hello@localhost/information_schema?keepAliveMax=1234.1&maxColumnLen=1000&foundRows&ignoreSpace# SET group_concat_max_len=65000  ';
		dsn = new Dsn(dsn_name);
		assertEquals(dsn.hostname, 'localhost');
		assertEquals(dsn.port, 3306);
		assertEquals(dsn.username, 'johnny');
		assertEquals(dsn.password, 'hello');
		assertEquals(dsn.schema, 'information_schema');
		assertEquals(dsn.pipe, '');
		assertEquals(isNaN(dsn.keepAliveTimeout), true);
		assertEquals(dsn.keepAliveMax, 1234);
		assertEquals(dsn.maxColumnLen, 1000);
		assertEquals(dsn.foundRows, true);
		assertEquals(dsn.ignoreSpace, true);
		assertEquals(dsn.multiStatements, false);
		assertEquals(dsn.initSql, 'SET group_concat_max_len=65000');
		assertEquals(dsn+'', 'mysql://johnny:hello@localhost/information_schema?keepAliveMax=1234&maxColumnLen=1000&foundRows&ignoreSpace#'+encodeURIComponent('SET group_concat_max_len=65000'));
		assertEquals(dsn.addr, {transport: 'tcp', hostname: 'localhost', port: 3306});

		dsn_name = 'mysql://johnny:hello@www.example.com:22/var/run/my.sock/information_schema?multiStatements';
		dsn = new Dsn(dsn_name);
		assertEquals(dsn.hostname, 'www.example.com');
		assertEquals(dsn.port, 22);
		assertEquals(dsn.username, 'johnny');
		assertEquals(dsn.password, 'hello');
		assertEquals(dsn.schema, 'information_schema');
		assertEquals(dsn.pipe, '/var/run/my.sock');
		assertEquals(isNaN(dsn.keepAliveTimeout), true);
		assertEquals(isNaN(dsn.keepAliveMax), true);
		assertEquals(isNaN(dsn.maxColumnLen), true);
		assertEquals(dsn.foundRows, false);
		assertEquals(dsn.ignoreSpace, false);
		assertEquals(dsn.multiStatements, true);
		assertEquals(dsn.initSql, '');
		assertEquals(dsn+'', 'mysql://johnny:hello@www.example.com:22/var/run/my.sock/information_schema?multiStatements');
		assertEquals(dsn.addr, {transport: 'unix', path: '/var/run/my.sock'});
	}
);
