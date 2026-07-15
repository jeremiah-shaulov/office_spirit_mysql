import {MyProtocolReaderWriter} from '../my_protocol_reader_writer.ts';
import {Compression} from '../my_protocol_reader.ts';
import {zstdDecompress, isZstdSupported} from '../deflate_into.ts';
import {ServerDisconnectedError} from '../errors.ts';
import {assert} from 'jsr:@std/assert@1.0.19/assert';
import {assertEquals} from 'jsr:@std/assert@1.0.19/equals';
import {inflateSync} from 'node:zlib';

/**	The algorithms to test: zstd only on runtimes that have it in `node:zlib`.
 **/
const ALGORITHMS = isZstdSupported() ? [Compression.ZLIB, Compression.ZSTD] : [Compression.ZLIB];

function decompress(algorithm: Compression, data: Uint8Array)
{	return new Uint8Array(algorithm==Compression.ZSTD ? zstdDecompress(data) : inflateSync(data));
}

// deno-lint-ignore no-explicit-any
type Any = any;

const encoder = new TextEncoder;

/**	A duck-typed `ReadableStreamBYOBReader` that serves the given bytes, at most `chunkSize` bytes per read,
	so it can simulate compressed packets arriving fragmented (partial headers, partial payloads).
 **/
class MockByobReader
{	#pos = 0;

	constructor(private data: Uint8Array, private chunkSize=Number.MAX_SAFE_INTEGER)
	{
	}

