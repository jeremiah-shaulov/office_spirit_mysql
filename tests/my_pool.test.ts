import {CapabilityFlags, StatusFlags, PacketType, FieldType, Command, CursorType, Charset} from '../constants.ts';
import {Dsn} from '../dsn.ts';
import {MyPool} from '../my_pool.ts';
import {BusyError} from "../errors.ts";
import {assert, assertEquals} from "https://deno.land/std@0.97.0/testing/asserts.ts";

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
					assertEquals(conn.charset, Charset.UNKNOWN);
					assertEquals(conn.schema, '');

					await conn.connect();

					assert(parseFloat(conn.serverVersion) > 0);
					assert(conn.connectionId > 0);
					assertEquals(conn.inTrx, false);
					assertEquals(conn.inTrxReadonly, false);
					assert(conn.charset != Charset.UNKNOWN);
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

					await conn.execute("START TRANSACTION READ ONLY");
					assertEquals(conn.inTrx, true);
					assertEquals(conn.inTrxReadonly, true);
					await conn.execute("ROLLBACK");
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

					// CREATE TABLE
					await conn.query("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, `time` timestamp NOT NULL, message text)");

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

					// SELECT
					assertEquals(await conn.queryCol("SELECT message FROM t_log WHERE id=?", [3]).first(), 'Message 3');

					// SELECT
					assertEquals(await conn.queryCol("SELECT message FROM t_log WHERE id=@id", {id: 3, junk: '*'}).first(), 'Message 3');
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
								c_time timestamp NOT NULL
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
								c_bigint = 9,
								c_bigint_u = Pow(2, 63),
								c_float = 11.5,
								c_double = -12.25,
								c_text = 'Text',
								c_time = '2000-12-01';

							SELECT * FROM t1;
						`
					);

					assertEquals(res.columns.length, 0);
					assertEquals(await res.nextResultset(), true);

					assertEquals(res.columns.length, 0);
					assertEquals(await res.nextResultset(), true);

					assertEquals(res.columns.length, 0);
					assertEquals(await res.nextResultset(), true);

					assertEquals(res.columns.length, 0);
					assertEquals(await res.nextResultset(), true);

					assertEquals(res.columns.length, 0);
					assertEquals(await res.nextResultset(), true);

					assertEquals(res.columns.length, 16);
					assertEquals
					(	await res.first(),
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
							c_bigint: 9,
							c_bigint_u: 2n ** 63n,
							c_float: 11.5,
							c_double: -12.25,
							c_text: 'Text',
							c_time: new Date(2000, 11, 1)
						}
					);
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

					// CREATE TABLE
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
