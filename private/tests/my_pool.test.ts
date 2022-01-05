import {Dsn} from '../dsn.ts';
import {MyPool} from '../my_pool.ts';
import {Resultsets} from '../resultsets.ts';
import {BusyError, CanceledError} from '../errors.ts';
import {withDocker} from "./with_docker.ts";
import {writeAll, readAll, copy} from '../deps.ts';
import {assert, assertEquals} from "https://deno.land/std@0.117.0/testing/asserts.ts";

const {TESTS_DSN, WITH_DOCKER} = Deno.env.toObject();

const encoder = new TextEncoder;

// deno-lint-ignore no-explicit-any
type Any = any;

class SqlSelectGenerator
{	has_put_params_to = false;
	buffer_size = -1;

	constructor(private table: string, private column: string, private value: Any)
	{
	}

	toSqlBytesWithParamsBackslashAndBuffer(putParamsTo: Any[]|undefined, _noBackslashEscapes: boolean, buffer: Uint8Array)
	{	this.buffer_size = buffer.length;
		let sql;
		if (putParamsTo)
		{	putParamsTo.push(this.value);
			sql = `SELECT * FROM ${this.table} WHERE ${this.column} = ?`;
			this.has_put_params_to = true;
		}
		else
		{	sql = `SELECT * FROM ${this.table} WHERE ${this.column} = '${this.value}'`;
		}
		const {read, written} = encoder.encodeInto(sql, buffer);
		if (read == sql.length)
		{	return buffer.subarray(0, written);
		}
		return encoder.encode(sql);
	}
}

const TESTS =
[	testBasic,
	testPrepared,
	testVariousColumnTypes,
	testSqlError,
	testNoBackslashEscapes,
	testInitSql,
	testBusyState,
	testSessions,
	testPoolDsn,
	testManyPlaceholders,
	testManyPlaceholders2,
	testTrx,
	testLoadBigDump,
];

if (TESTS_DSN)
{	console.log('%cEnvironment variable TESTS_DSN is set, so using DSN %s for tests', 'color:blue', TESTS_DSN);
	for (const t of TESTS)
	{	Deno.test(t.name, () => t(TESTS_DSN));
	}
}
else if (WITH_DOCKER)
{	console.log("%cEnvironment variable WITH_DOCKER is set, so i'll download and run Docker images", 'color:blue', TESTS_DSN);

	Deno.test
	(	'All',
		async () =>
		{	await withDocker('mysql:latest', false, true, ['--innodb-idle-flush-pct=0'], tests);
			await withDocker('mysql:latest', true, false, ['--innodb-idle-flush-pct=0', '--local-infile', '--default-authentication-plugin=caching_sha2_password'], tests);
			await withDocker('mysql:8.0', true, true, ['--innodb-idle-flush-pct=0', '--default-authentication-plugin=mysql_native_password'], tests);
			await withDocker('mysql:5.7', true, false, ['--max-allowed-packet=67108864', '--local-infile'], tests);
			await withDocker('mysql:5.6', true, true, ['--max-allowed-packet=67108864', '--local-infile', '--innodb-log-file-size=50331648'], tests);

			await withDocker('mariadb:latest', false, true, ['--innodb-idle-flush-pct=0', '--max-allowed-packet=67108864'], tests);
			await withDocker('mariadb:latest', true, false, ['--innodb-idle-flush-pct=0', '--max-allowed-packet=67108864', '--local-infile', '--default-authentication-plugin=caching_sha2_password'], tests);
			await withDocker('mariadb:10.7', true, true, ['--innodb-idle-flush-pct=0', '--max-allowed-packet=67108864', '--default-authentication-plugin=mysql_native_password'], tests);
			await withDocker('mariadb:10.5', true, false, ['--innodb-idle-flush-pct=0', '--max-allowed-packet=67108864', '--local-infile'], tests);
			await withDocker('mariadb:10.2', true, true, ['--innodb-idle-flush-pct=0', '--max-allowed-packet=67108864', '--local-infile'], tests);
			await withDocker('cytopia/mariadb-10.0', true, false, ['--innodb-idle-flush-pct=0', '--max-allowed-packet=67108864', '--local-infile'], tests);
			await withDocker('cytopia/mariadb-5.5', true, false, ['--max-allowed-packet=67108864', '--local-infile', '--innodb-log-file-size=50331648'], tests);
		}
	);
}
else
{	console.log('%cPlease, set one of environment variables: TESTS_DSN or WITH_DOCKER.', 'color:blue');
	console.log('TESTS_DSN="mysql://..." deno test ...');
	console.log('Or');
	console.log('WITH_DOCKER=1 deno test ...');
}

async function tests(dsnStr: string)
{	for (const t of TESTS)
	{	console.log(`test ${t.name} ...`);
		const since = Date.now();
		let error;
		try
		{	const before = Object.assign({}, Deno.resources());
			await t(dsnStr);
			const after = Object.assign({}, Deno.resources());
			assertEquals(before, after);
		}
		catch (e)
		{	error = e;
		}
		const elapsed = Date.now() - since;
		const elapsedStr = elapsed<60000 ? (elapsed/1000)+'s' : Math.floor(elapsed/60000)+'m'+(Math.floor(elapsed/1000)%60)+'s';
		if (!error)
		{	console.log('\t%cok %c(%s)', 'color:green', 'color:gray', elapsedStr);
		}
		else
		{	console.log('\t%cFAILED %c(%s)', 'color:red', 'color:gray', elapsedStr);
			throw error;
		}
	}
}

