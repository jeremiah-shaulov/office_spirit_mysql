import {Dsn} from '../dsn.ts';
import {MyPool} from '../my_pool.ts';
import {sql} from "../sql.ts";
import {BusyError, CanceledError} from "../errors.ts";
import {assert, assertEquals} from "https://deno.land/std@0.97.0/testing/asserts.ts";
import * as semver from "https://deno.land/x/semver@v1.4.0/mod.ts";
import {writeAll, readAll} from 'https://deno.land/std@0.97.0/io/util.ts';
import {Resultsets} from "../resultsets.ts";

const {DSN} = Deno.env.toObject();

Deno.test
(	'Basic',
	async () =>
	{	let dsn = new Dsn(DSN);
		let pool = new MyPool(DSN);

		try
		{	pool.forConn
			(	async (conn) =>
				{	assertEquals(conn.serverVersion, '');
					assertEquals(conn.connectionId, 0);
					assertEquals(conn.autocommit, false);
					assertEquals(conn.inTrx, false);
					assertEquals(conn.inTrxReadonly, false);
					assertEquals(conn.noBackslashEscapes, false);
					assertEquals(conn.schema, '');

					await conn.connect();

					assert(parseFloat(conn.serverVersion) > 0);
					assert(conn.connectionId > 0);
					assertEquals(conn.inTrx, false);
					assertEquals(conn.inTrxReadonly, false);
					assertEquals(conn.schema, dsn.schema);

					let conn_id = await conn.queryCol("SELECT Connection_id()").first();
					assertEquals(conn.connectionId, conn_id);

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

					if (semver.gte(conn.serverVersion.match(/^[\d\.]*/)?.[0] || '', '6.0.0')) // conn.serverVersion can be: 8.0.25-0ubuntu0.21.04.1
					{	await conn.execute("START TRANSACTION READ ONLY");
						assertEquals(conn.inTrx, true);
						assertEquals(conn.inTrxReadonly, true);
						await conn.execute("ROLLBACK");
						assertEquals(conn.inTrx, false);
						assertEquals(conn.inTrxReadonly, false);
					}

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

					// CREATE TABLE
					await conn.query("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, `time` timestamp(3) NOT NULL, message text)");

					// INSERT
					let now = Date.now();
					now -= now % 1000;
					await conn.forQuery
					(	"INSERT INTO t_log SET `time`=?, message=?",
						async (prepared) =>
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
					let rows: Record<string, any>[] = [];
					let the_hello = await conn.query("SELECT * FROM t_log").forEach
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
					assertEquals(the_hello, 'hello');

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
					let rows2 = await conn.queryMap("SELECT * FROM t_log").all()
					assertEquals
					(	rows2,
						[	new Map(Object.entries({id: 1, time: new Date(now+1000), message: 'Message 1'})),
							new Map(Object.entries({id: 2, time: new Date(now+2000), message: 'Message 2'})),
							new Map(Object.entries({id: 3, time: new Date(now+3000), message: 'Message 3'})),
							new Map(Object.entries({id: 4, time: new Date(now+4000), message: 'Message 4'})),
						]
					);

					// queryArr
					let rows3 = await conn.queryArr("SELECT id, `time`, message FROM t_log").all()
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
					let res2 = await conn.query("SELECT * FROM t_log");
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
					let value = 'Message 3';
					assertEquals(await conn.queryCol(sql`SELECT id FROM t_log WHERE message='${value}'`).first(), 3);

					// INSERT, SELECT
					value = 'абвгдежзиклмнопрстуфхцчшщъыьэюя '.repeat(10); // many 2-byte utf-8 chars cause buffer of guessed size to reallocate
					res = await conn.execute(sql`INSERT INTO t_log SET "${'time'}"='${new Date(now+5000)}', message='${value}'`);
					assertEquals(res.lastInsertId, 5);
					assertEquals(res.affectedRows, 1);
					assertEquals(await conn.query(sql`SELECT \`${'time'}\`, message FROM t_log WHERE id=5`).first(), {time: new Date(now+5000), message: value});

					for (let id of [6, 7])
					{	let filename = await Deno.makeTempFile();
						try
						{	let fh = await Deno.open(filename, {write: true, read: true});
							try
							{	await writeAll(fh, new TextEncoder().encode(id==6 ? '' : 'Message '+id));
								await fh.seek(0, Deno.SeekMode.Start);
								res = await conn.execute("INSERT INTO t_log SET `time`=?, message=?", [new Date(now+id*1000), fh]);
								assertEquals(res.lastInsertId, id);
								assertEquals(res.affectedRows, 1);
								assertEquals(await conn.query(sql`SELECT \`${'time'}\`, message FROM t_log WHERE id='${id}'`).first(), {time: new Date(now+id*1000), message: id==6 ? '' : 'Message '+id});
							}
							finally
							{	fh.close();
							}
						}
						finally
						{	await Deno.remove(filename);
						}
					}

					res = await conn.execute("INSERT INTO t_log SET `time`=?, message=?", [new Date(now+8000), new TextEncoder().encode('Message 8')]);
					assertEquals(res.lastInsertId, 8);
					assertEquals(res.affectedRows, 1);
					assertEquals(await conn.query(sql`SELECT \`${'time'}\`, message FROM t_log WHERE id=8`).first(), {time: new Date(now+8000), message: 'Message 8'});

					res = await conn.execute("INSERT INTO t_log SET `time`=?, message=?", [new Date(now+9000), new Uint16Array(new TextEncoder().encode('Message 9*').buffer)]);
					assertEquals(res.lastInsertId, 9);
					assertEquals(res.affectedRows, 1);
					assertEquals(await conn.query(sql`SELECT \`${'time'}\`, message FROM t_log WHERE id=9`).first(), {time: new Date(now+9000), message: 'Message 9*'});

					res = await conn.execute("INSERT INTO t_log SET `time`=?, message=?", [new Date(now+10000), {value: 'Message 10'}]);
					assertEquals(res.lastInsertId, 10);
					assertEquals(res.affectedRows, 1);
					assertEquals(await conn.query(sql`SELECT \`${'time'}\`, message FROM t_log WHERE id=10`).first(), {time: new Date(now+10000), message: JSON.stringify({value: 'Message 10'})});

					res = await conn.execute("INSERT INTO t_log SET `time`=?, message=?", [new Date(now+11001), new TextEncoder().encode('-')]);
					assertEquals(res.lastInsertId, 11);
					assertEquals(res.affectedRows, 1);
					assertEquals(await conn.query("SELECT `time`, message FROM t_log WHERE id=?", [11]).first(), {time: new Date(now+11001), message: '-'});

					res = await conn.execute("INSERT INTO t_log SET `time`=?, message=?", [new Date(now+12001), new Uint16Array(new TextEncoder().encode('--').buffer)]);
					assertEquals(res.lastInsertId, 12);
					assertEquals(res.affectedRows, 1);
					assertEquals(await conn.query("SELECT `time`, message FROM t_log WHERE id=?", [12]).first(), {time: new Date(now+12001), message: '--'});

					res = await conn.execute("INSERT INTO t_log SET `time`=?, message=?", [new Date(now+13000), 123n]);
					assertEquals(res.lastInsertId, 13);
					assertEquals(res.affectedRows, 1);
					assertEquals(await conn.query("SELECT `time`, message FROM t_log WHERE id=?", [13]).first(), {time: new Date(now+13000), message: '123'});

					res = await conn.execute("INSERT INTO t_log SET `time`=?, message=?", [new Date(now+14000), null]);
					assertEquals(res.lastInsertId, 14);
					assertEquals(res.affectedRows, 1);
					assertEquals(await conn.query("SELECT `time`, message FROM t_log WHERE id=?", [14]).first(), {time: new Date(now+14000), message: null});

					res = await conn.execute("INSERT INTO t_log SET `time`=?, message=?", [new Date(now+15000), undefined]);
					assertEquals(res.lastInsertId, 15);
					assertEquals(res.affectedRows, 1);
					assertEquals(await conn.query("SELECT `time`, message FROM t_log WHERE id=?", [15]).first(), {time: new Date(now+15000), message: null});

					res = await conn.execute("INSERT INTO t_log SET `time`=?, message=?", [new Date(now+16000), () => {}]);
					assertEquals(res.lastInsertId, 16);
					assertEquals(res.affectedRows, 1);
					assertEquals(await conn.query("SELECT `time`, message FROM t_log WHERE id=?", [16]).first(), {time: new Date(now+16000), message: null});

					res = await conn.execute("INSERT INTO t_log SET `time`=?, message=?", [new Date(now+17000), Symbol.iterator]);
					assertEquals(res.lastInsertId, 17);
					assertEquals(res.affectedRows, 1);
					assertEquals(await conn.query("SELECT `time`, message FROM t_log WHERE id=?", [17]).first(), {time: new Date(now+17000), message: null});

					res = await conn.execute("INSERT INTO t_log SET `time`=?, message=?", [new Date(now+18000), false]);
					assertEquals(res.lastInsertId, 18);
					assertEquals(res.affectedRows, 1);
					assertEquals(await conn.query("SELECT `time`, message FROM t_log WHERE id=?", [18]).first(), {time: new Date(now+18000), message: '0'});

					res = await conn.execute("INSERT INTO t_log SET `time`=?, message=?", [new Date(now+19000), true]);
					assertEquals(res.lastInsertId, 19);
					assertEquals(res.affectedRows, 1);
					assertEquals(await conn.query("SELECT `time`, message FROM t_log WHERE id=?", [19]).first(), {time: new Date(now+19000), message: '1'});

					res = await conn.execute("INSERT INTO t_log SET `time`=?, message=?", [new Date(now+20000), 123.5]);
					assertEquals(res.lastInsertId, 20);
					assertEquals(res.affectedRows, 1);
					assertEquals(await conn.query("SELECT `time`, message FROM t_log WHERE id=?", [20]).first(), {time: new Date(now+20000), message: '123.5'});
				}
			);
		}
		finally
		{	await pool.onEnd();
			pool.closeIdle();
		}
	}
);

Deno.test
(	'Prepared',
	async () =>
	{	const N_ROWS = 3;
		let pool = new MyPool(DSN);

		try
		{	pool.forConn
			(	async (conn) =>
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
						async (prepared) =>
						{	for (let i=1; i<=N_ROWS; i++)
							{	await prepared.exec([new Date(now+i*1000), 'Message '+i]);
							}
						}
					);

					// SELECT no read at end
					await conn.forQuery
					(	"SELECT * FROM t_log WHERE id=?",
						async (prepared) =>
						{	await prepared.exec([1]);
							assertEquals(prepared.columns.length, 3);
						}
					);

					// SELECT
					await conn.forQuery
					(	"SELECT * FROM t_log WHERE id=?",
						async (prepared) =>
						{	for (let i=1; i<=N_ROWS; i++)
							{	await prepared.exec([i]);
								for await (let row of prepared)
								{	assertEquals(row, {id: i, time: new Date(now+i*1000), message: 'Message '+i});
								}
							}
						}
					);

					// SELECT call end()
					let error: Error|undefined;
					await conn.forQuery
					(	"SELECT * FROM t_log WHERE id=?",
						async (prepared) =>
						{	await prepared.exec([1]);
							assertEquals(prepared.columns.length, 3);
							conn.end();
							try
							{	await prepared.exec([2]);
							}
							catch (e)
							{	error = e;
							}
						}
					);
					assert(error instanceof BusyError);
				}
			);
		}
		finally
		{	await pool.onEnd();
			pool.closeIdle();
		}
	}
);

