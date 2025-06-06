import {Dsn} from '../dsn.ts';
import {ErrorCodes} from "../constants.ts";
import {MyPool} from '../my_pool.ts';
import {Resultsets} from '../resultsets.ts';
import {BusyError, CanceledError, SqlError} from '../errors.ts';
import {testWithDocker} from "./test_with_docker.ts";
import {RdStream} from '../deps.ts';
import {Reader, Seeker} from '../deno_ifaces.ts';
import {assert} from 'jsr:@std/assert@1.0.7/assert';
import {assertEquals} from 'jsr:@std/assert@1.0.7/equals';
import {ColumnValue} from '../../mod.ts';

const encoder = new TextEncoder;

// deno-lint-ignore no-explicit-any
type Any = any;

testWithDocker
(	[	testBasic,
		testNoDsn,
		testSerializeRows,
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
		testReuseConnections,
		testTrx,
		testRetryQueryTimes,
		testMaxConns,
		testLoadBigDump,
		testLoadFile,
		testMultiStatements,
		testBindBigParam,
		testForceImmediateDisconnect,
	]
);

class SqlSelectGenerator
{	has_put_params_to = false;
	buffer_size = -1;

	constructor(private table: string, private column: string, private value: unknown)
	{
	}

	toSqlBytesWithParamsBackslashAndBuffer(putParamsTo: unknown[]|undefined, _noBackslashEscapes: boolean, buffer: Uint8Array)
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

async function readAll(reader: Reader)
{	const BUFFER_SIZE = 8*1024;
	let buffer = new Uint8Array(BUFFER_SIZE);
	let pos = 0;
	while (true)
	{	const n = await reader.read(buffer.subarray(pos));
		if (!n)
		{	return buffer.subarray(0, pos);
		}
		pos += n;
		if (pos+BUFFER_SIZE > buffer.length)
		{	const buffer2 = new Uint8Array(buffer.length*2);
			buffer2.set(buffer);
			buffer = buffer2;
		}
	}
}

async function testBasic(dsnStr: string)
{	const dsn = new Dsn(dsnStr);
	await using pool = new MyPool(dsnStr);

	pool.forConn
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

			await conn.queryVoid("SET autocommit=1");
			assertEquals(conn.autocommit, true);
			await conn.queryVoid("SET autocommit=0");
			assertEquals(conn.autocommit, false);
			await conn.queryVoid("SET autocommit=1");

			await conn.queryVoid("START TRANSACTION");
			assertEquals(conn.inTrx, true);
			assertEquals(conn.inTrxReadonly, false);
			await conn.queryVoid("ROLLBACK");
			assertEquals(conn.inTrx, false);
			assertEquals(conn.inTrxReadonly, false);

			await conn.queryVoid("SET autocommit=0");
			assertEquals(conn.inTrx, false);
			await conn.queryVoid("START TRANSACTION");
			assertEquals(conn.inTrx, true);
			assertEquals(conn.inTrxReadonly, false);
			await conn.queryVoid("ROLLBACK");
			assertEquals(conn.inTrx, false);
			assertEquals(conn.inTrxReadonly, false);
			await conn.queryVoid("SET autocommit=1");
			assertEquals(conn.inTrx, false);
			assertEquals(conn.inTrxReadonly, false);

			if (parseFloat(conn.serverVersion) >= 6.0) // conn.serverVersion can be: 8.0.25-0ubuntu0.21.04.1
			{	await conn.queryVoid("START TRANSACTION READ ONLY");
				assertEquals(conn.inTrx, true);
				assertEquals(conn.inTrxReadonly, true);
				await conn.queryVoid("ROLLBACK");
				assertEquals(conn.inTrx, false);
				assertEquals(conn.inTrxReadonly, false);
			}

			await conn.queryVoid("XA START 'a'");
			assertEquals(conn.inTrx, true);
			assertEquals(conn.inTrxReadonly, false);
			await conn.queryVoid("XA END 'a'");
			await conn.queryVoid("XA ROLLBACK 'a'");
			assertEquals(conn.inTrx, false);
			assertEquals(conn.inTrxReadonly, false);

			// CREATE DATABASE
			await conn.query("DROP DATABASE IF EXISTS test1");
			await conn.query("DROP DATABASE IF EXISTS test2");
			await conn.query("CREATE DATABASE `test1` /*!40100 CHARSET latin1 COLLATE latin1_general_ci*/");
			await conn.query("CREATE DATABASE `test2` /*!40100 CHARSET utf8mb4 COLLATE utf8mb4_unicode_ci*/");

			// Timezone
			await conn.query("SET time_zone = 'SYSTEM'");

			// Check schema change
			await conn.query("USE test1");
			assert(!conn.schema || conn.schema=='test1');
			await conn.query("USE test2");
			assert(!conn.schema || conn.schema=='test2');

			// Check simple query
			assertEquals(await conn.queryCol("SELECT 123").first(), 123);

			// Check query with params
			assertEquals(Number(await conn.queryCol("SELECT ?", [123]).first()), 123); // can return bigint

			// CREATE TABLE
			await conn.query("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, `time` timestamp(3) NOT NULL, message text)");

			// INSERT
			let now = Date.now();
			now -= now % 1000;
			await conn.forPrepared
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
			let res = await conn.queryVoid("INSERT INTO t_log SET `time`=?, message=?", [new Date(now+4000), 'Message 4']);
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
			let rows = new Array<Record<string, unknown>>;
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
			{	const row = await conn.makeLastColumnReader("SELECT * FROM t_log WHERE id=2");
				const message = row?.message;
				assert(message && typeof(message)=='object' && 'read' in message && typeof(message.read)=='function');
				assertEquals(new TextDecoder().decode(await readAll(message as Any)), 'Message 2');
			}

			// makeLastColumnReader - binary protocol
			{	const row = await conn.makeLastColumnReader("SELECT * FROM t_log WHERE id=?", [3]);
				const message = row?.message;
				assert(message && typeof(message)=='object' && 'read' in message && typeof(message.read)=='function');
				assertEquals(new TextDecoder().decode(await readAll(message as Any)), 'Message 3');
			}

			// makeLastColumnReadable - text protocol
			{	const row = await conn.makeLastColumnReadable("SELECT * FROM t_log WHERE id=2");
				const message = row?.message;
				assert(message instanceof RdStream);
				assertEquals(await message.text(), 'Message 2');
			}

			// makeLastColumnReadable - binary protocol
			{	const row = await conn.makeLastColumnReadable("SELECT * FROM t_log WHERE id=?", [3]);
				const message = row?.message;
				assert(message instanceof RdStream);
				assertEquals(await message.text(), 'Message 3');
			}

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
			assertEquals(await (await conn.queryCol("SELECT message FROM t_log", {})).first(), 'Message 1');

			// SELECT
			assertEquals(await (await conn.queryCol("SELECT message FROM t_log", [])).all(), ['Message 1', 'Message 2', 'Message 3', 'Message 4']);

			// SELECT
			assertEquals(await conn.queryCol("SELECT message FROM t_log WHERE id=?", [3]).first(), 'Message 3');

			// SELECT
			assertEquals(await conn.queryCol("SELECT message FROM t_log WHERE id=@id", {id: 3, junk: '*'}).first(), 'Message 3');

			// SELECT
			assertEquals(await conn.queryCol("SELECT message FROM t_log WHERE id=@id", {id: 3, j1: 0, j2: 0, j3: 0, j4: 0, j5: 0, j6: 0, j7: 0, j8: 0}).first(), 'Message 3');

			// SELECT
			const value = 'Message 3';
			let gen = new SqlSelectGenerator('t_log', 'message', value);
			assertEquals(await conn.queryCol(gen).first(), 3);
			assertEquals(gen.has_put_params_to, false);

			for (const id of [5, 6])
			{	const filename = await Deno.makeTempFile();
				try
				{	using fh = await Deno.open(filename, {write: true, read: true});
					const writer = fh.writable.getWriter();
					try
					{	await writer.write(new TextEncoder().encode(id==6 ? '' : 'Message '+id));
						await fh.seek(0, Deno.SeekMode.Start);
						res = await conn.queryVoid("INSERT INTO t_log SET `time`=?, message=?", [new Date(now+id*1000), fh]);
						assertEquals(res.lastInsertId, id);
						assertEquals(res.affectedRows, 1);
						const gen = new SqlSelectGenerator('t_log', 'id', id);
						assertEquals(await conn.query(gen).first(), {id, time: new Date(now+id*1000), message: id==6 ? '' : 'Message '+id});
					}
					finally
					{	writer.releaseLock();
					}
				}
				finally
				{	await Deno.remove(filename);
				}
			}

			res = await conn.queryVoid("INSERT INTO t_log SET `time`=?, message=?", [new Date(now+7000), new TextEncoder().encode('Message 7')]);
			assertEquals(res.lastInsertId, 7);
			assertEquals(res.affectedRows, 1);
			gen = new SqlSelectGenerator('t_log', 'id', 7);
			assertEquals(await conn.query(gen, []).first(), {id: 7, time: new Date(now+7000), message: 'Message 7'});
			assertEquals(gen.has_put_params_to, true);

			res = await conn.queryVoid("INSERT INTO t_log SET `time`=?, message=?", [new Date(now+8000), new Uint16Array(new TextEncoder().encode('Message 8*').buffer)]);
			assertEquals(res.lastInsertId, 8);
			assertEquals(res.affectedRows, 1);
			gen = new SqlSelectGenerator('t_log', 'id', 8);
			assertEquals(await conn.query(gen).first(), {id: 8, time: new Date(now+8000), message: 'Message 8*'});
			assertEquals(gen.has_put_params_to, false);

			res = await conn.queryVoid("INSERT INTO t_log SET `time`=?, message=?", [new Date(now+9000), {value: 'Message 9'}]);
			assertEquals(res.lastInsertId, 9);
			assertEquals(res.affectedRows, 1);
			gen = new SqlSelectGenerator('t_log', 'id', 9);
			assertEquals(await conn.query(gen).first(), {id: 9, time: new Date(now+9000), message: JSON.stringify({value: 'Message 9'})});

			res = await conn.queryVoid("INSERT INTO t_log SET `time`=?, message=?", [new Date(now+10001), new TextEncoder().encode('-')]);
			assertEquals(res.lastInsertId, 10);
			assertEquals(res.affectedRows, 1);
			assertEquals(await conn.query("SELECT `time`, message FROM t_log WHERE id=?", [10]).first(), {time: new Date(now+10001), message: '-'});

			res = await conn.queryVoid("INSERT INTO t_log SET `time`=?, message=?", [new Date(now+11001), new Uint16Array(new TextEncoder().encode('--').buffer)]);
			assertEquals(res.lastInsertId, 11);
			assertEquals(res.affectedRows, 1);
			assertEquals(await conn.query("SELECT `time`, message FROM t_log WHERE id=?", [11]).first(), {time: new Date(now+11001), message: '--'});

			res = await conn.queryVoid("INSERT INTO t_log SET `time`=?, message=?", [new Date(now+12000), 123n]);
			assertEquals(res.lastInsertId, 12);
			assertEquals(res.affectedRows, 1);
			assertEquals(await conn.query("SELECT `time`, message FROM t_log WHERE id=?", [12]).first(), {time: new Date(now+12000), message: '123'});

			res = await conn.queryVoid("INSERT INTO t_log SET `time`=?, message=?", [new Date(now+13000), null]);
			assertEquals(res.lastInsertId, 13);
			assertEquals(res.affectedRows, 1);
			assertEquals(await conn.query("SELECT `time`, message FROM t_log WHERE id=?", [13]).first(), {time: new Date(now+13000), message: null});

			res = await conn.queryVoid("INSERT INTO t_log SET `time`=?, message=?", [new Date(now+14000), undefined]);
			assertEquals(res.lastInsertId, 14);
			assertEquals(res.affectedRows, 1);
			assertEquals(await conn.query("SELECT `time`, message FROM t_log WHERE id=?", [14]).first(), {time: new Date(now+14000), message: null});

			res = await conn.queryVoid("INSERT INTO t_log SET `time`=?, message=?", [new Date(now+15000), () => {}]);
			assertEquals(res.lastInsertId, 15);
			assertEquals(res.affectedRows, 1);
			assertEquals(await conn.query("SELECT `time`, message FROM t_log WHERE id=?", [15]).first(), {time: new Date(now+15000), message: null});

			res = await conn.queryVoid("INSERT INTO t_log SET `time`=?, message=?", [new Date(now+16000), Symbol.iterator]);
			assertEquals(res.lastInsertId, 16);
			assertEquals(res.affectedRows, 1);
			assertEquals(await conn.query("SELECT `time`, message FROM t_log WHERE id=?", [16]).first(), {time: new Date(now+16000), message: null});

			res = await conn.queryVoid("INSERT INTO t_log SET `time`=?, message=?", [new Date(now+17000), false]);
			assertEquals(res.lastInsertId, 17);
			assertEquals(res.affectedRows, 1);
			assertEquals(await conn.query("SELECT `time`, message FROM t_log WHERE id=?", [17]).first(), {time: new Date(now+17000), message: '0'});

			res = await conn.queryVoid("INSERT INTO t_log SET `time`=?, message=?", [new Date(now+18000), true]);
			assertEquals(res.lastInsertId, 18);
			assertEquals(res.affectedRows, 1);
			assertEquals(await conn.query("SELECT `time`, message FROM t_log WHERE id=?", [18]).first(), {time: new Date(now+18000), message: '1'});

			res = await conn.queryVoid("INSERT INTO t_log SET `time`=?, message=?", [new Date(now+19000), 123.5]);
			assertEquals(res.lastInsertId, 19);
			assertEquals(res.affectedRows, 1);
			assertEquals(await conn.query("SELECT `time`, message FROM t_log WHERE id=?", [19]).first(), {time: new Date(now+19000), message: '123.5'});

			// Drop databases that i created
			await conn.query("DROP DATABASE test1");
			await conn.query("DROP DATABASE test2");
		}
	);
}