async function testBasic(dsnStr: string)
{	const dsn = new Dsn(dsnStr);
	const pool = new MyPool(dsnStr);

	try
	{	pool.forConn
		(	async conn =>
			{	assertEquals(conn.serverVersion, '');
				assertEquals(conn.connectionId, 0);
				assertEquals(conn.autocommit, false);
				assertEquals(conn.inTrx, false);
				assertEquals(conn.inTrxReadonly, false);
				assertEquals(conn.noBackslashEscapes, false);
				assertEquals(conn.schema, '');
				assertEquals(conn.inXa, false);
				assertEquals(conn.xaId, '');

				await conn.connect();

				console.log('%cServer version: %c%s', 'color:orange', 'font-weight:bold', conn.serverVersion);
				assert(parseFloat(conn.serverVersion) > 0);
				assert(conn.connectionId > 0);
				assertEquals(conn.inTrx, false);
				assertEquals(conn.inTrxReadonly, false);
				assert(!conn.schema || conn.schema==dsn.schema);
				assertEquals(conn.inXa, false);
				assertEquals(conn.xaId, '');

				const connId = await conn.queryCol("SELECT Connection_id()").first();
				assertEquals(conn.connectionId, connId);

				await conn.execute("SET autocommit=1");
				assertEquals(conn.autocommit, true);
				await conn.execute("SET autocommit=0");
				assertEquals(conn.autocommit, false);
				await conn.execute("SET autocommit=1");

				await conn.execute("START TRANSACTION");
				assertEquals(conn.inTrx, true);
				assertEquals(conn.inTrxReadonly, false);
				await conn.execute("ROLLBACK");
				assertEquals(conn.inTrx, false);
				assertEquals(conn.inTrxReadonly, false);

				await conn.execute("SET autocommit=0");
				assertEquals(conn.inTrx, false);
				await conn.execute("START TRANSACTION");
				assertEquals(conn.inTrx, true);
				assertEquals(conn.inTrxReadonly, false);
				await conn.execute("ROLLBACK");
				assertEquals(conn.inTrx, false);
				assertEquals(conn.inTrxReadonly, false);
				await conn.execute("SET autocommit=1");
				assertEquals(conn.inTrx, false);
				assertEquals(conn.inTrxReadonly, false);

				if (parseFloat(conn.serverVersion) >= 6.0) // conn.serverVersion can be: 8.0.25-0ubuntu0.21.04.1
				{	await conn.execute("START TRANSACTION READ ONLY");
					assertEquals(conn.inTrx, true);
					assertEquals(conn.inTrxReadonly, true);
					await conn.execute("ROLLBACK");
					assertEquals(conn.inTrx, false);
					assertEquals(conn.inTrxReadonly, false);
				}

				await conn.execute("XA START 'a'");
				assertEquals(conn.inTrx, true);
				assertEquals(conn.inTrxReadonly, false);
				await conn.execute("XA END 'a'");
				await conn.execute("XA ROLLBACK 'a'");
				assertEquals(conn.inTrx, false);
				assertEquals(conn.inTrxReadonly, false);

				// CREATE DATABASE
				await conn.query("DROP DATABASE IF EXISTS test1");
				await conn.query("DROP DATABASE IF EXISTS test2");
				await conn.query("CREATE DATABASE `test1` /*!40100 CHARSET latin1 COLLATE latin1_general_ci*/");
				await conn.query("CREATE DATABASE `test2` /*!40100 CHARSET utf8mb4 COLLATE utf8mb4_unicode_ci*/");

				// Check schema change
				await conn.query("USE test1");
				assert(!conn.schema || conn.schema=='test1');
				await conn.query("USE test2");
				assert(!conn.schema || conn.schema=='test2');

				// Check simple query
				assertEquals(await conn.queryCol<Any>("SELECT 123").first(), 123);

				// Check query with params
				assertEquals(Number(await conn.queryCol<Any>("SELECT ?", [123]).first()), 123); // can return bigint

				// CREATE TABLE
				await conn.query("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, `time` timestamp(3) NOT NULL, message text)");

				// INSERT
				let now = Date.now();
				now -= now % 1000;
				await conn.forQuery
				(	"INSERT INTO t_log SET `time`=?, message=?",
					async prepared =>
					{	await prepared.exec([new Date(now+1000), 'Message 1']);
						assertEquals(prepared.lastInsertId, 1);
						assertEquals(prepared.affectedRows, 1);
						await prepared.exec([new Date(now+2000), 'Message 2']);
						assertEquals(prepared.lastInsertId, 2);
						assertEquals(prepared.affectedRows, 1);
						await prepared.exec([new Date(now+3000), 'Message 3']);
						assertEquals(prepared.lastInsertId, 3);
						assertEquals(prepared.affectedRows, 1);
					}
				);
				let res = await conn.execute("INSERT INTO t_log SET `time`=?, message=?", [new Date(now+4000), 'Message 4']);
				assertEquals(res.lastInsertId, 4);
				assertEquals(res.affectedRows, 1);

				// SELECT
				assertEquals
				(	await conn.query("SELECT * FROM t_log").all(),
					[	{id: 1, time: new Date(now+1000), message: 'Message 1'},
						{id: 2, time: new Date(now+2000), message: 'Message 2'},
						{id: 3, time: new Date(now+3000), message: 'Message 3'},
						{id: 4, time: new Date(now+4000), message: 'Message 4'},
					]
				);

				// SELECT forEach
				let rows: Record<string, Any>[] = [];
				const theHello = await conn.query("SELECT * FROM t_log").forEach
				(	row =>
					{	rows.push(row);
						return 'hello';
					}
				);
				assertEquals
				(	rows,
					[	{id: 1, time: new Date(now+1000), message: 'Message 1'},
						{id: 2, time: new Date(now+2000), message: 'Message 2'},
						{id: 3, time: new Date(now+3000), message: 'Message 3'},
						{id: 4, time: new Date(now+4000), message: 'Message 4'},
					]
				);
				assertEquals(theHello, 'hello');

				// SELECT forEach
				rows = [];
				await (await conn.query("SELECT * FROM t_log")).forEach
				(	row =>
					{	rows.push(row);
					}
				);
				assertEquals
				(	rows,
					[	{id: 1, time: new Date(now+1000), message: 'Message 1'},
						{id: 2, time: new Date(now+2000), message: 'Message 2'},
						{id: 3, time: new Date(now+3000), message: 'Message 3'},
						{id: 4, time: new Date(now+4000), message: 'Message 4'},
					]
				);

				// queryMap
				const rows2 = await conn.queryMap("SELECT * FROM t_log").all()
				assertEquals
				(	rows2,
					[	new Map(Object.entries({id: 1, time: new Date(now+1000), message: 'Message 1'})),
						new Map(Object.entries({id: 2, time: new Date(now+2000), message: 'Message 2'})),
						new Map(Object.entries({id: 3, time: new Date(now+3000), message: 'Message 3'})),
						new Map(Object.entries({id: 4, time: new Date(now+4000), message: 'Message 4'})),
					]
				);

				// queryArr
				const rows3 = await conn.queryArr("SELECT id, `time`, message FROM t_log").all()
				assertEquals
				(	rows3,
					[	[1, new Date(now+1000), 'Message 1'],
						[2, new Date(now+2000), 'Message 2'],
						[3, new Date(now+3000), 'Message 3'],
						[4, new Date(now+4000), 'Message 4'],
					]
				);

				// makeLastColumnReader - text protocol
				let row = await conn.makeLastColumnReader("SELECT * FROM t_log WHERE id=2");
				let message = row?.message;
				assert(message && typeof(message)=='object' && 'read' in message && typeof(message.read)=='function');
				assertEquals(new TextDecoder().decode(await readAll(message)), 'Message 2');

				// makeLastColumnReader - binary protocol
				row = await conn.makeLastColumnReader("SELECT * FROM t_log WHERE id=?", [3]);
				message = row?.message;
				assert(message && typeof(message)=='object' && 'read' in message && typeof(message.read)=='function');
				assertEquals(new TextDecoder().decode(await readAll(message)), 'Message 3');

				// SELECT discard
				const res2 = await conn.query("SELECT * FROM t_log");
				assertEquals(res2.hasMore, true);
				await res2.discard();
				assertEquals(res2.hasMore, false);
				await res2.discard();
				assertEquals(res2.hasMore, false);

				// SELECT
				assertEquals(await conn.queryCol("SELECT message FROM t_log", []).first(), 'Message 1');

				// SELECT
				assertEquals(await (await conn.queryCol("SELECT message FROM t_log", [])).first(), 'Message 1');

				// SELECT
				assertEquals(await (await conn.queryCol("SELECT message FROM t_log", [])).all(), ['Message 1', 'Message 2', 'Message 3', 'Message 4']);

				// SELECT
				assertEquals(await conn.queryCol("SELECT message FROM t_log WHERE id=?", [3]).first(), 'Message 3');

				// SELECT
				assertEquals(await conn.queryCol("SELECT message FROM t_log WHERE id=@id", {id: 3, junk: '*'}).first(), 'Message 3');

				// SELECT
				const value = 'Message 3';
				let gen = new SqlSelectGenerator('t_log', 'message', value);
				assertEquals(await conn.queryCol(gen).first(), 3);
				assertEquals(gen.has_put_params_to, false);

				for (const id of [5, 6])
				{	const filename = await Deno.makeTempFile();
					try
					{	const fh = await Deno.open(filename, {write: true, read: true});
						try
						{	await writeAll(fh, new TextEncoder().encode(id==6 ? '' : 'Message '+id));
							await fh.seek(0, Deno.SeekMode.Start);
							res = await conn.execute("INSERT INTO t_log SET `time`=?, message=?", [new Date(now+id*1000), fh]);
							assertEquals(res.lastInsertId, id);
							assertEquals(res.affectedRows, 1);
							const gen = new SqlSelectGenerator('t_log', 'id', id);
							assertEquals(await conn.query(gen).first(), {id, time: new Date(now+id*1000), message: id==6 ? '' : 'Message '+id});
						}
						finally
						{	fh.close();
						}
					}
					finally
					{	await Deno.remove(filename);
					}
				}

				res = await conn.execute("INSERT INTO t_log SET `time`=?, message=?", [new Date(now+7000), new TextEncoder().encode('Message 7')]);
				assertEquals(res.lastInsertId, 7);
				assertEquals(res.affectedRows, 1);
				gen = new SqlSelectGenerator('t_log', 'id', 7);
				assertEquals(await conn.query(gen, []).first(), {id: 7, time: new Date(now+7000), message: 'Message 7'});
				assertEquals(gen.has_put_params_to, true);

				res = await conn.execute("INSERT INTO t_log SET `time`=?, message=?", [new Date(now+8000), new Uint16Array(new TextEncoder().encode('Message 8*').buffer)]);
				assertEquals(res.lastInsertId, 8);
				assertEquals(res.affectedRows, 1);
				gen = new SqlSelectGenerator('t_log', 'id', 8);
				assertEquals(await conn.query(gen).first(), {id: 8, time: new Date(now+8000), message: 'Message 8*'});
				assertEquals(gen.has_put_params_to, false);

				res = await conn.execute("INSERT INTO t_log SET `time`=?, message=?", [new Date(now+9000), {value: 'Message 9'}]);
				assertEquals(res.lastInsertId, 9);
				assertEquals(res.affectedRows, 1);
				gen = new SqlSelectGenerator('t_log', 'id', 9);
				assertEquals(await conn.query(gen).first(), {id: 9, time: new Date(now+9000), message: JSON.stringify({value: 'Message 9'})});

				res = await conn.execute("INSERT INTO t_log SET `time`=?, message=?", [new Date(now+10001), new TextEncoder().encode('-')]);
				assertEquals(res.lastInsertId, 10);
				assertEquals(res.affectedRows, 1);
				assertEquals(await conn.query("SELECT `time`, message FROM t_log WHERE id=?", [10]).first(), {time: new Date(now+10001), message: '-'});

				res = await conn.execute("INSERT INTO t_log SET `time`=?, message=?", [new Date(now+11001), new Uint16Array(new TextEncoder().encode('--').buffer)]);
				assertEquals(res.lastInsertId, 11);
				assertEquals(res.affectedRows, 1);
				assertEquals(await conn.query("SELECT `time`, message FROM t_log WHERE id=?", [11]).first(), {time: new Date(now+11001), message: '--'});

				res = await conn.execute("INSERT INTO t_log SET `time`=?, message=?", [new Date(now+12000), 123n]);
				assertEquals(res.lastInsertId, 12);
				assertEquals(res.affectedRows, 1);
				assertEquals(await conn.query("SELECT `time`, message FROM t_log WHERE id=?", [12]).first(), {time: new Date(now+12000), message: '123'});

				res = await conn.execute("INSERT INTO t_log SET `time`=?, message=?", [new Date(now+13000), null]);
				assertEquals(res.lastInsertId, 13);
				assertEquals(res.affectedRows, 1);
				assertEquals(await conn.query("SELECT `time`, message FROM t_log WHERE id=?", [13]).first(), {time: new Date(now+13000), message: null});

				res = await conn.execute("INSERT INTO t_log SET `time`=?, message=?", [new Date(now+14000), undefined]);
				assertEquals(res.lastInsertId, 14);
				assertEquals(res.affectedRows, 1);
				assertEquals(await conn.query("SELECT `time`, message FROM t_log WHERE id=?", [14]).first(), {time: new Date(now+14000), message: null});

				res = await conn.execute("INSERT INTO t_log SET `time`=?, message=?", [new Date(now+15000), () => {}]);
				assertEquals(res.lastInsertId, 15);
				assertEquals(res.affectedRows, 1);
				assertEquals(await conn.query("SELECT `time`, message FROM t_log WHERE id=?", [15]).first(), {time: new Date(now+15000), message: null});

				res = await conn.execute("INSERT INTO t_log SET `time`=?, message=?", [new Date(now+16000), Symbol.iterator]);
				assertEquals(res.lastInsertId, 16);
				assertEquals(res.affectedRows, 1);
				assertEquals(await conn.query("SELECT `time`, message FROM t_log WHERE id=?", [16]).first(), {time: new Date(now+16000), message: null});

				res = await conn.execute("INSERT INTO t_log SET `time`=?, message=?", [new Date(now+17000), false]);
				assertEquals(res.lastInsertId, 17);
				assertEquals(res.affectedRows, 1);
				assertEquals(await conn.query("SELECT `time`, message FROM t_log WHERE id=?", [17]).first(), {time: new Date(now+17000), message: '0'});

				res = await conn.execute("INSERT INTO t_log SET `time`=?, message=?", [new Date(now+18000), true]);
				assertEquals(res.lastInsertId, 18);
				assertEquals(res.affectedRows, 1);
				assertEquals(await conn.query("SELECT `time`, message FROM t_log WHERE id=?", [18]).first(), {time: new Date(now+18000), message: '1'});

				res = await conn.execute("INSERT INTO t_log SET `time`=?, message=?", [new Date(now+19000), 123.5]);
				assertEquals(res.lastInsertId, 19);
				assertEquals(res.affectedRows, 1);
				assertEquals(await conn.query("SELECT `time`, message FROM t_log WHERE id=?", [19]).first(), {time: new Date(now+19000), message: '123.5'});

				// Drop databases that i created
				await conn.query("DROP DATABASE test1");
				await conn.query("DROP DATABASE test2");
			}
		);
	}
	finally
	{	await pool.shutdown();
	}
}