Deno.test
(	'Various column types',
	async () =>
	{	let dsn = new Dsn(DSN);
		dsn.multiStatements = true;
		let pool = new MyPool(dsn);

		try
		{	pool.forConn
			(	async (conn) =>
				{	// CREATE TABLE
					let res = await conn.query
					(	`	DROP DATABASE IF EXISTS test1;
							CREATE DATABASE test1 /*!40100 CHARSET latin1 COLLATE latin1_general_ci*/;
							USE test1;

							CREATE TEMPORARY TABLE t1
							(	id integer PRIMARY KEY AUTO_INCREMENT,
								c_null text,
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
								c_text text NOT NULL,
								c_tinyblob tinyblob,
								/*!50708 c_json json,*/
								c_timestamp timestamp NOT NULL,
								c_date date NOT NULL,
								c_datetime datetime NOT NULL
							);

							INSERT INTO t1 SET
								c_null = NULL,
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
								c_text = 'Text',
								c_tinyblob = x'01020304',
								/*!50708 c_json = Json_object('a', 1, 'b', 2),*/
								c_timestamp = '2000-12-01 01:02:03',
								c_date = '2000-12-02',
								c_datetime = '2000-12-01 01:02:03';

							SELECT * FROM t1;
						`
					);

					assertEquals(res.columns.length, 0);
					assertEquals(res.hasMore, true);
					assertEquals(res.all(), []);
					assertEquals(res.hasMore, true);
					assertEquals(await res.nextResultset(), true);

					assertEquals(res.columns.length, 0);
					assertEquals(res.hasMore, true);
					assertEquals(res.first(), []);
					assertEquals(res.hasMore, true);
					assertEquals(await res.nextResultset(), true);

					assertEquals(res.columns.length, 0);
					assertEquals(res.hasMore, true);
					assertEquals(res.first(), []);
					assertEquals(res.hasMore, true);
					assertEquals(await res.nextResultset(), true);

					assertEquals(res.columns.length, 0);
					assertEquals(res.hasMore, true);
					assertEquals(res.first(), []);
					assertEquals(res.hasMore, true);
					assertEquals(await res.nextResultset(), true);

					assertEquals(res.columns.length, 0);
					assertEquals(res.hasMore, true);
					assertEquals(res.first(), []);
					assertEquals(res.hasMore, true);
					assertEquals(await res.nextResultset(), true);

					let expected_row: Record<string, any> =
					{	id: 1,
						c_null: null,
						c_tinyint: 1,
						c_tinyint_u: 2,
						c_smallint: -3,
						c_smallint_u: 4,
						c_mediumint: 5,
						c_mediumint_u: 6,
						c_int: 7,
						c_int_u: 8,
						c_bigint: -9007199254740991,
						c_bigint_u: 2n ** 63n,
						c_float: 11.5,
						c_double: -12.25,
						c_text: 'Text',
						c_tinyblob: '\x01\x02\x03\x04',
						c_timestamp: new Date(2000, 11, 1, 1, 2, 3),
						c_date: new Date(2000, 11, 2),
						c_datetime: new Date(2000, 11, 1, 1, 2, 3)
					};
					if (semver.gte(conn.serverVersion.match(/^[\d\.]*/)?.[0] || '', '5.7.8'))
					{	expected_row.c_json = {a: 1, b: 2};
					}
					assertEquals(res.columns.length, Object.keys(expected_row).length);
					assertEquals(res.hasMore, true);
					assertEquals(await res.first(), expected_row);
					assertEquals(res.hasMore, false);
					assertEquals(await res.nextResultset(), false);
					assertEquals(await res.nextResultset(), false);
					assertEquals(await res.nextResultset(), false);
				}
			);
		}
		finally
		{	await pool.onEnd();
			pool.closeIdle();
		}
	}
);