async function testNoDsn(_dsnStr: string)
{	{	await using pool = new MyPool;
		let error: Any;
		try
		{	await pool.forConn(() => Promise.resolve());
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'DSN not provided, and also default DSN was not specified');
	}

	{	await using pool = new MyPool('');
		let error: Any;
		try
		{	await pool.forConn(() => Promise.resolve());
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'DSN not provided, and also default DSN was not specified');
	}
}

async function testSerializeRows(dsnStr: string)
{	for (const storeResultsetIfBigger of [0, 12, 30, 100, 10000])
	{	const dsn = new Dsn(dsnStr);
		dsn.storeResultsetIfBigger = storeResultsetIfBigger;
		await using pool = new MyPool(dsn);
		using session = pool.getSession();
		using conn = session.conn();

		// CREATE TABLE
		await conn.query
		(	`	CREATE TEMPORARY TABLE t_log
				(	id integer PRIMARY KEY AUTO_INCREMENT,
					message text,
					data json,
					deci decimal(10,2),
					en enum('one', 'two', 'three')
				)
			`
		);

		// INSERT
		await conn.query
		(	`	INSERT INTO t_log (message, data, deci, en) VALUES
					(NULL, NULL, NULL, NULL),
					('Message 2', '123', 1.23, 'two'),
					('Message 3', '[1,2,3]', 4.56, 'three')
			`
		);

		// SELECT
		for (let bin=0; bin<2; bin++)
		{	for (let pr=0; pr<2; pr++)
			{	for (let all=0; all<2; all++)
				{	const rows = new Array<Record<string, ColumnValue>>;
					if (pr)
					{	await using resultsets = bin ? await conn.query("SELECT * FROM t_log", []).store(all==1) : await conn.queries("SELECT * FROM t_log; SELECT id FROM t_log WHERE id<=2").store(all==1);
						for await (const row of resultsets)
						{	rows.push(row);
						}
						for await (const row of resultsets)
						{	rows.push(row);
						}
					}
					else
					{	await using resultsets = bin ? await conn.query("SELECT * FROM t_log", []) : await conn.queries("SELECT * FROM t_log; SELECT id FROM t_log WHERE id<=2");
						for await (const row of await resultsets.store(all==1))
						{	rows.push(row);
						}
						for await (const row of resultsets)
						{	rows.push(row);
						}
					}
					if (!all || bin)
					{	assertEquals
						(	rows,
							[	{id: 1, message: null, data: null, deci: null, en: null},
								{id: 2, message: `Message 2`, data: 123, deci: '1.23', en: 'two'},
								{id: 3, message: `Message 3`, data: [1,2,3], deci: '4.56', en: 'three'},
							]
						);
					}
					else
					{	assertEquals
						(	rows,
							[	{id: 1, message: null, data: null, deci: null, en: null},
								{id: 2, message: `Message 2`, data: 123, deci: '1.23', en: 'two'},
								{id: 3, message: `Message 3`, data: [1,2,3], deci: '4.56', en: 'three'},
								{id: 1},
								{id: 2},
							]
						);
					}
				}
			}
		}
	}
}