async function testPrepared(dsnStr: string)
{	const N_ROWS = 3;
	const pool = new MyPool(dsnStr);

	try
	{	pool.forConn
		(	async conn =>
			{	// CREATE DATABASE
				await conn.query("DROP DATABASE IF EXISTS test1");
				await conn.query("CREATE DATABASE `test1` /*!40100 CHARSET latin1 COLLATE latin1_general_ci*/");

				// USE
				await conn.query("USE test1");

				// CREATE TABLE
				await conn.query("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, `time` timestamp NOT NULL, message text)");

				// INSERT
				let now = Date.now();
				now -= now % 1000;
				await conn.forQuery
				(	"INSERT INTO t_log SET `time`=?, message=?",
					async prepared =>
					{	for (let i=1; i<=N_ROWS; i++)
						{	await prepared.exec([new Date(now+i*1000), 'Message '+i]);
						}
					}
				);

				// SELECT no read at end
				await conn.forQuery
				(	"SELECT * FROM t_log WHERE id=?",
					async prepared =>
					{	await prepared.exec([1]);
						assertEquals(prepared.columns.length, 3);
					}
				);

				// SELECT
				await conn.forQuery
				(	"SELECT * FROM t_log WHERE id=?",
					async prepared =>
					{	for (let i=1; i<=N_ROWS; i++)
						{	await prepared.exec([i]);
							for await (const row of prepared)
							{	assertEquals(row, {id: i, time: new Date(now+i*1000), message: 'Message '+i});
							}
						}
					}
				);

				// SELECT call end()
				let error: Error|undefined;
				let error2: Error|undefined;
				await conn.forQuery
				(	"SELECT * FROM t_log WHERE id=?",
					async prepared =>
					{	await prepared.exec([1]);
						assertEquals(prepared.columns.length, 3);
						conn.end();
						try
						{	await prepared.exec([2]);
						}
						catch (e)
						{	error = e;
						}
						await new Promise(y => setTimeout(y, 1000));
						try
						{	await prepared.exec([2]);
						}
						catch (e)
						{	error2 = e;
						}
					}
				);
				assert(error instanceof CanceledError);
				assert(error2 instanceof CanceledError);

				// Drop database that i created
				await conn.query("DROP DATABASE test1");
			}
		);
	}
	finally
	{	await pool.shutdown();
	}
}

