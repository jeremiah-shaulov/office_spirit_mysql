import {MyProtocolReaderWriter} from '../my_protocol_reader_writer.ts';
import {assert} from 'jsr:@std/assert@1.0.19/assert';
import {assertEquals} from 'jsr:@std/assert@1.0.19/equals';

// deno-lint-ignore no-explicit-any
type Any = any;

const encoder = new TextEncoder;
const BUFFER_LEN = 8*1024; // must equal the `BUFFER_LEN` in `my_protocol_reader.ts`
const CONTINUATION = 0xFFFFFF; // a MySQL packet with this payload length means "more packets follow"
const COM_QUERY = 3;
const COM_STMT_EXECUTE = 0x17;
const COM_STMT_SEND_LONG_DATA = 0x18;

/**	Collects everything written "to the wire", so a test can reassemble the MySQL packet stream.
	Doubles as a watchdog: when `sendWithData()` used to spin on a multi-byte UTF-8 character
	straddling a 16 MiB packet boundary, it issued an endless flood of empty `write()` calls.
	If that regresses, throw quickly instead of hanging the whole test run.
 **/
class CollectingWriter
{	chunks: Uint8Array[] = [];
	nCalls = 0;

	write(chunk: Uint8Array)
	{	if (++this.nCalls > 100_000)
		{	throw new Error(`writer.write() called ${this.nCalls} times without finishing - sendWithData() is spinning`);
		}
		this.chunks.push(chunk.slice()); // copy: the send buffer is reused between writes
		return Promise.resolve();
	}

	releaseLock() {}
	close() {return Promise.resolve()}
}

/**	Exposes the `protected` sending machinery for tests.
 **/
class TestWriter extends MyProtocolReaderWriter
{	async sendStringPacket(command: number, sql: string)
	{	this.startWritingNewPacket(true);
		this.writeUint8(command);
		await this.sendWithData(sql, false);
	}

	/**	The wire sequence of `#sendComStmtExecute()` for blob parameters: one `COM_STMT_SEND_LONG_DATA`
		command per blob, each sent with `canWait=true` (so small ones queue in the send buffer), then one
		final short command packet, like the `COM_STMT_EXECUTE` that follows the parameters.
	 **/
	async sendLongDataSequence(stmtId: number, blobs: Uint8Array[])
	{	for (let i=0; i<blobs.length; i++)
		{	this.startWritingNewPacket(true);
			this.writeUint8(COM_STMT_SEND_LONG_DATA);
			this.writeUint32(stmtId);
			this.writeUint16(i);
			await this.sendWithData(blobs[i], false, undefined, true);
		}
		this.startWritingNewPacket(true);
		this.writeUint8(COM_STMT_EXECUTE);
		this.writeUint32(stmtId);
		await this.send();
	}

	get collected()
	{	return this.writer as unknown as CollectingWriter;
	}
}

function concat(chunks: Uint8Array[])
{	let total = 0;
	for (const chunk of chunks)
	{	total += chunk.length;
	}
	const result = new Uint8Array(total);
	let pos = 0;
	for (const chunk of chunks)
	{	result.set(chunk, pos);
		pos += chunk.length;
	}
	return result;
}

/**	Parse a MySQL multi-packet byte stream and return the reassembled payload (the concatenation
	of every packet body). A payload split point may fall anywhere - even inside a UTF-8 character -
	because the server reassembles the bytes before parsing.
 **/
function reassemblePayload(wire: Uint8Array)
{	const parts: Uint8Array[] = [];
	let pos = 0;
	let sequenceId = 0;
	while (true)
	{	assert(pos+4 <= wire.length, 'truncated packet header');
		const len = wire[pos] | (wire[pos+1] << 8) | (wire[pos+2] << 16);
		assertEquals(wire[pos+3], sequenceId++ & 0xFF, 'wrong packet sequence id');
		pos += 4; // skip 3-byte length + 1-byte sequence id
		assert(pos+len <= wire.length, 'truncated packet body');
		parts.push(wire.subarray(pos, pos+len));
		pos += len;
		if (len != CONTINUATION)
		{	break; // last packet is the first one shorter than 0xFFFFFF
		}
	}
	assertEquals(pos, wire.length, 'trailing bytes after the final packet');
	return concat(parts);
}

/**	Send `sql` as a COM_QUERY string packet, reassemble the wire stream, and assert it round-trips exactly.
 **/
async function assertRoundTrip(sql: string, what: string)
{	const conn = new TestWriter(new CollectingWriter as Any, undefined as Any, new TextDecoder, new Uint8Array(BUFFER_LEN));
	await conn.sendStringPacket(COM_QUERY, sql);
	const payload = reassemblePayload(concat(conn.collected.chunks));
	const expected = concat([Uint8Array.of(COM_QUERY), encoder.encode(sql)]);
	assertEquals(payload.length, expected.length, `${what}: reassembled payload length`);
	assert(payload.every((byte, i) => byte === expected[i]), `${what}: reassembled payload bytes differ`);
}