async function testPrepared(dsnStr: string)
{	const N_ROWS = 3;
	await using pool = new MyPool;
	using conn = pool.getConn(dsnStr);

	// CREATE DATABASE
	await conn.query("DROP DATABASE IF EXISTS test1");
	await conn.query("CREATE DATABASE `test1` /*!40100 CHARSET latin1 COLLATE latin1_general_ci*/");

	// USE
	await conn.query("USE test1");

	// Timezone
	await conn.query("SET time_zone = 'SYSTEM'");

	// CREATE TABLE
	await conn.query("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, `time` timestamp NOT NULL, message text)");

	// INSERT
	let now = Date.now();
	now -= now % 1000;
	await conn.forPrepared
	(	"INSERT INTO t_log SET `time`=?, message=?",
		async prepared =>
		{	for (let i=1; i<=N_ROWS; i++)
			{	await prepared.exec([new Date(now+i*1000), 'Message '+i]);
			}
		}
	);

	// SELECT no read at end
	await conn.forPrepared
	(	"SELECT * FROM t_log WHERE id=?",
		async prepared =>
		{	await prepared.exec([1]);
			assertEquals(prepared.columns.length, 3);
		}
	);

	// SELECT
	await conn.forPrepared
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
	let error: Any;
	let error2: Any;
	await conn.forPrepared
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

async function testVariousColumnTypes(dsnStr: string)
{	const dsn = new Dsn(dsnStr);
	dsn.multiStatements = true;
	await using pool = new MyPool(dsn);

	pool.forConn
	(	async conn =>
		{	// Timezone
			await conn.query("SET time_zone = 'SYSTEM'");

			// CREATE TABLE
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
				const expectedRow: Record<string, unknown> =
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

async function testSqlError(dsnStr: string)
{	await using pool = new MyPool(dsnStr);

	pool.forConn
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

async function testNoBackslashEscapes(dsnStr: string)
{	await using pool = new MyPool(dsnStr);

	pool.forConn
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

async function testInitSql(dsnStr: string)
{	const dsn = new Dsn(dsnStr);
	dsn.initSql = "SET @myvar1='all'";

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

	{	await using pool = new MyPool(dsn);

		let connectionId = -1;

		await pool.forConn
		(	async conn =>
			{	let value = await conn.queryCol("SELECT @myvar1").first();
				if (value instanceof Uint8Array)
				{	value = new TextDecoder().decode(value);
				}
				assertEquals(value, 'all');

				await conn.queryVoid("SET @myvar2=1");
				assertEquals(await conn.queryCol("SELECT @myvar2").first(), 1);

				connectionId = conn.connectionId;
			}
		);

		await new Promise(y => setTimeout(y, 1000));

		await pool.forConn
		(	async conn =>
			{	await conn.connect();
				if (isResetConnectioSupported(conn.serverVersion))
				{	assertEquals(conn.connectionId, connectionId);
				}

				let value = await conn.queryCol("SELECT @myvar1").first();
				if (value instanceof Uint8Array)
				{	value = new TextDecoder().decode(value);
				}
				assertEquals(value, 'all');

				assertEquals(await conn.queryCol("SELECT @myvar2").first(), null);
			}
		);
	}

	dsn.initSql = "SELECT @myvar3:='my value'";

	{	await using pool = new MyPool(dsn);

		pool.forConn
		(	async conn =>
			{	let value = await conn.queryCol("SELECT @myvar3").first();
				if (value instanceof Uint8Array)
				{	value = new TextDecoder().decode(value);
				}
				assertEquals(value, 'my value');
			}
		);
	}
}

async function testBusyState(dsnStr: string)
{	await using pool = new MyPool(dsnStr);

	pool.forConn
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

			let promise = conn.query("SELECT 12");
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
			promise = conn.query("INSERT INTO test1.t_log SET `time`=Now(), message='Message 1'");
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

async function testSessions(dsnStr: string)
{	await using pool = new MyPool(dsnStr);
	const dsn2 = new Dsn(dsnStr);
	dsn2.keepAliveMax = 10;

	using session = pool.getSession();

	const conn1 = session.conn(); // default DSN
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

async function testPoolDsn(_dsnStr: string)
{	await using pool = new MyPool;

	pool.forSession
	(	// deno-lint-ignore require-await
		async session =>
		{	let error: Any;
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

async function testManyPlaceholders(dsnStr: string)
{	await using pool = new MyPool(dsnStr);

	pool.forConn
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
			const params = new Array<number>;
			for (let r=0; r<N_ROWS; r++)
			{	for (let c=0; c<8; c++)
				{	params.push(params.length + 1);
				}
			}

			let res = await conn.queryVoid(q, params);
			assertEquals(res.affectedRows, N_ROWS);
			assertEquals(res.nPlaceholders, N_ROWS*8);

			res = await conn.queryVoid(q, params.map(v => v+''));
			assertEquals(res.affectedRows, N_ROWS);
			assertEquals(res.nPlaceholders, N_ROWS*8);

			res = await conn.queryVoid(q, params.map(v => v%100==0 ? (v+'').repeat(10000) : v%20==0 ? null : v%10==0 ? v : v+''));
			assertEquals(res.affectedRows, N_ROWS);
			assertEquals(res.nPlaceholders, N_ROWS*8);

			// Drop database that i created
			await conn.query("DROP DATABASE test1");
		}
	);
}

async function testManyPlaceholders2(dsnStr: string)
{	await using pool = new MyPool(dsnStr);

	pool.forConn
	(	async conn =>
		{	const N_PARAMS = 303; // this magic number causes read_void_async() to trigger
			const pp = new Array<number>;
			let sum = 0;
			for (let i=0; i<N_PARAMS; i++)
			{	pp[i] = i;
				sum += i;
			}
			const calcedSum = await conn.queryCol(`SELECT ?`+'+?'.repeat(pp.length-1), pp).first();
			if (typeof(calcedSum) == 'bigint') // MySQL5.7 returns bigint, MySQL8.0 returns number
			{	assertEquals(calcedSum, BigInt(sum));
			}
			else
			{	assertEquals(calcedSum, sum);
			}
		}
	);
}

async function testReuseConnections(dsnStr: string)
{	await using pool = new MyPool(dsnStr);

	await pool.forConn
	(	async conn =>
		{	await conn.queriesVoid
			(	`	DROP DATABASE IF EXISTS test58168;
					CREATE DATABASE test58168;
					DROP DATABASE IF EXISTS test38743;
					CREATE DATABASE test38743;
				`
			);
		}
	);

	const dsn1 = new Dsn(dsnStr);
	dsn1.schema = 'test58168';
	const dsn2 = new Dsn(dsnStr);
	dsn2.schema = 'test38743';

	for (let i=0; i<4; i++)
	{	using session = pool.getSession();

		const conn1 = session.conn(dsn1);
		const conn2 = session.conn(dsn2);

		assertEquals(await conn1.queryCol("SELECT Schema()").first(), 'test58168');
		assertEquals(await conn2.queryCol("SELECT Schema()").first(), 'test38743');

		if (i >= 2)
		{	conn1.use('test38743');
			conn2.use('test58168');
			assertEquals(await conn1.queryCol("SELECT Schema()").first(), 'test38743');
			assertEquals(await conn2.queryCol("SELECT Schema()").first(), 'test58168');
		}
	}

	// Drop databases that i created
	await pool.forConn
	(	async conn =>
		{	await conn.queriesVoid("DROP DATABASE test58168;  DROP DATABASE test38743");
		}
	);
}

async function testTrx(dsnStr: string)
{	for (const managedXaDsns of [dsnStr, new Dsn(dsnStr), [dsnStr]])
	{	await using pool = new MyPool(dsnStr);
		pool.options({managedXaDsns});
		const MY_XA_ID = '6294554977320077-';

		await pool.forConn
		(	async conn =>
			{	// Recover
				try
				{	for await (const row of await conn.query(`XA RECOVER`).all())
					{	if (typeof(row.data)=='string' && row.data.startsWith(MY_XA_ID))
						{	await conn.query(`XA ROLLBACK '${row.data}'`);
							console.log('Rolled back dangling XA');
						}
						else
						{	console.log("%cWarning: there's active XA:%c %s %c(expecting auto rollback)", 'background-color:black; color:yellow', 'font-weight:bold', row.data, '');
						}
					}
				}
				catch (error)
				{	if (!(error instanceof SqlError))
					{	throw error;
					}
					// ok
				}

				// CREATE DATABASE
				await conn.query("DROP DATABASE IF EXISTS test58168");
				await conn.query("CREATE DATABASE `test58168`");
				await conn.query("DROP DATABASE IF EXISTS test38743");
				await conn.query("CREATE DATABASE `test38743`");

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
				let error: Any;
				try
				{	await conn.query("INSERT INTO t_log SET a = 123");
				}
				catch (e)
				{	error = e;
				}
				assertEquals(error?.errorCode, ErrorCodes.ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION);
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
				assertEquals((await conn.query("XA RECOVER").all()).length, 0);
				await conn.prepareCommit();
				assertEquals((await conn.query("XA RECOVER").all()).length, 1);
				await conn.commit();
				assertEquals(await conn.queryCol("SELECT Count(*) FROM t_log").first(), 1);
				res = await conn.query("DELETE FROM t_log");
				assertEquals(res.affectedRows, 1);
				assertEquals(await conn.queryCol("SELECT Count(*) FROM t_log").first(), 0);
			}
		);

		// XA session
		const xaInfoDsn1 = new Dsn(dsnStr);
		xaInfoDsn1.schema = 'test58168';
		const xaInfoDsn2 = new Dsn(dsnStr);
		xaInfoDsn2.schema = 'test38743';
		await pool.forSession
		(	async session =>
			{	const conn2 = session.conn(xaInfoDsn2);
				assertEquals(await conn2.queryCol("SELECT Schema()").first(), 'test38743');
				await conn2.query("CREATE TABLE t_log LIKE test58168.t_log");

				// Start, insert, savepoint, insert, rollback to point, commit

				await session.startTrx({xa: true});

				const conn1 = session.conn(xaInfoDsn1);
				assertEquals(conn1.connectionId, 0); // not yet connected
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

				const p1 = session.savepoint();

				await conn1.query("INSERT INTO t_log SET a = 234");
				await conn2.query("INSERT INTO t_log SET a = 234");

				assertEquals(conn1.inXa, true);
				assertEquals(conn2.inXa, true);
				assert(conn1.xaId != '');
				assert(conn2.xaId != '');
				assertEquals(await conn1.queryCol("SELECT Count(*) FROM t_log").first(), 2);
				assertEquals(await conn2.queryCol("SELECT Count(*) FROM t_log").first(), 2);

				await session.rollback(p1);

				assertEquals(conn1.inXa, true);
				assertEquals(conn2.inXa, true);
				assert(conn1.xaId != '');
				assert(conn2.xaId != '');
				assertEquals(await conn1.queryCol("SELECT Count(*) FROM t_log").first(), 1);
				assertEquals(await conn2.queryCol("SELECT Count(*) FROM t_log").first(), 1);

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

				await conn1.prepareCommit();
				conn1.forceImmediateDisconnect(true, true); // leave dangling XA
				assertEquals(await conn1.queryCol("SELECT Count(*) FROM t_log").first(), 1);
				await conn1.query("DELETE FROM t_log"); // this blocks till XA manager rolls back the dangling XA
				assertEquals(await conn1.queryCol("SELECT Count(*) FROM t_log").first(), 0);

				await session.commit();
				assertEquals(await conn2.queryCol("SELECT Count(*) FROM t_log").first(), 0);
				await conn2.query("DELETE FROM t_log");
			}
		);

		for (let noXa=0; noXa<2; noXa++)
		{	await pool.forSession
			(	async session =>
				{	const conn1 = session.conn(xaInfoDsn1);
					const conn2 = session.conn(xaInfoDsn2);
					await conn1.connect();

					await session.startTrx(noXa ? undefined : {xa: true});

					assertEquals(conn1.connectionId>0, true);
					assertEquals(conn2.connectionId, 0); // not yet connected
					assertEquals(conn1.inTrx, true);
					assertEquals(conn2.inTrx, true); // startTrx() pends the transaction start till actual connection
					assertEquals(conn1.inXa, noXa==0);
					assertEquals(conn2.inXa, noXa==0);

					await conn1.query("INSERT INTO t_log SET a = 123");
					await conn2.query("INSERT INTO t_log SET a = 123");

					assertEquals(conn1.connectionId>0, true);
					assertEquals(conn2.connectionId>0, true);
					assertEquals(conn1.inTrx, true);
					assertEquals(conn2.inTrx, true);

					assertEquals(await conn1.queryCol("SELECT Schema()").first(), 'test58168');
					assertEquals(await conn2.queryCol("SELECT Schema()").first(), 'test38743');
					assertEquals(await conn1.queryCol("SELECT Count(*) FROM t_log").first(), 1);
					assertEquals(await conn2.queryCol("SELECT Count(*) FROM t_log").first(), 1);

					await session.rollback(0);

					assertEquals(conn1.inTrx, true);
					assertEquals(conn2.inTrx, true);

					assertEquals(await conn1.queryCol("SELECT Count(*) FROM t_log").first(), 0);
					assertEquals(await conn2.queryCol("SELECT Count(*) FROM t_log").first(), 0);

					await conn1.query("INSERT INTO t_log SET a = 123");
					await conn2.query("INSERT INTO t_log SET a = 123");

					session.savepoint();

					await conn1.query("INSERT INTO t_log SET a = 234");
					await conn2.query("INSERT INTO t_log SET a = 234");

					assertEquals(conn1.inTrx, true);
					assertEquals(conn2.inTrx, true);
					assertEquals(await conn1.queryCol("SELECT Count(*) FROM t_log").first(), 2);
					assertEquals(await conn2.queryCol("SELECT Count(*) FROM t_log").first(), 2);

					await session.rollback(0);

					assertEquals(conn1.inTrx, true);
					assertEquals(conn2.inTrx, true);

					assertEquals(await conn1.queryCol("SELECT Count(*) FROM t_log").first(), 0);
					assertEquals(await conn2.queryCol("SELECT Count(*) FROM t_log").first(), 0);

					await conn1.query("INSERT INTO t_log SET a = 123");
					await conn2.query("INSERT INTO t_log SET a = 123");

					assertEquals(await conn1.queryCol("SELECT Count(*) FROM t_log").first(), 1);
					assertEquals(await conn2.queryCol("SELECT Count(*) FROM t_log").first(), 1);

					// don't commit or rollback
				}
			);

			await pool.forSession
			(	async session =>
				{	const conn1 = session.conn(xaInfoDsn1);
					const conn2 = session.conn(xaInfoDsn2);

					assertEquals(await conn1.queryCol("SELECT Count(*) FROM t_log").first(), 0);
					assertEquals(await conn2.queryCol("SELECT Count(*) FROM t_log").first(), 0);
				}
			);
		}

		// Drop databases that i created
		await pool.forConn
		(	async conn =>
			{	await conn.query("DROP DATABASE test58168");
				await conn.query("DROP DATABASE test38743");
			}
		);
	}
}

async function testRetryQueryTimes(dsnStr: string)
{	await using pool = new MyPool(dsnStr);

	pool.forConn // no await, and inner `pool.forConn()` should still work
	(	async conn =>
		{	// Create and use db
			await conn.query("DROP DATABASE IF EXISTS test1");
			await conn.query("CREATE DATABASE `test1`");
			await conn.query("USE test1");

			// CREATE TABLE
			await conn.query("CREATE TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, message text)");

			// INSERT
			await conn.query("INSERT INTO t_log SET message = 'Message 1'");

			// START TRANSACTION
			await conn.startTrx();

			// Lock record
			await conn.query("UPDATE t_log SET message = 'Message *' WHERE id = 1");

			// Parallel connection
			const dsn2 = new Dsn(dsnStr);
			dsn2.retryLockWaitTimeout = true;
			dsn2.retryQueryTimes = 2;
			await pool.forConn
			(	async conn2 =>
				{	await conn2.query("USE test1");
					await conn2.query("SET innodb_lock_wait_timeout=0");
					let nErrors = 0;
					conn2.setSqlLogger
					(	{	query()
							{	return Promise.resolve
								(	{	end(result: Resultsets<unknown>|Error|undefined)
										{	assert(result instanceof Error);
											nErrors++;
											return Promise.resolve();
										}
									}
								);
							}
						}
					);
					let error: Any;
					try
					{	await conn2.query("UPDATE t_log SET message = 'Message **' WHERE id = 1");
					}
					catch (e)
					{	error = e;
					}
					assertEquals(error?.errorCode, ErrorCodes.ER_LOCK_WAIT_TIMEOUT);
					assertEquals(nErrors, 3);
				},
				dsn2
			);

			// ROLLBACK
			await conn.rollback();

			// Drop database that i created
			await conn.query("DROP DATABASE test1");
		}
	);
}

async function testMaxConns(dsnStr: string)
{	const dsn = new Dsn(dsnStr);
	const maxConns = 2;

	for (const [connectionTimeout, maxConnsWaitQueue] of [[0, 1], [401, 1], [0, 0], [401, 0]])
	{	dsn.connectionTimeout = connectionTimeout;
		dsn.maxConns = maxConns;
		await using pool = new MyPool(dsn);

		pool.options({maxConnsWaitQueue});

		await pool.forSession
		(	async session =>
			{	const conn1 = session.conn(undefined, true);
				await conn1.connect();

				const conn2 = session.conn(undefined, true);
				await conn2.connect();

				let error: Any;
				const since = Date.now();
				try
				{	const conn3 = session.conn(undefined, true);
					await conn3.connect();
				}
				catch (e)
				{	error = e;
				}
				assertEquals(error?.message, `All the ${maxConns} free slots are occupied for this DSN: ${dsn.hostname}`);
				assertEquals(Date.now()-since > 400, connectionTimeout==401 && maxConnsWaitQueue!=0);
			}
		);
	}
}

async function testLoadBigDump(dsnStr: string)
{	const dsn = new Dsn(dsnStr);
	dsn.maxColumnLen = Number.MAX_SAFE_INTEGER;
	await using pool = new MyPool(dsn);
	const enum DumpType
	{	String,
		Uint8Array,
		Stream,
	}
	const CASES: [number, boolean, boolean, boolean][] =
	[	[0, true, true, false],
		[100, true, true, false],
		[2**24 - 8, false, true, false],
		[2**24 - 2, false, true, false],
		[2**24 - 1, true, false, false],
		[2**24, false, false, true],
		[8*1024 + 100, true, true, true],
		[2**24 + 8*1024 + 100, false, false, true],
	];
	pool.forConn
	(	async conn =>
		{	// Create and use db
			await conn.query("DROP DATABASE IF EXISTS test1");
			await conn.query("CREATE DATABASE `test1`");
			await conn.query("USE test1");

			// CREATE TABLE
			await conn.query("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, message longtext)");

			for (const dumpType of [DumpType.String, DumpType.Uint8Array, DumpType.Stream])
			{	for (const [SIZE, isReadableStream, isSeekable, useBinarySelect] of CASES)
				{	const maxAllowedPacket = Number(await conn.queryCol("SELECT @@max_allowed_packet").first());
					if (maxAllowedPacket < SIZE+100)
					{	let wantSize = SIZE + 100;
						let sizeRounded = 1;
						while (wantSize)
						{	wantSize >>= 1;
							sizeRounded <<= 1;
						}
						await conn.queryVoid("SET GLOBAL max_allowed_packet = ?", [sizeRounded]);
						conn.end();
						assert(Number(await conn.queryCol("SELECT @@max_allowed_packet").first()) >= wantSize);
					}

					const filename = await Deno.makeTempFile();
					try
					{	using fh = await Deno.open(filename, {write: true, read: true});
						const writer = fh.writable.getWriter();
						try
						{	// Write INSERT query to file
							const queryPrefix = "INSERT INTO t_log SET message = '";
							await writer.write(new TextEncoder().encode(queryPrefix));
							const buffer = new Uint8Array(64*1024);
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
								await writer.write(buffer.subarray(0, len));
								curSize += len;
							}
							assertEquals(curSize, SIZE);
							await writer.write(new TextEncoder().encode("'"));

							// DELETE
							await conn.queryVoid("DELETE FROM t_log");

							// Read INSERT from file
							let insertStatus: Resultsets<unknown>|undefined;
							try
							{	if (dumpType == DumpType.String)
								{	const q = await Deno.readTextFile(filename);
									insertStatus = await conn.query(q);
								}
								else if (dumpType == DumpType.Uint8Array)
								{	const q = await Deno.readTextFile(filename);
									insertStatus = await conn.query(new TextEncoder().encode(q));
								}
								else
								{	await fh.seek(0, Deno.SeekMode.Start);
									const o1: {readonly size: number} | Seeker = isSeekable ? {seek: (o, w) => fh.seek(o, w)} : {size: queryPrefix.length + SIZE + 1};
									const o2: {readonly readable: ReadableStream<Uint8Array>} | Reader = isReadableStream ? {readable: fh.readable} : {read: b => fh.read(b)};
									insertStatus = await conn.query({...o1, ...o2});
								}
							}
							catch (e: Any)
							{	if (e.message.indexOf('innodb_log_file_size') == -1)
								{	throw e;
								}
								console.warn('%cTest skipped: %c'+e.message, 'color:orange', 'color:inherit');
								return;
							}
							const recordId = insertStatus.lastInsertId;

							// SELECT Length()
							assertEquals(await conn.queryCol("SELECT Length(message) FROM t_log WHERE id="+recordId).first(), SIZE);

							const row = await conn.query("SELECT message, id FROM t_log WHERE id="+recordId, useBinarySelect ? [] : undefined).first();
							assertEquals(typeof(row?.message)=='string' ? row.message.length : -1, SIZE);
							assertEquals(row?.id, recordId);

							// SELECT from table to new file
							const filename2 = await Deno.makeTempFile();
							try
							{	using fh2 = await Deno.open(filename2, {write: true, read: true});
								const row = await conn.makeLastColumnReadable("SELECT message FROM t_log WHERE id="+recordId);
								assert(row?.message instanceof ReadableStream);
								await row.message.pipeTo(fh2.writable, {preventClose: true});

								// Validate the new file size
								let size2 = await fh2.seek(0, Deno.SeekMode.End);
								assertEquals(size2, SIZE);
								await fh2.seek(0, Deno.SeekMode.Start);

								// Validate the new file contents
								const since = Date.now();
								console.log(`Started validating (size=${SIZE}, type=${dumpType==DumpType.String ? 'string': dumpType==DumpType.Uint8Array ? 'Uint8Array' : isReadableStream ? 'ReadableStream' : 'Deno.Reader'}, isSeekable=${isSeekable}, useBinarySelect=${useBinarySelect})`);
								let buffer2 = new Uint8Array(buffer.length);
								const fh2r = fh2.readable.getReader({mode: 'byob'});
								try
								{	while (size2 > 0)
									{	let pos = 0;
										const len = Math.min(buffer2.length, size2);
										while (pos < len)
										{	const {value, done} = await fh2r.read(buffer2.subarray(pos, len));
											assert(!done);
											buffer2 = new Uint8Array(value.buffer);
											pos += value.length;
										}

										for (let i=0; i<len; i++)
										{	if (buffer[i] != buffer2[i])
											{	assertEquals(buffer[i], buffer2[i]);
											}
										}
										size2 -= len;
									}
								}
								finally
								{	fh2r.releaseLock();
								}
								console.log(`Done validating in ${(Date.now()-since) / 1000} sec`);
							}
							finally
							{	await Deno.remove(filename2);
							}
						}
						finally
						{	writer.releaseLock();
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

async function testLoadFile(dsnStr: string)
{	const dsn = new Dsn(dsnStr);
	const dataFile = await Deno.makeTempFile();
	const data = await fetch('https://raw.githubusercontent.com/lukes/ISO-3166-Countries-with-Regional-Codes/master/all/all.csv');
	await Deno.writeFile(dataFile, data.body ?? new Uint8Array);
	for (const asReadable of [false, true])
	{	await using pool = new MyPool(dsn);
		if (asReadable)
		{	pool.options
			(	{	async onLoadFile(filename: string)
					{	if (filename == dataFile)
						{	const fh = await Deno.open(filename, {read: true});
							return {readable: fh.readable, [Symbol.dispose]: () => fh[Symbol.dispose]()};
						}
					}
				}
			);
		}
		else
		{	pool.options
			(	{	async onLoadFile(filename: string)
					{	if (filename == dataFile)
						{	const fh = await Deno.open(filename, {read: true});
							return {read: b => fh.read(b), close: () => fh.close()};
						}
					}
				}
			);
		}
		pool.forConn
		(	async conn =>
			{	// Create and use db
				await conn.query("DROP DATABASE IF EXISTS test1");
				await conn.query("CREATE DATABASE `test1`");
				await conn.query("USE test1");

				// CREATE TABLE
				await conn.queryVoid
				(	`	CREATE TEMPORARY TABLE t_countries
						(	country_code char(2) CHARACTER SET latin1 NOT NULL PRIMARY KEY,
							country_name varchar(128) NOT NULL
						)
					`
				);

				// SQL-quote filename, because `LOAD DATA LOCAL INFILE` doesn't accept parameters
				const dataFileSql = await conn.queryCol("SELECT Quote(?)", [dataFile]).first();

				// LOAD DATA
				await conn.queryVoid
				(	`	LOAD DATA LOCAL INFILE ${dataFileSql}
						INTO TABLE t_countries
						FIELDS TERMINATED BY ','
						ENCLOSED BY '"'
						IGNORE 1 LINES
						(@name, @code)
						SET
							country_code = @code,
							country_name = @name
					`
				);

				// SELECT
				const row = await conn.query("SELECT Count(*) AS cnt, Sum(country_code = 'TH') AS n_th FROM t_countries").first();

				assertEquals(Number(row?.cnt)>100, true);
				assertEquals(Number(row?.n_th), 1);

				// Drop database that i created
				await conn.query("DROP DATABASE test1");
			}
		);
	}
}

async function testMultiStatements(dsnStr: string)
{	const dsn = new Dsn(dsnStr);
	await using pool = new MyPool(dsn);

	for (let i=0; i<4; i++)
	{	let cid;
		for (let j=0; j<2; j++)
		{	{	using conn = pool.getConn();

				let q = "SELECT @a, @b";
				let row = await (i<2 ? conn.query(q) : conn.queries(q)).first();
				assertEquals(row?.['@a'], null);
				assertEquals(row?.['@b'], null);

				await conn.queriesVoid("SET @a=1; SET @b=2");
				q = "SELECT Connection_id() AS cid, @a, @b";
				row = await (i%2==0 ? conn.query(q) : conn.queries(q)).first();
				assertEquals(row?.['@a'], 1);
				assertEquals(row?.['@b'], 2);
				if (j == 1)
				{	assertEquals(row?.cid, cid);
				}
				cid = row?.cid;
			}

			await new Promise(y => setTimeout(y, 200));
		}
	}
}

async function testBindBigParam(dsnStr: string)
{	const maxColumnLen = 0x1000000;
	const dsn = new Dsn(dsnStr);
	dsn.maxColumnLen = maxColumnLen;
	await using pool = new MyPool(dsn);
	using conn = pool.getConn();

	// CREATE DATABASE
	await conn.query("DROP DATABASE IF EXISTS test1");
	await conn.query("CREATE DATABASE `test1` /*!40100 CHARSET latin1 COLLATE latin1_general_ci*/");

	// USE
	await conn.query("USE test1");

	// CREATE TABLE
	await conn.query("CREATE TEMPORARY TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, message longblob)");

	// INSERT
	await using insert = await conn.prepareVoid("INSERT INTO t_log SET message=?");
	await using select = await conn.prepareCol("SELECT message FROM t_log WHERE id=?");
	for (const selectBin of [false, true])
	{	for (const size of [0, 10, 0xFF, 0x10000, maxColumnLen+1, maxColumnLen])
		{	const data = new Uint8Array(size);
			for (let i=0; i<size; i++)
			{	data[i] = i & 0xFF;
			}
			const {lastInsertId} = await insert.exec([data]);
			const message = await (selectBin ? select.exec([lastInsertId]) : conn.queryCol("SELECT message FROM t_log WHERE id="+lastInsertId)).first();
			if (size > maxColumnLen)
			{	assertEquals(message, null);
			}
			else
			{	assert(message instanceof Uint8Array);
				assertEquals(message.length, size);
				for (let i=0; i<size; i++)
				{	if (message[i] != data[i])
					{	assertEquals(message[i], data[i]);
					}
				}
			}
		}
	}

	// Drop database that i created
	await conn.query("DROP DATABASE test1");
}

async function testForceImmediateDisconnect(dsnStr: string)
{	const maxColumnLen = 0x1000000;
	const dsn = new Dsn(dsnStr);
	dsn.maxColumnLen = maxColumnLen;
	await using pool = new MyPool(dsn);
	using session = pool.getSession();
	using conn = session.conn();

	// CREATE DATABASE
	await conn.query("DROP DATABASE IF EXISTS test1");
	await conn.query("CREATE DATABASE `test1` /*!40100 CHARSET latin1 COLLATE latin1_general_ci*/");

	// USE
	await conn.query("USE test1");

	// CREATE TABLE
	const startTime = Date.now();
	const [res2] = await Promise.allSettled
	(	[	conn.queries("DO SLEEP(6); CREATE TABLE t_log (id integer PRIMARY KEY AUTO_INCREMENT, message longblob)"),
			new Promise(y => setTimeout(y, 0)).then(() => session.forceImmediateDisconnect()),
		]
	);

	assertEquals(res2.status, 'rejected');
	assertEquals(Date.now()-startTime < 6000, true);

	// Drop database that i created
	await conn.query("DROP DATABASE test1");
}