async function testVariousColumnTypes(dsnStr: string)
{	const dsn = new Dsn(dsnStr);
	dsn.multiStatements = true;
	const pool = new MyPool(dsn);

	try
	{	pool.forConn
		(	async conn =>
			{	// CREATE TABLE
				let res = await conn.query
				(	`	DROP DATABASE IF EXISTS test1;
						CREATE DATABASE test1 /*!40100 CHARSET latin1 COLLATE latin1_general_ci*/;
						USE test1;

						CREATE TEMPORARY TABLE t1
						(	id integer PRIMARY KEY AUTO_INCREMENT,
							c_null text,

							c_bit0 bit NOT NULL,
							c_bit1 bit NOT NULL,

							c_tinyint tinyint NOT NULL,
							c_tinyint_u tinyint unsigned NOT NULL,
							c_smallint smallint NOT NULL,
							c_smallint_u smallint unsigned NOT NULL,
							c_mediumint mediumint NOT NULL,
							c_mediumint_u mediumint unsigned NOT NULL,
							c_int int NOT NULL,
							c_int_u int unsigned NOT NULL,
							c_bigint bigint NOT NULL,
							c_bigint_u bigint unsigned NOT NULL,

							c_float float NOT NULL,
							c_double double NOT NULL,

							c_decimal decimal(63,30) NOT NULL,

							c_tinytext tinytext,
							c_text text,
							c_mediumtext mediumtext,
							c_longtext longtext,

							c_tinyblob tinyblob,
							c_blob blob,
							c_mediumblob mediumblob,
							c_longblob longblob,

							c_char char(5),
							c_binary binary(5),

							c_varchar varchar(100),
							c_varbinary varbinary(100),

							/*!50708 c_json json,*/

							c_year year NOT NULL,
							c_timestamp timestamp(6) NOT NULL,
							c_date date NOT NULL,
							c_datetime datetime NOT NULL,
							c_time time(3) NOT NULL
						);

						INSERT INTO t1 SET
							c_null = NULL,

							c_bit0 = 0,
							c_bit1 = 1,

							c_tinyint = 1,
							c_tinyint_u = 2,
							c_smallint = -3,
							c_smallint_u = 4,
							c_mediumint = 5,
							c_mediumint_u = 6,
							c_int = 7,
							c_int_u = 8,
							c_bigint = -9007199254740991,
							c_bigint_u = Pow(2, 63),

							c_float = 11.5,
							c_double = -12.25,

							c_decimal = '123456789012345678901234567890123.012345678901234567890123456789',

							c_tinytext = 'abcd',
							c_text = 'efgh',
							c_mediumtext = 'ijkl',
							c_longtext = 'mnop',

							c_tinyblob = x'01020304',
							c_blob = x'05060708',
							c_mediumblob = x'090A0B0C',
							c_longblob = x'0D0E0F10',

							c_char = 'abc',
							c_binary = x'010203',

							c_varchar = 'abc',
							c_varbinary = x'010203',

							/*!50708 c_json = Json_object('a', 1, 'b', 2),*/

							c_year = 2020,
							c_timestamp = '2000-12-01 01:02:03.432',
							c_date = '2000-12-02',
							c_datetime = '2000-12-01 01:02:03',
							c_time = '1:2:3.456';
					`
				);

				assertEquals(res.columns.length, 0);
				assertEquals(res.hasMore, true);
				assertEquals(await res.all(), []);
				assertEquals(res.hasMore, true);
				assertEquals(await res.nextResultset(), true);

				assertEquals(res.columns.length, 0);
				assertEquals(res.hasMore, true);
				assertEquals(await res.first(), undefined);
				assertEquals(res.hasMore, true);
				assertEquals(await res.nextResultset(), true);

				assertEquals(res.columns.length, 0);
				assertEquals(res.hasMore, true);
				assertEquals(await res.first(), undefined);
				assertEquals(res.hasMore, true);
				assertEquals(await res.nextResultset(), true);

				assertEquals(res.columns.length, 0);
				assertEquals(res.hasMore, true);
				assertEquals(await res.first(), undefined);
				assertEquals(res.hasMore, true);
				assertEquals(await res.nextResultset(), true);

				assertEquals(res.columns.length, 0);
				assertEquals(res.affectedRows, 1);
				assertEquals(res.lastInsertId, 1);
				assertEquals(res.hasMore, false);
				assertEquals(await res.first(), undefined);
				assertEquals(res.hasMore, false);
				assertEquals(await res.nextResultset(), false);
				assertEquals(res.hasMore, false);

				for (let i=0; i<2; i++)
				{	res = await conn.query("SELECT * FROM t1", i==0 ? undefined : []);

					assertEquals(res.hasMore, true);
					const row = await res.first();
					const expectedRow: Record<string, Any> =
					{	id: 1,
						'c_null': null,

						'c_bit0': false,
						'c_bit1': true,

						'c_tinyint': 1,
						'c_tinyint_u': 2,
						'c_smallint': -3,
						'c_smallint_u': 4,
						'c_mediumint': 5,
						'c_mediumint_u': 6,
						'c_int': 7,
						'c_int_u': 8,
						'c_bigint': -9007199254740991,
						'c_bigint_u': 2n ** 63n,

						'c_float': 11.5,
						'c_double': -12.25,

						'c_decimal': '123456789012345678901234567890123.012345678901234567890123456789',

						'c_tinytext': 'abcd',
						'c_text': 'efgh',
						'c_mediumtext': 'ijkl',
						'c_longtext': 'mnop',

						'c_tinyblob': new Uint8Array([1, 2, 3, 4]),
						'c_blob': new Uint8Array([5, 6, 7, 8]),
						'c_mediumblob': new Uint8Array([0x09, 0x0A, 0x0B, 0x0C]),
						'c_longblob': new Uint8Array([0x0D, 0x0E, 0x0F, 0x10]),

						'c_char': 'abc',
						'c_binary': new Uint8Array([1, 2, 3, 0, 0]),

						'c_varchar': 'abc',
						'c_varbinary': new Uint8Array([1, 2, 3]),

						'c_year': 2020,
						'c_timestamp': new Date(2000, 11, 1, 1, 2, 3, 432),
						'c_date': new Date(2000, 11, 2),
						'c_datetime': new Date(2000, 11, 1, 1, 2, 3),
						'c_time': 1*60*60 + 2*60 + 3.456,
					};
					if (row && ('c_json' in row))
					{	expectedRow.c_json = {a: 1, b: 2};
					}
					assertEquals(res.columns.length, Object.keys(expectedRow).length);
					assertEquals(row, expectedRow);
					const expectedColumnTypes =
					[	'integer',
						'text',

						'bit',
						'bit',

						'tinyint',
						'tinyint unsigned',
						'smallint',
						'smallint unsigned',
						'mediumint',
						'mediumint unsigned',
						'integer',
						'integer unsigned',
						'bigint',
						'bigint unsigned',

						'float',
						'double',

						'decimal',

						'tinytext',
						'text',
						'mediumtext',
						'longtext',

						'tinyblob',
						'blob',
						'mediumblob',
						'longblob',

						'char',
						'binary',

						'varchar',
						'varbinary',

						'year',
						'timestamp',
						'date',
						'datetime',
						'time',
					];
					if (row && ('c_json' in row))
					{	expectedColumnTypes.splice(expectedColumnTypes.indexOf('year'), 0, 'json');
					}
					assertEquals(res.columns.map(v => v.type), expectedColumnTypes);
					assertEquals(res.hasMore, false);
					assertEquals(await res.nextResultset(), false);
					assertEquals(await res.nextResultset(), false);
					assertEquals(await res.nextResultset(), false);
				}

				// Drop database that i created
				await conn.query("DROP DATABASE test1");
			}
		);
	}
	finally
	{	await pool.shutdown();
	}
}