Deno.test
(	'SQL Error',
	async () =>
	{	let pool = new MyPool(DSN);

		try
		{	pool.forConn
			(	async (conn) =>
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
				}
			);
		}
		finally
		{	await pool.onEnd();
			pool.closeIdle();
		}
	}
);

Deno.test
(	'noBackslashEscapes',
	async () =>
	{	let pool = new MyPool(DSN);

		try
		{	pool.forConn
			(	async (conn) =>
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
		{	await pool.onEnd();
			pool.closeIdle();
		}
	}
);

Deno.test
(	'initSql',
	async () =>
	{	let dsn = new Dsn(DSN);
		dsn.initSql = "SET @hello='all'";
		let pool = new MyPool(dsn);

		try
		{	pool.forConn
			(	async (conn) =>
				{	let value = await conn.queryCol("SELECT @hello").first();
					if (value instanceof Uint8Array)
					{	value = new TextDecoder().decode(value);
					}
					assertEquals(value, 'all');
				}
			);
		}
		finally
		{	await pool.onEnd();
			pool.closeIdle();
		}

		dsn.initSql = "SELECT @myvar:='my value'";
		pool = new MyPool(dsn);

		try
		{	pool.forConn
			(	async (conn) =>
				{	let value = await conn.queryCol("SELECT @myvar").first();
					if (value instanceof Uint8Array)
					{	value = new TextDecoder().decode(value);
					}
					assertEquals(value, 'my value');
				}
			);
		}
		finally
		{	await pool.onEnd();
			pool.closeIdle();
		}
	}
);

Deno.test
(	'Busy state',
	async () =>
	{	let pool = new MyPool(DSN);

		try
		{	pool.forConn
			(	async (conn) =>
				{	// CREATE DATABASE
					await conn.query("DROP DATABASE IF EXISTS test1");
					await conn.query("CREATE DATABASE `test1`");
					await conn.query("USE test1");
					await conn.query("SET autocommit=1");

					// CREATE TABLE
					await conn.query("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, `time` timestamp NOT NULL, message text)");

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

					let promise = conn.execute("INSERT INTO t_log SET `time`=Now(), message='Message 1'");
					conn.end();
					error = undefined;
					try
					{	await promise; // cannot get Resultsets, because end() routine reads and discards it before returning the connection to the pool
					}
					catch (e)
					{	error = e;
					}
					assertEquals(error instanceof CanceledError, true);

					// previous query must be executed completely, although it's resultsets cancelled
					value = conn.queryCol("SELECT message FROM t_log WHERE id=1").first();
					assertEquals(await value, 'Message 1');
				}
			);
		}
		finally
		{	await pool.onEnd();
			pool.closeIdle();
		}
	}
);

Deno.test
(	'Sessions',
	async () =>
	{	let pool = new MyPool(DSN);
		let dsn2 = new Dsn(DSN);
		dsn2.keepAliveMax = 10;

		try
		{	pool.session
			(	async (session) =>
				{	let conn_1 = session.conn(); // default DSN
					let conn_2 = session.conn(); // the same object
					let conn_3 = session.conn(undefined, true); // another connection to default DSN
					let conn_4 = session.conn(dsn2); // connection to different DSN

					assert(conn_1 === conn_2);
					assert(conn_2 !== conn_3);
					assert(conn_2 !== conn_4);
					assert(conn_3 !== conn_4);

					let conn_id_2_promise = conn_2.queryCol("SELECT Connection_id()").first();
					let conn_id_3_promise = conn_3.queryCol("SELECT Connection_id()").first();
					let conn_id_4_promise = conn_4.queryCol("SELECT Connection_id()").first();

					let [conn_id_2, conn_id_3, conn_id_4] = await Promise.all([conn_id_2_promise, conn_id_3_promise, conn_id_4_promise]);
					assert(conn_id_2!=conn_id_3 && conn_id_3!=conn_id_4);
				}
			);
		}
		finally
		{	await pool.onEnd();
			pool.closeIdle();
		}
	}
);

Deno.test
(	'Pool DSN',
	async () =>
	{	let pool = new MyPool;

		try
		{	pool.session
			(	async (session) =>
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
		{	await pool.onEnd();
			pool.closeIdle();
		}
	}
);

Deno.test
(	'Load big dump',
	async () =>
	{	let dsn = new Dsn(DSN);
		dsn.maxColumnLen = Number.MAX_SAFE_INTEGER;
		let pool = new MyPool(dsn);
		try
		{	pool.forConn
			(	async (conn) =>
				{	// Createa and use db
					await conn.query("DROP DATABASE IF EXISTS test1");
					await conn.query("CREATE DATABASE `test1`");
					await conn.query("USE test1");

					// CREATE TABLE
					await conn.query("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, message longtext)");

					for (let read_to_memory of [false, true])
					{	for (let SIZE of [100, 8*1024 + 100, 2**24 - 8, 2**24 + 8*1024 + 100])
						{	let max_allowed_packet = Number(await conn.queryCol("SELECT @@max_allowed_packet").first());
							if (max_allowed_packet < SIZE+100)
							{	let want_size = SIZE + 100;
								let size_rounded = 1;
								while (want_size)
								{	want_size >>= 1;
									size_rounded <<= 1;
								}
								await conn.execute("SET GLOBAL max_allowed_packet = ?", [size_rounded]);
								conn.end();
								assert(Number(await conn.queryCol("SELECT @@max_allowed_packet").first()) >= want_size);
							}

							let filename = await Deno.makeTempFile();
							try
							{	let fh = await Deno.open(filename, {write: true, read: true});
								try
								{	// Write INSERT query to file
									await writeAll(fh, new TextEncoder().encode("INSERT INTO t_log SET message = '"));
									let buffer = new Uint8Array(8*1024);
									for (let i=0; i<buffer.length; i++)
									{	let c = i & 0x7F;
										if (c=="'".charCodeAt(0) || c=="\\".charCodeAt(0))
										{	c = 0;
										}
										buffer[i] = c;
									}
									let cur_size = 0;
									for (let i=0; i<SIZE; i+=buffer.length)
									{	let len = Math.min(buffer.length, SIZE-cur_size);
										await writeAll(fh, buffer.subarray(0, len));
										cur_size += len;
									}
									assertEquals(cur_size, SIZE);
									await writeAll(fh, new TextEncoder().encode("'"));

									// DELETE
									await conn.execute("DELETE FROM t_log");

									// Read INSERT from file
									let insert_status: Resultsets<any>|undefined;
									try
									{	if (!read_to_memory)
										{	await fh.seek(0, Deno.SeekMode.Start);
											insert_status = await conn.query(fh);
										}
										else
										{	insert_status = await conn.query(await Deno.readTextFile(filename));
										}
									}
									catch (e)
									{	if (e.message.indexOf('innodb_log_file_size') == -1)
										{	throw e;
										}
										console.warn('%cTest skipped: %c'+e.message, 'color:orange', 'color:inherit');
										return;
									}
									let record_id = insert_status.lastInsertId;

									// SELECT Length()
									assertEquals(await conn.queryCol("SELECT Length(message) FROM t_log WHERE id="+record_id).first(), SIZE);

									let row = await conn.query("SELECT message, id FROM t_log WHERE id="+record_id, read_to_memory ? undefined : []).first();
									assertEquals(typeof(row?.message)=='string' ? row.message.length : -1, SIZE);
									assertEquals(row?.id, record_id);

									// SELECT from table to new file
									let filename_2 = await Deno.makeTempFile();
									try
									{	let fh_2 = await Deno.open(filename_2, {write: true, read: true});
										try
										{	let row = await conn.makeLastColumnReader("SELECT message FROM t_log WHERE id="+record_id);
											await Deno.copy(row?.message as any, fh_2);

											// Validate the new file size
											let size_2 = await fh_2.seek(0, Deno.SeekMode.End);
											assertEquals(size_2, SIZE);
											await fh_2.seek(0, Deno.SeekMode.Start);

											// Validate the new file contents
											let since = Date.now();
											console.log('Started validating');
											let buffer_2 = new Uint8Array(buffer.length);
											while (size_2 > 0)
											{	let pos = 0;
												let len = Math.min(buffer_2.length, size_2);
												while (pos < len)
												{	let n = await fh_2.read(buffer_2.subarray(pos, len));
													assert(n != null);
													pos += n;
												}

												assertEquals(buffer.subarray(0, len), buffer_2.subarray(0, len));
												size_2 -= len;
											}
											console.log(`Done validating in ${(Date.now()-since) / 1000} sec`);
										}
										finally
										{	fh_2.close();
										}
									}
									finally
									{	await Deno.remove(filename_2);
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
				}
			);
		}
		finally
		{	await pool.onEnd();
			pool.closeIdle();
		}
	}
);

Deno.test
(	'Many placeholders',
	async () =>
	{	let pool = new MyPool(DSN);

		try
		{	pool.forConn
			(	async (conn) =>
				{	// CREATE DATABASE
					await conn.query("DROP DATABASE IF EXISTS test1");
					await conn.query("CREATE DATABASE `test1`");

					// USE
					await conn.query("USE test1");

					// CREATE TABLE
					await conn.query("CREATE TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, a int, b int, c int, d int, e int, f int, g int, h int)");

					const N_ROWS = 8*1024-1;
					let q = `INSERT INTO t_log (a, b, c, d, e, f, g, h) VALUES ` + `(?, ?, ?, ?, ?, ?, ?, ?), `.repeat(N_ROWS).slice(0, -2);
					let params = [];
					for (let r=0; r<N_ROWS; r++)
					{	for (let c=0; c<8; c++)
						{	params.push(params.length + 1);
						}
					}

					let res = await conn.execute(q, params);
					assertEquals(res.affectedRows, 8191);
					assertEquals(res.placeholders.length, N_ROWS*8);
				}
			);
		}
		finally
		{	await pool.onEnd();
			pool.closeIdle();
		}
	}
);