Deno.test
(	'sendWithData() splits long UTF-8 strings across 16 MiB packet boundaries without hanging',
	async () =>
	{	// The COM_QUERY command byte occupies 1 byte of the first packet, so its string capacity is
		// 0xFFFFFF-1 = 16777214 bytes. A leading ASCII pad shifts which part of a multi-byte character
		// lands on the packet boundary. When a character straddles it, its first 1..3 bytes must complete
		// the current packet and the rest must begin the next one - the case that used to loop forever.
		const cases =
		[	// '€' is 3 bytes: 16777214 % 3 == 2, so pad '' splits a char leaving a 1-byte tail,
			// pad 'a' leaves a 2-byte tail, and pad 'ab' is the aligned control (no split)
			{pad: '', char: '€', count: 6_000_000},
			{pad: 'a', char: '€', count: 6_000_000},
			{pad: 'ab', char: '€', count: 6_000_000},
			// '😀' is 4 bytes: 16777214 % 4 == 2, so pads '', 'a', 'abc' leave 2-, 3- and 1-byte tails
			{pad: '', char: '😀', count: 4_500_000},
			{pad: 'a', char: '😀', count: 4_500_000},
			{pad: 'abc', char: '😀', count: 4_500_000},
		];
		for (const {pad, char, count} of cases)
		{	// ~18 MB of UTF-8, larger than one 0xFFFFFF packet
			await assertRoundTrip(pad + char.repeat(count), `pad=${JSON.stringify(pad)} char=${JSON.stringify(char)}`);
		}
	}
);

Deno.test
(	'Split character tail begins a tiny final packet that fits the send buffer',
	async () =>
	{	// 1 (command) + 1 (pad) + 5592415*3 bytes: the first packet ends 1 byte into a '€',
		// and the remaining 32 bytes (2-byte tail + 10 chars) form a final packet smaller
		// than the 8 KiB send buffer, exercising the buffered final-packet branch with a carry.
		await assertRoundTrip('a' + '€'.repeat(5_592_415), 'tiny final packet');
	}
);

Deno.test
(	'Characters split at two consecutive 16 MiB packet boundaries',
	async () =>
	{	// ~33.6 MB: both continuation packet boundaries fall inside a '€', so a carry must
		// propagate across packets twice, and the large final packet begins with a tail too.
		await assertRoundTrip('a' + '€'.repeat(11_200_000), 'two straddled boundaries');
	}
);

Deno.test
(	'TextEncoder.encodeInto() emits nothing when a multi-byte character does not fit (root-cause invariant)',
	() =>
	{	// This is why the unguarded incremental encoder looped: it never places a partial character, so a
		// destination too small for the next character yields {read: 0, written: 0} and makes no progress.
		const {read, written} = encoder.encodeInto('€', new Uint8Array(2));
		assertEquals(read, 0);
		assertEquals(written, 0);
	}
);

/**	Parse a stream of complete command packets (each restarts the sequence id at 0, as
	`COM_STMT_SEND_LONG_DATA` and the following `COM_STMT_EXECUTE` do) and return their payloads.
 **/
function splitCommandPackets(wire: Uint8Array)
{	const payloads: Uint8Array[] = [];
	let pos = 0;
	while (pos < wire.length)
	{	assert(pos+4 <= wire.length, 'truncated packet header');
		const len = wire[pos] | (wire[pos+1] << 8) | (wire[pos+2] << 16);
		assertEquals(wire[pos+3], 0, 'command packet must have sequence id 0');
		assert(len < CONTINUATION, 'unexpected continuation packet');
		pos += 4;
		assert(pos+len <= wire.length, 'truncated packet body');
		payloads.push(wire.subarray(pos, pos+len));
		pos += len;
	}
	return payloads;
}

Deno.test
(	'Queued COM_STMT_SEND_LONG_DATA packets survive a deferred payload tail',
	async () =>
	{	// Blob sizes that drive the send buffer through every state transition. The production shape
		// (3186, 3186, 3192, 3186, 208149 - the `st_uploaded_media_362` batch of 2026-08-24): two blobs
		// queue whole, the third overflows the 8 KiB buffer - its packet header goes out declaring the
		// full payload, and the payload itself stays behind as a deferred tail. Starting the fourth
		// blob's packet used to restart the buffer from offset 0, overwriting that tail: the server
		// then read the fourth packet's bytes as the third's payload and the connection desynced
		// ("Got packets out of order" / BrokenPipe). The second shape defers on the second blob.
		const shapes =
		[	[3186, 3186, 3192, 3186, 208149],
			[7000, 3000, 5000],
			[300, 300, 300, 300, 300, 300, 300, 300, 300, 300, 300, 300, 300, 300, 300, 300, 300, 300, 300, 300, 300, 300, 300, 300, 300, 300, 8000, 100],
		];
		const stmtId = 1;
		for (const shape of shapes)
		{	const blobs = shape.map((size, i) => new Uint8Array(size).map((_, j) => (i*31 + j) & 0xFF));
			const conn = new TestWriter(new CollectingWriter as Any, undefined as Any, new TextDecoder, new Uint8Array(BUFFER_LEN));
			await conn.sendLongDataSequence(stmtId, blobs);
			const payloads = splitCommandPackets(concat(conn.collected.chunks));
			assertEquals(payloads.length, blobs.length+1, `shape ${shape.join(',')}: packet count`);
			for (let i=0; i<blobs.length; i++)
			{	const expected = new Uint8Array(7 + blobs[i].length);
				expected[0] = COM_STMT_SEND_LONG_DATA;
				new DataView(expected.buffer).setUint32(1, stmtId, true);
				new DataView(expected.buffer).setUint16(5, i, true);
				expected.set(blobs[i], 7);
				const actual = payloads[i];
				assertEquals(actual.length, expected.length, `shape ${shape.join(',')}: packet ${i} length`);
				assert(actual.every((byte, j) => byte === expected[j]), `shape ${shape.join(',')}: packet ${i} bytes differ`);
			}
			const last = payloads[blobs.length];
			assertEquals(last.length, 5, `shape ${shape.join(',')}: final packet length`);
			assertEquals(last[0], COM_STMT_EXECUTE);
		}
	}
);