async function testSqlError(dsnStr: string)
{	const pool = new MyPool(dsnStr);

	try
	{	pool.forConn
		(	async conn =>
			{	// CREATE DATABASE
				await conn.query("DROP DATABASE IF EXISTS test1");
				await conn.query("CREATE DATABASE `test1` /*!40100 CHARSET latin1 COLLATE latin1_general_ci*/");

				// Check schema change
				await conn.query("USE test1");
				assert(!conn.schema || conn.schema=='test1');

				// CREATE TABLE
				await conn.query("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, `time` timestamp NOT NULL, message text)");

				// INSERT
				let res = await conn.queryCol("INSERT INTO t_log SET `time`=Now(), message=NULL");
				assertEquals(res.affectedRows, 1);

				// HELLO
				let error;
				try
				{	await conn.query("HELLO");
				}
				catch (e)
				{	error = e;
				}
				assert(error);

				// INSERT
				res = await conn.queryCol("INSERT INTO t_log SET `time`=Now(), message=NULL");
				assertEquals(res.affectedRows, 1);

				// SELECT
				assertEquals(await conn.queryCol("SELECT Count(*) FROM t_log").first(), 2);

				// Drop database that i created
				await conn.query("DROP DATABASE test1");
			}
		);
	}
	finally
	{	await pool.shutdown();
	}
}

async function testNoBackslashEscapes(dsnStr: string)
{	const pool = new MyPool(dsnStr);

	try
	{	pool.forConn
		(	async conn =>
			{	await conn.query("SET sql_mode=''");
				assertEquals(conn.noBackslashEscapes, false);
				assertEquals(await conn.queryCol("SELECT 'a\\nb'").first(), 'a\nb');

				await conn.query("SET sql_mode='NO_BACKSLASH_ESCAPES'");
				assertEquals(conn.noBackslashEscapes, true);
				assertEquals(await conn.queryCol("SELECT 'a\\nb'").first(), 'a\\nb');
			}
		);
	}
	finally
	{	await pool.shutdown();
	}
}

async function testInitSql(dsnStr: string)
{	const dsn = new Dsn(dsnStr);
	dsn.initSql = "SET @myvar1='all'";
	let pool = new MyPool(dsn);

	function isResetConnectioSupported(version: string)
	{	if (version.indexOf('MariaDB') != -1)
		{	/*	Examples:
				5.5.5-10.6.5-MariaDB-1:10.6.5+maria~focal
				5.5.5-10.2.41-MariaDB-1:10.2.41+maria~bionic
				5.5.5-10.0.34-MariaDB
			 */
			version = version.slice(version.indexOf('-')+1);
			return parseFloat(version) >= 10.2;
		}
		else
		{	/*	Examples:
				8.0.27-0ubuntu0.21.10.1
				5.6.51
			 */
			return parseFloat(version) >= 5.7;
		}
	}

	try
	{	let connectionId = -1;

		await pool.forConn
		(	async conn =>
			{	let value = await conn.queryCol("SELECT @myvar1").first();
				if (value instanceof Uint8Array)
				{	value = new TextDecoder().decode(value);
				}
				assertEquals(value, 'all');

				await conn.execute("SET @myvar2=1");
				assertEquals(await conn.queryCol("SELECT @myvar2").first(), 1);

				connectionId = conn.connectionId;
			}
		);

		await new Promise(y => setTimeout(y, 1000));

		await pool.forConn
		(	async conn =>
			{	await conn.connect();
				assertEquals(conn.connectionId, connectionId);

				let value = await conn.queryCol("SELECT @myvar1").first();
				if (value instanceof Uint8Array)
				{	value = new TextDecoder().decode(value);
				}
				assertEquals(value, 'all');

				if (isResetConnectioSupported(conn.serverVersion))
				{	assertEquals(await conn.queryCol("SELECT @myvar2").first(), null);
				}
			}
		);
	}
	finally
	{	await pool.shutdown();
	}

	dsn.initSql = "SELECT @myvar3:='my value'";
	pool = new MyPool(dsn);

	try
	{	pool.forConn
		(	async conn =>
			{	let value = await conn.queryCol("SELECT @myvar3").first();
				if (value instanceof Uint8Array)
				{	value = new TextDecoder().decode(value);
				}
				assertEquals(value, 'my value');
			}
		);
	}
	finally
	{	await pool.shutdown();
	}
}

async function testBusyState(dsnStr: string)
{	const pool = new MyPool(dsnStr);

	try
	{	pool.forConn
		(	async conn =>
			{	// CREATE DATABASE
				await conn.query("DROP DATABASE IF EXISTS test1");
				await conn.query("CREATE DATABASE `test1`");
				await conn.query("USE test1");
				await conn.query("SET autocommit=1");

				// CREATE TABLE
				await conn.query("CREATE TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, `time` timestamp NOT NULL, message text)");

				let value = conn.queryCol("SELECT 10").first(); // no await
				let error;
				try
				{	await conn.queryCol("SELECT 11");
				}
				catch (e)
				{	error = e;
				}
				assertEquals(error instanceof BusyError, true);
				assertEquals(await value, 10);

				let promise = conn.execute("SELECT 12");
				conn.end();
				error = undefined;
				let couldQuery = false;
				try
				{	const resultset = await promise; // first packet must succeed (in current implementation), although end() called
					couldQuery = true;
					await resultset.all(); // this must throw CanceledError
				}
				catch (e)
				{	error = e;
				}
				assertEquals(error instanceof CanceledError, true);
				assertEquals(couldQuery, true);

				await conn.connect();
				promise = conn.execute("INSERT INTO test1.t_log SET `time`=Now(), message='Message 1'");
				conn.end();
				const resultset = await promise; // this must succeed, because INSERT receives only 1 response packet
				assertEquals(resultset.affectedRows, 1);
				assertEquals(resultset.lastInsertId, 1);

				// previous INSERT query must be executed completely, although it's resultsets cancelled
				value = conn.queryCol("SELECT message FROM test1.t_log WHERE id=1").first();
				assertEquals(await value, 'Message 1');

				// Drop database that i created
				await conn.query("DROP DATABASE test1");
			}
		);
	}
	finally
	{	await pool.shutdown();
	}
}

