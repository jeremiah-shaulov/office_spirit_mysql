// NOTE: import order matters. `my_protocol.ts` sits atop the module cycle (its `MyProtocol` extends
// `MyProtocolReaderWriterSerializer`); importing it first lets the serializer finish initializing before
// the `extends`. Importing the serializer module first would trip a "Cannot access ... before initialization".
import {RowType} from '../my_protocol.ts';
import {Column} from '../resultsets.ts';
import {MyProtocolReaderWriterSerializer} from '../my_protocol_reader_writer_serializer.ts';
import {MysqlType, Charset, ColumnFlags} from '../constants.ts';
import {RdStream, WrStream} from '../deps.ts';
import {assert} from 'jsr:@std/assert@1.0.19/assert';
import {assertEquals} from 'jsr:@std/assert@1.0.19/equals';

// deno-lint-ignore no-explicit-any
type Any = any;

const BUFFER_LEN = 8*1024; // must equal the `BUFFER_LEN` in `my_protocol_reader.ts`
const tz = {getTimezoneMsecOffsetFromSystem: () => 0};

/**	Collects everything the serializer writes, and hands it back byte-for-byte to the deserializer.
	Mirrors the file-backed `RdStream`/`WrStream` bridge that `Resultsets.store()` uses, but keeps
	the bytes in memory so the test needs no filesystem access.
 **/
class MemStream
{	#chunks: Uint8Array[] = [];
	#flat: Uint8Array|undefined;
	#readPos = 0;