	read(view: Uint8Array<ArrayBufferLike>): Promise<{value: Uint8Array<ArrayBufferLike>, done: boolean}>
	{	if (this.#pos >= this.data.length)
		{	return Promise.resolve({value: new Uint8Array(view.buffer, view.byteOffset, 0), done: true});
		}
		const n = Math.min(view.byteLength, this.data.length-this.#pos, this.chunkSize);
		const value = new Uint8Array(view.buffer, view.byteOffset, n);
		value.set(this.data.subarray(this.#pos, this.#pos+n));
		this.#pos += n;
		return Promise.resolve({value, done: false});
	}

	releaseLock()
	{
	}
}

/**	A duck-typed `WritableStreamDefaultWriter` that collects the written chunks.
 **/
class MockWriter
{	packets = new Array<Uint8Array>;

	write(chunk: Uint8Array)
	{	this.packets.push(chunk.slice());
		return Promise.resolve();
	}

	releaseLock()
	{
	}
}

function concat(parts: Uint8Array[])
{	const result = new Uint8Array(parts.reduce((sum, p) => sum+p.length, 0));
	let pos = 0;
	for (const p of parts)
	{	result.set(p, pos);
		pos += p.length;
	}
	return result;
}

/**	Split a byte stream to the compressed packets it consists of.
 **/
function parseFrames(wire: Uint8Array)
{	const frames = new Array<{seqId: number, uncompressedLen: number, payload: Uint8Array}>;
	let pos = 0;
	while (pos < wire.length)
	{	const payloadLen = wire[pos] | wire[pos+1]<<8 | wire[pos+2]<<16;
		assert(pos+7+payloadLen <= wire.length, 'truncated compressed packet');
		frames.push
		(	{	seqId: wire[pos+3],
				uncompressedLen: wire[pos+4] | wire[pos+5]<<8 | wire[pos+6]<<16,
				payload: wire.subarray(pos+7, pos+7+payloadLen),
			}
		);
		pos += 7 + payloadLen;
	}
	return frames;
}

function getRandomBytes(len: number)
{	const data = new Uint8Array(len);
	for (let pos=0; pos<len; pos+=65536) // crypto.getRandomValues() refuses to generate more than 64 KiB at once
	{	crypto.getRandomValues(data.subarray(pos, pos+65536));
	}
	return data;
}

/**	Exposes the `protected` machinery for tests.
 **/
class TestProtocol extends MyProtocolReaderWriter
{	enableCompression(seqId=0, algorithm=Compression.ZLIB)
	{	this.compression = algorithm;
		this.compressedSeqId = seqId;
	}

	get curCompressedSeqId()
	{	return this.compressedSeqId;
	}

	setSequenceId(value: number)
	{	this.sequenceId = value;
	}

	queuePacket(payload: Uint8Array, resetSequenceId: boolean)
	{	this.startWritingNewPacket(resetSequenceId);
		this.writeShortBytes(payload);
	}

	doSend()
	{	return this.send();
	}

	doSendData(data: Uint8Array)
	{	return this.sendData(data);
	}

	doReadFromConn(view: Uint8Array)
	{	return this.readFromConn(view);
	}
}

function newWriteProtocol(mock: MockWriter, algorithm=Compression.ZLIB)
{	const protocol = new TestProtocol(mock as Any, undefined as Any, new TextDecoder, new Uint8Array(8*1024));
	protocol.enableCompression(0, algorithm);
	return protocol;
}

function newReadProtocol(wire: Uint8Array, serveChunkSize=Number.MAX_SAFE_INTEGER, algorithm=Compression.ZLIB)
{	const protocol = new TestProtocol(undefined as Any, new MockByobReader(wire, serveChunkSize) as Any, new TextDecoder, new Uint8Array(8*1024));
	protocol.enableCompression(0, algorithm);
	return protocol;
}

Deno.test
(	'Compressed protocol: sendData() frames and compresses',
	async () =>
	{	for (const algorithm of ALGORITHMS)
		{	const mock = new MockWriter;
			const protocol = newWriteProtocol(mock, algorithm);

			// Short payload (shorter than 50 bytes) is sent verbatim
			const short = encoder.encode('SELECT 1');
			await protocol.doSendData(short);
			assertEquals(mock.packets.length, 1);
			let packet = mock.packets[0];
			assertEquals(packet[0] | packet[1]<<8 | packet[2]<<16, short.length); // payload length
			assertEquals(packet[3], 0); // the first compressed packet of a command is numbered 0
			assertEquals(packet[4] | packet[5]<<8 | packet[6]<<16, 0); // 0 means not compressed
			assertEquals(packet.subarray(7), short);

			// Long compressible payload is compressed
			const long = new Uint8Array(1024).fill('a'.charCodeAt(0));
			await protocol.doSendData(long);
			assertEquals(mock.packets.length, 2);
			packet = mock.packets[1];
			const payloadLen = packet[0] | packet[1]<<8 | packet[2]<<16;
			assert(payloadLen < long.length);
			assertEquals(packet.length, 7+payloadLen);
			assertEquals(packet[3], 1); // sequence id incremented
			assertEquals(packet[4] | packet[5]<<8 | packet[6]<<16, long.length);
			assertEquals(decompress(algorithm, packet.subarray(7)), long);

			// Incompressible payload is sent verbatim, not inflated by the compression overhead
			const random = getRandomBytes(1024);
			await protocol.doSendData(random);
			assertEquals(mock.packets.length, 3);
			packet = mock.packets[2];
			assertEquals(packet[3], 2);
			assertEquals(packet[4] | packet[5]<<8 | packet[6]<<16, 0);
			assertEquals(packet.subarray(7), random);

			// The command boundary resets the sequence (the protocol does it in `sendPackets()`)
			protocol.enableCompression(0, algorithm);
			await protocol.doSendData(short);
			assertEquals(mock.packets[3][3], 0);
		}
	}
);

Deno.test
(	'Compressed protocol: round-trip',
	async () =>
	{	const parts =
		[	encoder.encode('SELECT 1'), // short, travels verbatim
			new Uint8Array(70*1024).fill('z'.charCodeAt(0)), // compressible
			getRandomBytes(1024), // incompressible, travels verbatim
			encoder.encode('The quick brown fox jumps over the lazy dog. '.repeat(100)), // compressible
		];
		const expected = concat(parts);
		for (const algorithm of ALGORITHMS)
		{	for (const serveChunkSize of [Number.MAX_SAFE_INTEGER, 7, 1]) // how fragmented the compressed packets arrive
			{	for (const viewSize of [8*1024, 3]) // how big destination views the consumer reads to
				{	// Write all the parts
					const mock = new MockWriter;
					const writeProtocol = newWriteProtocol(mock, algorithm);
					for (const p of parts)
					{	await writeProtocol.doSendData(p);
					}
					// Read them back
					const readProtocol = newReadProtocol(concat(mock.packets), serveChunkSize, algorithm);
					const result = new Uint8Array(expected.length);
					let pos = 0;
					let buffer: Uint8Array = new Uint8Array(viewSize);
					while (pos < expected.length)
					{	const {value, done} = await readProtocol.doReadFromConn(buffer);
						assert(!done, 'Unexpected EOF');
						assert(value.length > 0);
						result.set(value, pos);
						pos += value.length;
						buffer = new Uint8Array(value.buffer);
					}
					assertEquals(result, expected);
					// Then EOF
					const {value, done} = await readProtocol.doReadFromConn(buffer);
					assert(done);
					assertEquals(value?.length, 0);
					// The reader adopted the sequence id from the last packet header
					assertEquals(readProtocol.curCompressedSeqId, writeProtocol.curCompressedSeqId);
				}
			}
		}
	}
);

Deno.test
(	'Compressed protocol: splits chunks longer than 2**24-1 bytes',
	async () =>
	{	for (const algorithm of ALGORITHMS)
		{	const mock = new MockWriter;
			const protocol = newWriteProtocol(mock, algorithm);
			const chunk = new Uint8Array(0xFFFFFF + 100);
			for (let i=0; i<chunk.length; i++)
			{	chunk[i] = (i >> 10) & 0x7F; // slowly changing, so both fragments (16 MiB - 1 and 100 bytes) are compressible
			}
			await protocol.doSendData(chunk);
			assertEquals(mock.packets.length, 1); // both compressed packets in 1 write
			const frames = parseFrames(mock.packets[0]);
			assertEquals(frames.length, 2);
			assertEquals(frames[0].seqId, 0);
			assertEquals(frames[0].uncompressedLen, 0xFFFFFF);
			assertEquals(frames[1].seqId, 1);
			assertEquals(frames[1].uncompressedLen, 100);
			const restored = concat([decompress(algorithm, frames[0].payload), decompress(algorithm, frames[1].payload)]);
			assertEquals(restored, chunk);
		}
	}
);

Deno.test
(	'Compressed protocol: sendPackets() gives each command its own compressed packet',
	async () =>
	{	const mock = new MockWriter;
		const protocol = newWriteProtocol(mock);

		// 2 commands queued in the buffer must go in 2 compressed packets (sent in 1 write), each numbered 0
		protocol.enableCompression(7); // as if after reading a response
		protocol.queuePacket(encoder.encode('COMMAND A'), true);
		protocol.queuePacket(encoder.encode('COMMAND B'), true);
		await protocol.doSend();
		assertEquals(mock.packets.length, 1);
		let frames = parseFrames(mock.packets[0]);
		assertEquals(frames.length, 2);
		assertEquals(frames[0].seqId, 0); // compressed sequence id restarted
		assertEquals(frames[0].payload, concat([Uint8Array.of(9, 0, 0, 0), encoder.encode('COMMAND A')]));
		assertEquals(frames[1].seqId, 0); // restarted again for the next command
		assertEquals(frames[1].payload, concat([Uint8Array.of(9, 0, 0, 0), encoder.encode('COMMAND B')]));

		// A packet that doesn't start a command (like `LOCAL INFILE` file data) continues the current numbering
		protocol.enableCompression(5); // as if after reading the LOCAL INFILE request
		protocol.setSequenceId(2);
		protocol.queuePacket(encoder.encode('FILE DATA'), false);
		await protocol.doSend();
		assertEquals(mock.packets.length, 2);
		frames = parseFrames(mock.packets[1]);
		assertEquals(frames.length, 1);
		assertEquals(frames[0].seqId, 5); // not restarted
		assertEquals(frames[0].payload, concat([Uint8Array.of(9, 0, 0, 2), encoder.encode('FILE DATA')]));
		assertEquals(protocol.curCompressedSeqId, 6);
	}
);

Deno.test
(	'Compressed protocol: EOF in the middle of a packet',
	async () =>
	{	// Produce 1 valid compressed packet
		const mock = new MockWriter;
		const writeProtocol = newWriteProtocol(mock);
		await writeProtocol.doSendData(new Uint8Array(1024).fill('a'.charCodeAt(0)));
		const wire = concat(mock.packets);
		// EOF after a partial header, and after a partial payload
		for (const cutAt of [3, wire.length-1])
		{	const readProtocol = newReadProtocol(wire.subarray(0, cutAt));
			let caught: unknown;
			try
			{	await readProtocol.doReadFromConn(new Uint8Array(100));
			}
			catch (e)
			{	caught = e;
			}
			assert(caught instanceof ServerDisconnectedError, `expected ServerDisconnectedError, got ${caught?.constructor?.name}`);
		}
	}
);