async function testSessions(dsnStr: string)
{	const pool = new MyPool(dsnStr);
	const dsn2 = new Dsn(dsnStr);
	dsn2.keepAliveMax = 10;

	try
	{	pool.session
		(	async session =>
			{	const conn1 = session.conn(); // default DSN
				const conn2 = session.conn(); // the same object
				const conn3 = session.conn(undefined, true); // another connection to default DSN
				const conn4 = session.conn(dsn2); // connection to different DSN

				assert(conn1 === conn2);
				assert(conn2 !== conn3);
				assert(conn2 !== conn4);
				assert(conn3 !== conn4);

				const connId2Promise = conn2.queryCol("SELECT Connection_id()").first();
				const connId3Promise = conn3.queryCol("SELECT Connection_id()").first();
				const connId4Promise = conn4.queryCol("SELECT Connection_id()").first();

				const [connId2, connId3, connId4] = await Promise.all([connId2Promise, connId3Promise, connId4Promise]);
				assert(connId2!=connId3 && connId3!=connId4);
			}
		);
	}
	finally
	{	await pool.shutdown();
	}
}

async function testPoolDsn(_dsnStr: string)
{	const pool = new MyPool;

	try
	{	pool.session
		(	// deno-lint-ignore require-await
			async session =>
			{	let error;
				try
				{	session.conn();
				}
				catch (e)
				{	error = e;
				}
				assertEquals(error?.message, 'DSN not provided, and also default DSN was not specified');
			}
		);
	}
	finally
	{	await pool.shutdown();
	}
}

async function testManyPlaceholders(dsnStr: string)
{	const pool = new MyPool(dsnStr);

	try
	{	pool.forConn
		(	async conn =>
			{	// CREATE DATABASE
				await conn.query("DROP DATABASE IF EXISTS test1");
				await conn.query("CREATE DATABASE `test1`");

				// USE
				await conn.query("USE test1");

				// CREATE TABLE
				await conn.query("CREATE TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, a text, b text, c text, d text, e text, f text, g text, h text)");

				const N_ROWS = 8*1024-1;
				const q = `INSERT INTO t_log (a, b, c, d, e, f, g, h) VALUES ` + `(?, ?, ?, ?, ?, ?, ?, ?), `.repeat(N_ROWS).slice(0, -2);
				const params = [];
				for (let r=0; r<N_ROWS; r++)
				{	for (let c=0; c<8; c++)
					{	params.push(params.length + 1);
					}
				}

				let res = await conn.execute(q, params);
				assertEquals(res.affectedRows, 8191);
				assertEquals(res.nPlaceholders, N_ROWS*8);

				res = await conn.execute(q, params.map(v => v+''));
				assertEquals(res.affectedRows, 8191);
				assertEquals(res.nPlaceholders, N_ROWS*8);

				res = await conn.execute(q, params.map(v => v%100==0 ? (v+'').repeat(10000) : v%20==0 ? null : v%10==0 ? v : v+''));
				assertEquals(res.affectedRows, 8191);
				assertEquals(res.nPlaceholders, N_ROWS*8);

				// Drop database that i created
				await conn.query("DROP DATABASE test1");
			}
		);
	}
	finally
	{	await pool.shutdown();
	}
}

async function testManyPlaceholders2(dsnStr: string)
{	const pool = new MyPool(dsnStr);

	try
	{	pool.forConn
		(	async conn =>
			{	const N_PARAMS = 303; // this magic number causes read_void_async() to trigger
				const pp = [];
				let sum = 0;
				for (let i=0; i<N_PARAMS; i++)
				{	pp[i] = i;
					sum += i;
				}
				const calcedSum = await conn.queryCol<Any>(`SELECT ?`+'+?'.repeat(pp.length-1), pp).first();
				if (typeof(calcedSum) == 'bigint') // MySQL5.7 returns bigint, MySQL8.0 returns number
				{	assertEquals(calcedSum, BigInt(sum));
				}
				else
				{	assertEquals(calcedSum, sum);
				}
			}
		);
	}
	finally
	{	await pool.shutdown();
	}
}