	get data()
	{	if (!this.#flat)
		{	let total = 0;
			for (const chunk of this.#chunks)
			{	total += chunk.length;
			}
			this.#flat = new Uint8Array(total);
			let pos = 0;
			for (const chunk of this.#chunks)
			{	this.#flat.set(chunk, pos);
				pos += chunk.length;
			}
		}
		return this.#flat;
	}

	write(chunk: Uint8Array)
	{	this.#chunks.push(chunk.slice()); // the send buffer is reused between writes, so copy
		return Promise.resolve(chunk.length);
	}

	read(view: Uint8Array)
	{	const {data} = this;
		const n = Math.min(view.length, data.length - this.#readPos);
		if (n <= 0)
		{	return Promise.resolve(null); // EOF
		}
		view.set(data.subarray(this.#readPos, this.#readPos+n));
		this.#readPos += n;
		return Promise.resolve(n);
	}
}

/**	Serialize the given rows with the binary protocol, then read them back - exactly what
	`Resultsets.store()`/`buffered()` do internally. Returns the deserialized rows (as arrays),
	and the raw bytes of the stored packet stream.
 **/
async function roundTripRows(rows: Any[][], columns: Column[], datesAsString=false)
{	const mem = new MemStream;
	const writer = new WrStream({write: b => mem.write(b)}).getWriter();
	const reader = new RdStream({read: b => mem.read(b)}).getReader({mode: 'byob'});
	const serializer = new MyProtocolReaderWriterSerializer(writer, reader, new TextDecoder, undefined);
	serializer.serializeBegin();
	for (const row of rows)
	{	await serializer.serializeRowBinary(row, columns, datesAsString, tz);
	}
	await serializer.serializeEnd();
	const rowsBack = new Array<Any[]>;
	for (let i=0; i<rows.length; i++)
	{	const {row} = await serializer.deserializeRowBinary(RowType.ARRAY, columns, false, datesAsString, tz, Number.MAX_SAFE_INTEGER);
		rowsBack[i] = row;
	}
	return {rowsBack, data: mem.data};
}

Deno.test
(	'Fixed-size columns after a blob that fills the buffer to the end survive the roundtrip',
	async () =>
	{	// An 8184-byte blob lands `bufferEnd` exactly at the end of the 8192-byte buffer (4-byte packet header +
		// 1-byte null mask + 3-byte lenenc length + 8184 bytes of data). The TINYINT written after it went out of
		// bounds (a silent no-op), so the packet header promised more bytes than were written, and every later
		// packet in the store was misframed.
		const columns =
		[	new Column('', '', '', '', 'a', '', Charset.BINARY, 0xFFFFFF, MysqlType.MYSQL_TYPE_MEDIUM_BLOB, ColumnFlags.BINARY, 0),
			new Column('', '', '', '', 'b', '', Charset.BINARY, 4, MysqlType.MYSQL_TYPE_TINY, ColumnFlags.UNSIGNED, 0),
		];
		const blob = new Uint8Array(BUFFER_LEN - 8).fill(0x61); // 8184 bytes
		const rows = new Array<Any[]>;
		for (let i=0; i<12; i++)
		{	rows[i] = [blob, 7];
		}
		const {rowsBack} = await roundTripRows(rows, columns);
		for (let i=0; i<12; i++)
		{	const [a, b] = rowsBack[i];
			assert(a instanceof Uint8Array, `row ${i}: column a`);
			assertEquals(a, blob, `row ${i}: column a`);
			assertEquals(b, 7, `row ${i}: column b`);
		}
	}
);

Deno.test
(	'A row longer than 0xFFFFFF bytes is split into continuation packets',
	async () =>
	{	// The length field in a packet header is 3-byte. A row whose non-last columns accumulate more than
		// 0xFFFFFF bytes used to be framed as one packet, truncating the length modulo 2**24 and bleeding
		// into the sequence-id byte. Now the payload must be split into packets of exactly 0xFFFFFF bytes,
		// that the reader joins back.
		const columns =
		[	new Column('', '', '', '', 'a', '', Charset.BINARY, 0xFFFFFFFF, MysqlType.MYSQL_TYPE_LONG_BLOB, ColumnFlags.BINARY, 0),
			new Column('', '', '', '', 'b', '', Charset.BINARY, 0xFFFFFFFF, MysqlType.MYSQL_TYPE_LONG_BLOB, ColumnFlags.BINARY, 0),
			new Column('', '', '', '', 'c', '', Charset.BINARY, 4, MysqlType.MYSQL_TYPE_TINY, ColumnFlags.UNSIGNED, 0),
		];
		const nine = 9*1024*1024;
		const a = new Uint8Array(nine).fill(0x61);
		const b = new Uint8Array(nine).fill(0x62);
		const {rowsBack, data} = await roundTripRows([[a, b, 7]], columns);
		// The first packet must be framed as exactly 0xFFFFFF bytes, with sequence id 0
		assertEquals(data[0] | data[1]<<8 | data[2]<<16, 0xFFFFFF, 'first packet payload length');
		assertEquals(data[3], 0, 'first packet sequence id');
		// The whole stream must be null mask + 2 x (lenenc length + data) + TINYINT, plus 2 packet headers
		assertEquals(data.length, 4 + 1 + 4 + nine + 4 + nine + 1 + 4, 'total stored bytes');
		const [aBack, bBack, cBack] = rowsBack[0];
		assert(aBack instanceof Uint8Array);
		assert(bBack instanceof Uint8Array);
		assertEquals(aBack.length, nine, 'column a length');
		assertEquals(bBack.length, nine, 'column b length');
		assertEquals([aBack[0], aBack[nine>>1], aBack[nine-1]], [0x61, 0x61, 0x61], 'column a content');
		assertEquals([bBack[0], bBack[nine>>1], bBack[nine-1]], [0x62, 0x62, 0x62], 'column b content');
		assertEquals(cBack, 7, 'column c');
	}
);

Deno.test
(	'datesAsString DATETIME fraction is scaled to microseconds',
	async () =>
	{	// The fractional digits are 1 to 6 chars ('.10' means 100000 microseconds), but they were taken
		// as raw microseconds ('.10' → 10 microseconds).
		const columns = [new Column('', '', '', '', 'dt', '', Charset.BINARY, 22, MysqlType.MYSQL_TYPE_DATETIME, ColumnFlags.BINARY, 2)];
		const {rowsBack} = await roundTripRows
		(	[	['2020-03-04 05:06:07.10'],
				['2001-02-03 04:05:06.123456'],
				['1999-12-31 23:59:59.001'],
				['2010-11-12 13:14:15'],
			],
			columns,
			true
		);
		assertEquals(rowsBack[0][0], '2020-03-04 05:06:07.100000');
		assertEquals(rowsBack[1][0], '2001-02-03 04:05:06.123456');
		assertEquals(rowsBack[2][0], '1999-12-31 23:59:59.001000');
		assertEquals(rowsBack[3][0], '2010-11-12 13:14:15');
	}
);

Deno.test
(	'TIME with microseconds keeps the exact microsecond value',
	async () =>
	{	// The microseconds were extracted with `Math.trunc(num * 1_000_000) % 1_000_000`, that loses
		// 1 microsecond when the float sum of seconds and microseconds falls a fraction below the true value
		// (e.g. 539905.312172 - that is '149:58:25.312172' - gave 312171).
		const columns = [new Column('', '', '', '', 'tm', '', Charset.BINARY, 17, MysqlType.MYSQL_TYPE_TIME, ColumnFlags.BINARY, 6)];
		const values = [539905.312172, -539905.312172, 0.000001, -0.000001, 1.999999, 3020399.999999, 60, -60, 0];
		const {rowsBack} = await roundTripRows(values.map(v => [v]), columns);
		for (let i=0; i<values.length; i++)
		{	assertEquals(Math.round(rowsBack[i][0] * 1_000_000), Math.round(values[i] * 1_000_000), `value ${values[i]}`);
		}
	}
);

Deno.test
(	'DATE with year below 100, and zero dates, round-trip through the binary protocol',
	async () =>
	{	// `new Date(year, ...)` maps years 0-99 to 1900-1999, so DATE '0050-01-01' came back as 1950-01-01
		const columns = [new Column('', '', '', '', 'd', '', Charset.BINARY, 10, MysqlType.MYSQL_TYPE_DATE, ColumnFlags.BINARY, 0)];
		const year50 = new Date(2000, 0, 1);
		year50.setFullYear(50);
		const {rowsBack} = await roundTripRows([[year50], [new Date(0)], [new Date(1234, 4, 6)]], columns);
		const [[d50], [dZero], [d1234]] = rowsBack;
		assert(d50 instanceof Date);
		assertEquals(d50.getTime(), year50.getTime());
		assertEquals(d50.getFullYear(), 50);
		assert(dZero instanceof Date);
		assertEquals(dZero.getTime(), 0); // the zero-date sentinel
		assert(d1234 instanceof Date);
		assertEquals(d1234.getTime(), new Date(1234, 4, 6).getTime());
	}
);
