// NOTE: import order matters. `my_protocol.ts` sits atop the module cycle (its `MyProtocol` extends
// `MyProtocolReaderWriterSerializer`); importing it first lets the serializer finish initializing before
// the `extends`. Importing the serializer module first would trip a "Cannot access ... before initialization".
import {RowType} from '../my_protocol.ts';
import {Column} from '../resultsets.ts';
import {MyProtocolReaderWriterSerializer} from '../my_protocol_reader_writer_serializer.ts';
import {MysqlType, Charset, ColumnFlags} from '../constants.ts';
import {RdStream, WrStream} from '../deps.ts';
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

	write(chunk: Uint8Array)
	{	this.#chunks.push(chunk.slice()); // the send buffer is reused between writes, so copy
		return Promise.resolve(chunk.length);
	}

	read(view: Uint8Array)
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
		const n = Math.min(view.length, this.#flat.length - this.#readPos);
		if (n <= 0)
		{	return Promise.resolve(null); // EOF
		}
		view.set(this.#flat.subarray(this.#readPos, this.#readPos+n));
		this.#readPos += n;
		return Promise.resolve(n);
	}
}

function stringColumn(name: string)
{	return new Column('', '', '', '', name, '', Charset.UTF8_GENERAL_CI, 0, MysqlType.MYSQL_TYPE_VAR_STRING, ColumnFlags.NOT_NULL, 0);
}

/**	Serialize a single-row resultset with the binary protocol, then read it back - exactly what
	`Resultsets.store()`/`buffered()` do internally. Returns the deserialized value of column 0.
 **/
async function roundTripBinary(value: string, columns: Column[])
{	const mem = new MemStream;
	const writer = new WrStream({write: b => mem.write(b)}).getWriter();
	const reader = new RdStream({read: b => mem.read(b)}).getReader({mode: 'byob'});
	const serializer = new MyProtocolReaderWriterSerializer(writer, reader, new TextDecoder, undefined);
	serializer.serializeBegin();
	await serializer.serializeRowBinary([value], columns, false, tz);
	await serializer.serializeEnd();
	const {row} = await serializer.deserializeRowBinary(RowType.ARRAY, columns, false, false, tz, Number.MAX_SAFE_INTEGER);
	return (row as Any)[0];
}

Deno.test
(	'Binary string column whose byte length sits at the read-buffer boundary round-trips',
	async () =>
	{	const columns = [stringColumn('s')];
		// The in-buffer "short" read path can hold at most `BUFFER_LEN-4` bytes (4 bytes are reserved for the
		// packet header). Lengths 8189..8192 used to take the short path anyway and threw
		// "String is too long for this operation", killing the connection. Cover both sides of the boundary.
		for (let len=BUFFER_LEN-8; len<=BUFFER_LEN+8; len++) // 8184 .. 8200
		{	const value = 'a'.repeat(len); // ASCII: UTF-8 byte length == character count
			assertEquals(await roundTripBinary(value, columns), value, `ASCII length ${len}`);
		}
	}
);

Deno.test
(	'Multi-byte string ending inside the boundary range decodes correctly',
	async () =>
	{	const columns = [stringColumn('s')];
		// '€' is 3 UTF-8 bytes: 2730*3 == 8190 bytes - squarely inside the previously-throwing [8189, 8192] range.
		const value = '€'.repeat(2730);
		assertEquals(await roundTripBinary(value, columns), value, 'UTF-8 length 8190');
	}
);