async function testTrx(dsnStr: string)
{	const pool = new MyPool(dsnStr);
	pool.options({managedXaDsns: dsnStr});
	const MY_XA_ID = '6294554977320077-';

	try
	{	await pool.forConn
		(	async conn =>
			{	// Recover
				try
				{	for await (const row of await conn.query(`XA RECOVER`))
					{	if (typeof(row.data)=='string' && row.data.startsWith(MY_XA_ID))
						{	await conn.query(`XA ROLLBACK '${row.data}'`);
							console.log('Rolled back dangling XA');
						}
						else
						{	console.log("%cWarning: there's active XA:%c %s", 'background-color:black; color:yellow', 'font-weight:bold', row.data);
						}
					}
				}
				catch
				{	// ok
				}

				// CREATE DATABASE
				await conn.query("DROP DATABASE IF EXISTS test58168");
				await conn.query("CREATE DATABASE `test58168`");

				// USE
				await conn.query("USE test58168");

				// CREATE TABLE
				await conn.query("CREATE TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, a int)");

				// rollback
				await conn.startTrx();
				await conn.query("INSERT INTO t_log SET a = 123");
				assertEquals(await conn.queryCol("SELECT a FROM t_log WHERE id=1").first(), 123);
				await conn.rollback();
				assertEquals(await conn.queryCol("SELECT Count(*) FROM t_log").first(), 0);

				// end() before startTrx()
				conn.end();
				await conn.query("USE test58168");
				await conn.startTrx();
				let id = (await conn.query("INSERT INTO t_log SET a = 123")).lastInsertId;
				assertEquals(await conn.queryCol("SELECT a FROM t_log WHERE id=?", [id]).first(), 123);
				await conn.rollback();
				assertEquals(await conn.queryCol("SELECT Count(*) FROM t_log").first(), 0);

				// commit
				await conn.startTrx();
				id = (await conn.query("INSERT INTO t_log SET a = 123")).lastInsertId;
				assertEquals(await conn.queryCol("SELECT a FROM t_log WHERE id=?", [id]).first(), 123);
				await conn.commit();
				assertEquals(await conn.queryCol("SELECT Count(*) FROM t_log").first(), 1);
				await conn.rollback();
				assertEquals(await conn.queryCol("SELECT Count(*) FROM t_log").first(), 1);
				let res = await conn.query("DELETE FROM t_log");
				assertEquals(res.affectedRows, 1);
				assertEquals(await conn.queryCol("SELECT Count(*) FROM t_log").first(), 0);

				// savepoint
				await conn.startTrx();
				const point1 = await conn.savepoint();
				await conn.query("INSERT INTO t_log SET a = 123");
				const point2 = await conn.savepoint();
				await conn.query("INSERT INTO t_log SET a = 456");
				const point3 = await conn.savepoint();
				assertEquals(await conn.queryCol("SELECT Count(*) FROM t_log").first(), 2);
				await conn.rollback(point3);
				assertEquals(await conn.queryCol("SELECT Count(*) FROM t_log").first(), 2);
				await conn.rollback(point2);
				assertEquals(await conn.queryCol("SELECT Count(*) FROM t_log").first(), 1);
				await conn.rollback(point2);
				assertEquals(await conn.queryCol("SELECT Count(*) FROM t_log").first(), 1);
				await conn.rollback(point1);
				assertEquals(await conn.queryCol("SELECT Count(*) FROM t_log").first(), 0);
				await conn.rollback(point1);
				assertEquals(await conn.queryCol("SELECT Count(*) FROM t_log").first(), 0);
				await conn.rollback();
				assertEquals(await conn.queryCol("SELECT Count(*) FROM t_log").first(), 0);

				// readonly
				await conn.startTrx({readonly: true});
				assertEquals(await conn.queryCol("SELECT Count(*) FROM t_log").first(), 0);
				let error;
				try
				{	await conn.query("INSERT INTO t_log SET a = 123");
				}
				catch (e)
				{	error = e;
				}
				assert(error?.message.indexOf(`Cannot execute statement in a READ ONLY transaction`) >= 0);
				await conn.rollback();

				// xa when regular trx active (must commit)
				await conn.startTrx();
				assertEquals(await conn.queryCol("SELECT Count(*) FROM t_log").first(), 0);
				await conn.query("INSERT INTO t_log SET a = 123");
				error = undefined;
				try
				{	await conn.startTrx({xaId1: MY_XA_ID});
				}
				catch (e)
				{	error = e;
				}
				assert(!error);
				await conn.rollback();
				assertEquals(await conn.queryCol("SELECT Count(*) FROM t_log").first(), 1);
				res = await conn.query("DELETE FROM t_log");
				assertEquals(res.affectedRows, 1);

				// xa when another xa active (must commit)
				await conn.startTrx({xaId1: MY_XA_ID});
				error = undefined;
				try
				{	await conn.startTrx({xaId1: MY_XA_ID});
				}
				catch (e)
				{	error = e;
				}
				assert(!error);
				await conn.rollback();

				// xa
				await conn.startTrx({xaId1: MY_XA_ID});
				assertEquals(await conn.queryCol("SELECT Count(*) FROM t_log").first(), 0);
				await conn.query("INSERT INTO t_log SET a = 123");
				assertEquals(await conn.queryCol("SELECT Count(*) FROM t_log").first(), 1);
				error = undefined;
				try
				{	await conn.commit();
				}
				catch (e)
				{	error = e;
				}
				assertEquals(error?.message, `Please, prepare commit first`);
				await conn.prepareCommit();
				error = undefined;
				try
				{	await conn.queryCol("SELECT Count(*) FROM t_log").first();
				}
				catch (e)
				{	error = e;
				}
				assert(error);
				await conn.commit();
				assertEquals(await conn.queryCol("SELECT Count(*) FROM t_log").first(), 1);
				res = await conn.query("DELETE FROM t_log");
				assertEquals(res.affectedRows, 1);
				assertEquals(await conn.queryCol("SELECT Count(*) FROM t_log").first(), 0);
			}
		);

		// XA Info: create db
		await pool.forConn
		(	async conn =>
			{	await conn.query("DROP DATABASE IF EXISTS test38743");
				await conn.query("CREATE DATABASE `test38743`");
				await conn.query("DROP DATABASE IF EXISTS test2");
				await conn.query("CREATE DATABASE `test2`");
				await conn.query("USE test2");
				await conn.query("CREATE TABLE t_xa_info (xa_id char(40) PRIMARY KEY)");
				await conn.query("CREATE TABLE t_xa_info_sub (id integer PRIMARY KEY AUTO_INCREMENT, xa_id char(40), op enum('insert', 'delete'))");
				await conn.query("CREATE TRIGGER t1 AFTER INSERT ON t_xa_info FOR EACH ROW INSERT INTO t_xa_info_sub (xa_id, op) VALUES (NEW.xa_id, 'insert')");
				await conn.query("CREATE TRIGGER t2 AFTER DELETE ON t_xa_info FOR EACH ROW INSERT INTO t_xa_info_sub (xa_id, op) VALUES (OLD.xa_id, 'delete')");
			}
		);
		const xaInfoDsn = new Dsn(dsnStr);
		xaInfoDsn.schema = 'test2';
		pool.options({xaInfoTables: [{dsn: xaInfoDsn, table: 't_xa_info'}]});

		// XA Info: test
		await pool.session
		(	async session =>
			{	await session.startTrx({xa: true});
				const conn = session.conn();
				await conn.query("USE test58168");
				await conn.query("INSERT INTO t_log SET a = 123");
				await pool.forConn
				(	async conn2 =>
					{	assertEquals(await conn2.queryCol("SELECT Count(*) FROM test2.t_xa_info").first(), 0);
						assertEquals(await conn2.queryCol("SELECT Count(*) FROM test2.t_xa_info_sub").first(), 0);
					},
					xaInfoDsn
				);
				await session.commit();
				await pool.forConn
				(	async conn2 =>
					{	assertEquals(await conn2.queryCol("SELECT Count(*) FROM test2.t_xa_info").first(), 0);
						assertEquals(await conn2.queryArr("SELECT Count(*), Count(DISTINCT op) FROM test2.t_xa_info_sub").first(), [2, 2]);
					},
					xaInfoDsn
				);
				assertEquals(await conn.queryCol("SELECT Count(*) FROM t_log").first(), 1);
				const res = await conn.query("DELETE FROM t_log");
				assertEquals(res.affectedRows, 1);
				assertEquals(await conn.queryCol("SELECT Count(*) FROM t_log").first(), 0);
			}
		);

		// XA session
		const xaInfoDsn1 = new Dsn(dsnStr);
		xaInfoDsn1.schema = 'test58168';
		const xaInfoDsn2 = new Dsn(dsnStr);
		xaInfoDsn2.schema = 'test38743';
		await pool.session
		(	async session =>
			{	const conn2 = session.conn(xaInfoDsn2);
				assertEquals(await conn2.queryCol("SELECT Schema()").first(), 'test38743');
				await conn2.query("CREATE TABLE t_log LIKE test58168.t_log");

				// Start, insert, commit

				await session.startTrx({xa: true});

				const conn1 = session.conn(xaInfoDsn1);
				assertEquals(conn1.connectionId, 0);
				assertEquals(conn2.connectionId>0, true);
				assertEquals(conn1.inTrx, true); // startTrx() pends the transaction start till actual connection
				assertEquals(conn2.inTrx, true);
				assertEquals(conn1.inXa, true);
				assertEquals(conn2.inXa, true);
				assertEquals(conn1.xaId, '');
				assert(conn2.xaId != '');

				assertEquals(await conn1.queryCol("SELECT Schema()").first(), 'test58168');
				assertEquals(await conn1.queryCol("SELECT Count(*) FROM t_log").first(), 0);
				await conn1.query("INSERT INTO t_log SET a = 123");
				await conn2.query("INSERT INTO t_log SET a = 123");

				assertEquals(conn1.inXa, true);
				assertEquals(conn2.inXa, true);
				assert(conn1.xaId != '');
				assert(conn2.xaId != '');

				await session.commit();

				assertEquals(conn1.inTrx, false);
				assertEquals(conn2.inTrx, false);
				assertEquals(conn1.inXa, false);
				assertEquals(conn2.inXa, false);
				assertEquals(conn1.xaId, '');
				assertEquals(conn2.xaId, '');
				assertEquals(await conn1.queryCol("SELECT Count(*) FROM t_log").first(), 1);
				assertEquals(await conn2.queryCol("SELECT Count(*) FROM t_log").first(), 1);

				// Start delete, rollback

				await session.startTrx({xa: true});
				assertEquals(conn1.inTrx, true);
				assertEquals(conn2.inTrx, true);

				await conn1.query("DELETE FROM t_log");
				await conn2.query("DELETE FROM t_log");
				assertEquals(await conn1.queryCol("SELECT Count(*) FROM t_log").first(), 0);
				assertEquals(await conn2.queryCol("SELECT Count(*) FROM t_log").first(), 0);

				await session.rollback();
				assertEquals(await conn1.queryCol("SELECT Count(*) FROM t_log").first(), 1);
				assertEquals(await conn2.queryCol("SELECT Count(*) FROM t_log").first(), 1);

				// Start delete, break state, commit

				await session.startTrx({xa: true});
				assertEquals(conn1.inTrx, true);
				assertEquals(conn2.inTrx, true);

				await conn1.query("DELETE FROM t_log");
				await conn2.query("DELETE FROM t_log");
				assertEquals(await conn1.queryCol("SELECT Count(*) FROM t_log").first(), 0);
				assertEquals(await conn2.queryCol("SELECT Count(*) FROM t_log").first(), 0);

				await conn1.query(`XA END '${conn1.xaId}'`); // break state - after this commit will fail on conn1
				console.log('%cThe following exceptions must be ignored', 'color:blue');

				let error;
				try
				{	await session.commit();
				}
				catch (e)
				{	error = e;
				}
				console.error(error);
				assert(error);
				assertEquals(await conn1.queryCol("SELECT Count(*) FROM t_log").first(), 1);
				assertEquals(await conn2.queryCol("SELECT Count(*) FROM t_log").first(), 1);
			}
		);

		// Drop databases that i created
		await pool.forConn
		(	async conn =>
			{	await conn.query("DROP DATABASE test58168");
				await conn.query("DROP DATABASE test38743");
				await conn.query("DROP DATABASE test2");
			}
		);
	}
	finally
	{	await pool.shutdown();
	}
}

async function testLoadBigDump(dsnStr: string)
{	const dsn = new Dsn(dsnStr);
	dsn.maxColumnLen = Number.MAX_SAFE_INTEGER;
	const pool = new MyPool(dsn);
	try
	{	pool.forConn
		(	async conn =>
			{	// Createa and use db
				await conn.query("DROP DATABASE IF EXISTS test1");
				await conn.query("CREATE DATABASE `test1`");
				await conn.query("USE test1");

				// CREATE TABLE
				await conn.query("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, message longtext)");

				for (const readToMemory of [false, true])
				{	for (const SIZE of [100, 8*1024 + 100, 2**24 - 8, 2**24 + 8*1024 + 100])
					{	const maxAllowedPacket = Number(await conn.queryCol("SELECT @@max_allowed_packet").first());
						if (maxAllowedPacket < SIZE+100)
						{	let wantSize = SIZE + 100;
							let sizeRounded = 1;
							while (wantSize)
							{	wantSize >>= 1;
								sizeRounded <<= 1;
							}
							await conn.execute("SET GLOBAL max_allowed_packet = ?", [sizeRounded]);
							conn.end();
							assert(Number(await conn.queryCol("SELECT @@max_allowed_packet").first()) >= wantSize);
						}

						const filename = await Deno.makeTempFile();
						try
						{	const fh = await Deno.open(filename, {write: true, read: true});
							try
							{	// Write INSERT query to file
								await writeAll(fh, new TextEncoder().encode("INSERT INTO t_log SET message = '"));
								const buffer = new Uint8Array(8*1024);
								for (let i=0; i<buffer.length; i++)
								{	let c = i & 0x7F;
									if (c=="'".charCodeAt(0) || c=="\\".charCodeAt(0))
									{	c = 0;
									}
									buffer[i] = c;
								}
								let curSize = 0;
								for (let i=0; i<SIZE; i+=buffer.length)
								{	const len = Math.min(buffer.length, SIZE-curSize);
									await writeAll(fh, buffer.subarray(0, len));
									curSize += len;
								}
								assertEquals(curSize, SIZE);
								await writeAll(fh, new TextEncoder().encode("'"));

								// DELETE
								await conn.execute("DELETE FROM t_log");

								// Read INSERT from file
								let insertStatus: Resultsets<Any>|undefined;
								try
								{	if (!readToMemory)
									{	await fh.seek(0, Deno.SeekMode.Start);
										insertStatus = await conn.query(fh);
									}
									else
									{	const q = await Deno.readTextFile(filename);
										if (SIZE == 2**24 - 8)
										{	insertStatus = await conn.query(q);
										}
										else
										{	insertStatus = await conn.query(new TextEncoder().encode(q));
										}
									}
								}
								catch (e)
								{	if (e.message.indexOf('innodb_log_file_size') == -1)
									{	throw e;
									}
									console.warn('%cTest skipped: %c'+e.message, 'color:orange', 'color:inherit');
									return;
								}
								const recordId = insertStatus.lastInsertId;

								// SELECT Length()
								assertEquals(await conn.queryCol("SELECT Length(message) FROM t_log WHERE id="+recordId).first(), SIZE);

								const row = await conn.query("SELECT message, id FROM t_log WHERE id="+recordId, readToMemory ? undefined : []).first();
								assertEquals(typeof(row?.message)=='string' ? row.message.length : -1, SIZE);
								assertEquals(row?.id, recordId);

								// SELECT from table to new file
								const filename2 = await Deno.makeTempFile();
								try
								{	const fh2 = await Deno.open(filename2, {write: true, read: true});
									try
									{	const row = await conn.makeLastColumnReader("SELECT message FROM t_log WHERE id="+recordId);
										await copy(row?.message as Any, fh2);

										// Validate the new file size
										let size2 = await fh2.seek(0, Deno.SeekMode.End);
										assertEquals(size2, SIZE);
										await fh2.seek(0, Deno.SeekMode.Start);

										// Validate the new file contents
										const since = Date.now();
										console.log('Started validating');
										const buffer2 = new Uint8Array(buffer.length);
										while (size2 > 0)
										{	let pos = 0;
											const len = Math.min(buffer2.length, size2);
											while (pos < len)
											{	const n = await fh2.read(buffer2.subarray(pos, len));
												assert(n != null);
												pos += n;
											}

											assertEquals(buffer.subarray(0, len), buffer2.subarray(0, len));
											size2 -= len;
										}
										console.log(`Done validating in ${(Date.now()-since) / 1000} sec`);
									}
									finally
									{	fh2.close();
									}
								}
								finally
								{	await Deno.remove(filename2);
								}
							}
							finally
							{	fh.close();
							}
						}
						finally
						{	await Deno.remove(filename);
						}
					}
				}

				// Drop database that i created
				await conn.query("DROP DATABASE test1");
			}
		);
	}
	finally
	{	await pool.shutdown();
	}
}
