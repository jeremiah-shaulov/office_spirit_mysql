import {debugAssert} from './debug_assert.ts';
import {utf8StringLength} from './utf8_string_length.ts';
import {MyProtocolReader, COMPRESSED_HEADER_LEN, Compression} from './my_protocol_reader.ts';
import {RdStream} from './deps.ts';
import {SendWithDataError} from "./errors.ts";
import {Reader, Seeker} from './deno_ifaces.ts';
import {promiseAllSettledThrow} from './promise_all_settled_throw.ts';
import {deflateBound, deflateInto, zstdCompressBound, zstdCompressInto} from './deflate_into.ts';

const MAX_CAN_WAIT_PACKET_PRELUDE_BYTES = 12; // >= packet header (4-byte) + COM_STMT_SEND_LONG_DATA (1-byte) + stmt_id (4-byte) + n_param (2-byte)

const MAX_COMPRESSED_PAYLOAD_LEN = 0xFFFFFF; // the compressed packet payload length is 3-byte
const MIN_COMPRESS_LEN = 50; // like libmysql's MIN_COMPRESS_LENGTH: compressing shorter payloads is not worth the overhead, so they're sent uncompressed
const NO_COMMAND_STARTS = new Array<number>; // no command begins in the bytes being compressed (always empty, never modified)

interface ToSqlBytes
{	toSqlBytesWithParamsBackslashAndBuffer(putParamsTo: unknown[]|undefined, noBackslashEscapes: boolean, buffer: Uint8Array): Uint8Array;
}
export type SqlSource =
	string |
	Uint8Array |
	({readonly readable: ReadableStream<Uint8Array>} | Reader) & ({readonly size: number} | Seeker) |
	ToSqlBytes;

const encoder = new TextEncoder;

/**	Starting from stable state (bufferEnd == bufferStart) you can start writing packets.
	It's possible to write multiple packets, and then send them all, or to send each packet immediately after writing it.

	```ts
	// Send 1 packet
	this.startWritingNewPacket(true);
	this.writeUint8(Command.COM_RESET_CONNECTION);
	await this.send();

	// Send batch of 2 packets
	this.startWritingNewPacket(true);
	this.writeUint8(Command.COM_RESET_CONNECTION);
	this.startWritingNewPacket(true);
	this.writeUint8(Command.COM_INIT_DB);
	this.writeString('test');
	await this.send();
	```

	At the end of the operation (after each sending) the object will be left in the stable state.

	When using `send()` to send the packets, all the written packets must fit the size of `this.buffer` (it's up to you to ensure this).
	To send a long packet, use `sendWithData()`.
 **/
export class MyProtocolReaderWriter extends MyProtocolReader
{	/**	Buffer offsets at which a command begins, for each not yet sent command in `this.buffer`.
		Only tracked in the compressed protocol - see {@link sendPackets()} for how the commands must be laid out over the compressed packets.
	 **/
	#commandStarts = new Array<number>;

	constructor(protected writer: WritableStreamDefaultWriter<Uint8Array>, reader: ReadableStreamBYOBReader, decoder: TextDecoder, useBuffer: Uint8Array|undefined)
	{	super(reader, decoder, useBuffer);
	}

	protected ensureRoom(room: number)
	{	const wantLen = this.bufferEnd + room;
		if (wantLen > this.buffer.length)
		{	debugAssert(Number.isFinite(wantLen));
			let len = this.buffer.length * 2;
			while (len < wantLen)
			{	len *= 2;
			}
			const newBuffer = new Uint8Array(len);
			newBuffer.set(this.buffer);
			this.buffer = newBuffer;
		}
	}

	protected startWritingNewPacket(resetSequenceId=false)
	{	if (this.bufferEnd == this.bufferStart)
		{	this.bufferStart = 0;
			this.bufferEnd = 4; // after header
			this.#commandStarts.length = 0; // the buffer content restarts from offset 0, so the recorded offsets (if any) don't refer to anything anymore
		}
		else
		{	// continuation (queue another packet after existing not written one)
			this.setHeader(this.bufferEnd - this.bufferStart - 4);
			this.bufferStart = this.bufferEnd;
			this.bufferEnd += 4; // after header
		}
		if (resetSequenceId)
		{	this.sequenceId = 0;
			if (this.compression)
			{	// the new packet begins a command, so it must begin its own compressed packet - see `sendPackets()`
				this.#commandStarts.push(this.bufferStart);
			}
		}
	}

	protected discardPacket()
	{	debugAssert(this.bufferEnd >= this.bufferStart+4);
		this.bufferEnd = this.bufferStart;
		if (this.#commandStarts[this.#commandStarts.length-1] == this.bufferStart)
		{	this.#commandStarts.pop();
		}
	}

	protected writeUint8(value: number)
	{	debugAssert(this.bufferEnd < this.buffer.length); // please, call ensureRoom() if writing long packet
		this.buffer[this.bufferEnd++] = value;
	}

	protected writeInt8(value: number)
	{	debugAssert(this.bufferEnd < this.buffer.length); // please, call ensureRoom() if writing long packet
		new DataView(this.buffer.buffer).setInt8(this.bufferEnd, value);
		this.bufferEnd++;
	}

	protected writeUint16(value: number)
	{	debugAssert(this.buffer.length-this.bufferEnd >= 2); // please, call ensureRoom() if writing long packet
		new DataView(this.buffer.buffer).setUint16(this.bufferEnd, value, true);
		this.bufferEnd += 2;
	}

	protected writeInt16(value: number)
	{	debugAssert(this.buffer.length-this.bufferEnd >= 2); // please, call ensureRoom() if writing long packet
		new DataView(this.buffer.buffer).setInt16(this.bufferEnd, value, true);
		this.bufferEnd += 2;
	}

	/*protected writeUint24(value: number)
	{	debugAssert(this.buffer.length-this.bufferEnd >= 3); // please, call ensureRoom() if writing long packet
		new DataView(this.buffer.buffer).setUint16(this.bufferEnd, value&0xFFFF, true);
		this.bufferEnd += 2;
		this.buffer[this.bufferEnd++] = value >> 16;
	}*/

	protected writeUint32(value: number)
	{	debugAssert(this.buffer.length-this.bufferEnd >= 4); // please, call ensureRoom() if writing long packet
		new DataView(this.buffer.buffer).setUint32(this.bufferEnd, value, true);
		this.bufferEnd += 4;
	}

	protected writeInt32(value: number)
	{	debugAssert(this.buffer.length-this.bufferEnd >= 4); // please, call ensureRoom() if writing long packet
		new DataView(this.buffer.buffer).setInt32(this.bufferEnd, value, true);
		this.bufferEnd += 4;
	}

	protected writeUint64(value: bigint)
	{	debugAssert(this.buffer.length-this.bufferEnd >= 8); // please, call ensureRoom() if writing long packet
		new DataView(this.buffer.buffer).setBigUint64(this.bufferEnd, value, true);
		this.bufferEnd += 8;
	}

	protected writeInt64(value: bigint)
	{	debugAssert(this.buffer.length-this.bufferEnd >= 8); // please, call ensureRoom() if writing long packet
		new DataView(this.buffer.buffer).setBigInt64(this.bufferEnd, value, true);
		this.bufferEnd += 8;
	}

	protected writeFloat(value: number)
	{	debugAssert(this.buffer.length-this.bufferEnd >= 4); // please, call ensureRoom() if writing long packet
		new DataView(this.buffer.buffer).setFloat32(this.bufferEnd, value, true);
		this.bufferEnd += 4;
	}

	protected writeLenencInt(value: number|bigint)
	{	if (value < 0)
		{	throw new Error('Must be nonnegative number');
		}
		else if (value < 0xFB)
		{	debugAssert(this.bufferEnd < this.buffer.length); // please, call ensureRoom() if writing long packet
			this.buffer[this.bufferEnd++] = Number(value);
		}
		else if (value <= 0xFFFF)
		{	debugAssert(this.buffer.length-this.bufferEnd >= 3); // please, call ensureRoom() if writing long packet
			this.buffer[this.bufferEnd++] = 0xFC;
			new DataView(this.buffer.buffer).setUint16(this.bufferEnd, Number(value), true);
			this.bufferEnd += 2;
		}
		else if (value <= 0xFFFFFF)
		{	debugAssert(this.buffer.length-this.bufferEnd >= 4); // please, call ensureRoom() if writing long packet
			const n = Number(value);
			this.buffer[this.bufferEnd++] = 0xFD;
			new DataView(this.buffer.buffer).setUint16(this.bufferEnd, n&0xFFFF, true);
			this.bufferEnd += 2;
			this.buffer[this.bufferEnd++] = n >> 16;
		}
		else
		{	debugAssert(this.buffer.length-this.bufferEnd >= 9); // please, call ensureRoom() if writing long packet
			this.buffer[this.bufferEnd++] = 0xFE;
			new DataView(this.buffer.buffer).setBigUint64(this.bufferEnd, BigInt(value), true);
			this.bufferEnd += 8;
		}
	}

	protected writeDouble(value: number)
	{	debugAssert(this.buffer.length-this.bufferEnd >= 8); // please, call ensureRoom() if writing long packet
		new DataView(this.buffer.buffer).setFloat64(this.bufferEnd, value, true);
		this.bufferEnd += 8;
	}

	protected writeZero(nBytes: number)
	{	debugAssert(this.buffer.length-this.bufferEnd >= nBytes); // please, call ensureRoom() if writing long packet
		this.buffer.fill(0, this.bufferEnd, this.bufferEnd+nBytes);
		this.bufferEnd += nBytes;
	}

	protected writeShortBytes(bytes: Uint8Array)
	{	debugAssert(this.buffer.length-this.bufferEnd >= bytes.byteLength); // please, call ensureRoom() if writing long packet
		this.buffer.set(bytes, this.bufferEnd);
		this.bufferEnd += bytes.byteLength;
	}

	protected writeShortLenencBytes(bytes: Uint8Array)
	{	this.writeLenencInt(bytes.length);
		this.writeShortBytes(bytes);
	}

	protected writeShortNulBytes(bytes: Uint8Array)
	{	const z = bytes.indexOf(0);
		if (z == -1)
		{	this.writeShortBytes(bytes);
			this.writeUint8(0);
		}
		else
		{	this.writeShortBytes(bytes.subarray(0, z+1));
		}
	}

	protected writeShortString(value: string)
	{	const {read, written} = encoder.encodeInto(value, this.buffer.subarray(this.bufferEnd));
		debugAssert(read == value.length);
		this.bufferEnd += written;
		debugAssert(this.bufferEnd <= this.buffer.length);
	}

	protected writeShortLenencString(value: string)
	{	if (value.length < 0x80)
		{	// guess 1-byte length
			const {read, written} = encoder.encodeInto(value, this.buffer.subarray(this.bufferEnd + 1));
			debugAssert(read == value.length);
			if (written < 0xFB)
			{	// 1-byte length
				this.buffer[this.bufferEnd++] = written;
			}
			else
			{	// 3-byte length
				this.buffer[this.bufferEnd++] = 0xFC;
				this.buffer.copyWithin(this.bufferEnd+2, this.bufferEnd, this.bufferEnd+written);
				new DataView(this.buffer.buffer).setUint16(this.bufferEnd, written, true);
				this.bufferEnd += 2;
			}
			this.bufferEnd += written;
			debugAssert(this.bufferEnd <= this.buffer.length);
		}
		else if (value.length < (0x10000 / 4)) // assume max string length value.length*4, so value.length*4 < 0x10000
		{	// guess 3-byte length
			const {read, written} = encoder.encodeInto(value, this.buffer.subarray(this.bufferEnd + 3));
			debugAssert(read == value.length);
			if (written < 0xFB)
			{	// 1-byte length
				this.buffer[this.bufferEnd++] = written;
				this.buffer.copyWithin(this.bufferEnd, this.bufferEnd+2, this.bufferEnd+2+written);
			}
			else
			{	// 3-byte length
				this.buffer[this.bufferEnd++] = 0xFC;
				new DataView(this.buffer.buffer).setUint16(this.bufferEnd, written, true);
				this.bufferEnd += 2;
			}
			this.bufferEnd += written;
			debugAssert(this.bufferEnd <= this.buffer.length);
		}
		else
		{	const data = encoder.encode(value);
			this.writeLenencInt(data.length);
			this.writeShortBytes(data);
		}
	}

	protected writeShortNulString(value: string)
	{	this.writeShortNulBytes(encoder.encode(value));
	}

	protected async writeReadChunk(value: Reader)
	{	debugAssert(this.bufferEnd < this.buffer.length); // please, call ensureRoom() if writing long packet
		const n = await value.read(this.buffer.subarray(this.bufferEnd));
		if (n != null)
		{	this.bufferEnd += n;
		}
		return n;
	}

	setHeader(payloadLength: number)
	{	const header = payloadLength | (this.sequenceId << 24);
		this.sequenceId++;
		new DataView(this.buffer.buffer).setUint32(this.bufferStart, header, true);
	}

	protected send()
	{	this.setHeader(this.bufferEnd - this.bufferStart - 4);
		const n = this.bufferEnd;
		// prepare for reader
		this.bufferStart = 0;
		this.bufferEnd = 0;
		// send
		return this.sendPackets(n);
	}

	/**	Send `this.buffer[0 .. end)` to the connection. The bytes are packets, each beginning with its 4-byte header
		(only the last packet is allowed to be cut, when the caller will complete it with {@link sendData()} calls).
		In the ordinary protocol this is a single write.
		In the compressed protocol, each command must begin its own compressed packet,
		with the compressed packet numbering restarted from 0 - like libmysql, that never lets 2 commands share a compressed packet, does.
		The server (both MySQL and MariaDB) counts the compressed packets it receives within each command read cycle,
		and can overwrite the tail of a decompressed packet in it's buffer when it writes a response,
		swallowing the command that shared the compressed packet with the previous command.
		The command boundaries are recorded by `startWritingNewPacket(resetSequenceId=true)` in `this.#commandStarts`
		(as offsets, not as slices of `this.buffer`, because the buffer can be reallocated by `ensureRoom()`, or detached and rebound by a BYOB read, before the bytes are sent),
		and bytes that don't start a command (like `LOCAL INFILE` file data) continue the current compressed packet numbering.
		All the compressed packets go in 1 write to the connection.
	 **/
	protected sendPackets(end: number)
	{	if (!this.compression)
		{	return this.writer.write(this.buffer.subarray(0, end));
		}
		const out = this.#toCompressedPackets(this.buffer.subarray(0, end), this.#commandStarts);
		this.#commandStarts.length = 0;
		return this.writer.write(out);
	}

	/**	Send raw bytes to the connection - a continuation of the payload of the current packet, whose beginning was sent with {@link sendPackets()}.
		In the compressed protocol wraps the bytes in compressed packets, continuing the current numbering (no command begins in them).
		The compressed packets are built in `this.buffer` after the input (or from its beginning, if the input is an external array -
		safe, because a payload continuation can only be sent after the packets in the buffer were flushed).
	 **/
	protected sendData(data: Uint8Array)
	{	if (!this.compression)
		{	return this.writer.write(data);
		}
		return this.writer.write(this.#toCompressedPackets(data, NO_COMMAND_STARTS));
	}

	/**	Convert `data` to compressed packets, and return them as a single chunk, ready to be written to the connection in 1 write,
		so splitting a batch of commands at the command boundaries doesn't cost extra system calls.
		Each offset in `commandStarts` begins a new compressed packet, with the numbering restarted from 0, and the bytes between the offsets
		(and the ones before the first offset, that continue the payload of a previously sent packet) go in compressed packets that continue the numbering.
		A payload is sent compressed (with the negotiated algorithm - zlib or zstd) if this makes it shorter, and verbatim otherwise
		(with 0 in the "uncompressed length" header field).
		Each payload is compressed directly to its final position in the chunk (see {@link deflateInto()} and {@link zstdCompressInto()}),
		so the chunk must have space for the worst case, as if nothing gets shorter: the compression bound of every payload, plus the headers.
		The chunk is placed to the free space in `this.buffer` after the input (that usually occupies its beginning), and only when the worst case
		doesn't fit there, a temporary buffer is allocated. `this.buffer` is never grown for this, because several senders size their reads
		by `this.buffer.length` (like the `LOCAL INFILE` chunk reader, that fills the whole buffer before each send), so growing it
		for the compressed output would make the next input bigger, and the buffer would keep growing exponentially till the end of the stream.
	 **/
	#toCompressedPackets(data: Uint8Array, commandStarts: number[])
	{	// The worst case: each part takes the 7-byte header + up to the compression bound of its payload + 1 spare byte
		// (`deflateInto()` and `zstdCompressInto()` require the spare byte to never continue to an internally allocated buffer).
		// The variable term of the bound (the shifts) is subadditive, so applying it to the whole input covers any splitting,
		// and its constant term (13 for `deflateBound()`, up to 64 for `zstdCompressBound()`, whose length-dependent last term only shrinks
		// as the length grows), the header and the spare byte are taken per part.
		const isZstd = this.compression == Compression.ZSTD;
		const end = data.length;
		const nParts = commandStarts.length + 1 + (end / MAX_COMPRESSED_PAYLOAD_LEN | 0); // upper bound on the number of parts
		const worstLen = (isZstd ? zstdCompressBound(end) + nParts*(COMPRESSED_HEADER_LEN + 64 + 1) : deflateBound(end) + nParts*(COMPRESSED_HEADER_LEN + 13 + 1));
		let out = this.buffer;
		let writeAt = data.buffer===out.buffer ? data.byteOffset + data.length : 0; // after the input, if the input is inside `this.buffer`
		if (out.length-writeAt < worstLen)
		{	out = new Uint8Array(worstLen);
			writeAt = 0;
		}
		let outPos = writeAt;
		let from = 0;
		let {compressedSeqId, zstdLevel} = this;
		let nextSeqId = compressedSeqId;
		for (let i=0, iEnd=commandStarts.length; i<=iEnd; i++)
		{	const to = i<iEnd ? commandStarts[i] : end; // the part [from .. to) is the bytes of 1 command (or a continuation, if it precedes the first command start)
			if (to > from)
			{	compressedSeqId = nextSeqId;
				for (let pos=from; pos<to; pos+=MAX_COMPRESSED_PAYLOAD_LEN)
				{	const part = data.subarray(pos, Math.min(pos+MAX_COMPRESSED_PAYLOAD_LEN, to));
					const dataPos = outPos + COMPRESSED_HEADER_LEN;
					let dataLen = part.length;
					let uncompressedLen = 0;
					if (part.length >= MIN_COMPRESS_LEN)
					{	const compressedLen = isZstd ? zstdCompressInto(out, dataPos, part, zstdLevel) : deflateInto(out, dataPos, part);
						if (compressedLen < part.length)
						{	dataLen = compressedLen;
							uncompressedLen = part.length;
						}
					}
					if (uncompressedLen == 0)
					{	out.set(part, dataPos); // the payload travels verbatim (overwrites the compression attempt, if there was one)
					}
					out[outPos++] = dataLen & 0xFF;
					out[outPos++] = (dataLen >> 8) & 0xFF;
					out[outPos++] = dataLen >> 16;
					out[outPos++] = compressedSeqId;
					out[outPos++] = uncompressedLen & 0xFF;
					out[outPos++] = (uncompressedLen >> 8) & 0xFF;
					out[outPos++] = uncompressedLen >> 16;
					outPos = dataPos + dataLen;
					compressedSeqId = (compressedSeqId + 1) & 0xFF;
				}
				from = to;
			}
			nextSeqId = 0; // each following part begins a command
		}
		this.compressedSeqId = compressedSeqId;
		return out.subarray(writeAt, outPos);
	}

	/**	Append long data to the end of current packet, and send the packet (or split to several packets and send them).
	 **/
	protected async sendWithData(data: SqlSource, noBackslashEscapes: boolean, logData?: (data: Uint8Array) => Promise<unknown>, canWait=false, putParamsTo?: unknown[])
	{	debugAssert(this.bufferEnd > this.bufferStart); // call startWritingNewPacket() first
		if (typeof(data)=='object' && 'toSqlBytesWithParamsBackslashAndBuffer' in data)
		{	data = data.toSqlBytesWithParamsBackslashAndBuffer(putParamsTo, noBackslashEscapes, this.buffer.subarray(this.bufferEnd));
			if (data.buffer == this.buffer.buffer)
			{	this.bufferEnd += data.length;
				debugAssert(!canWait); // after sending Sql queries response always follows
				if (!logData)
				{	await this.send();
				}
				else
				{	await promiseAllSettledThrow([logData(data), this.send()]);
				}
				return false;
			}
		}
		if (data instanceof Uint8Array)
		{	const logPromise = !logData ? undefined : logData(data);
			const packetSize = this.bufferEnd - this.bufferStart - 4 + data.length;
			try
			{	let packetSizeRemaining = packetSize;
				while (packetSizeRemaining >= 0xFFFFFF)
				{	// send current packet part + data chunk = 0xFFFFFF
					this.setHeader(0xFFFFFF);
					await this.sendPackets(this.bufferEnd); // send including packets before this.buffer_start
					const dataChunkLen = 0xFFFFFF - (this.bufferEnd - this.bufferStart - 4);
					await this.sendData(data.subarray(0, dataChunkLen));
					data = data.subarray(dataChunkLen);
					this.bufferStart = 0;
					this.bufferEnd = 4; // after header
					packetSizeRemaining = data.length;
				}
				debugAssert(packetSizeRemaining < 0xFFFFFF);
				if (this.bufferStart+4+packetSizeRemaining <= this.buffer.length) // if previous packets + header + payload can fit my buffer
				{	this.buffer.set(data, this.bufferEnd);
					this.bufferEnd += data.length;
					if (canWait && this.bufferEnd+MAX_CAN_WAIT_PACKET_PRELUDE_BYTES <= this.buffer.length)
					{	return true;
					}
					this.setHeader(packetSizeRemaining);
					await this.sendPackets(this.bufferEnd);
				}
				else
				{	this.setHeader(packetSizeRemaining);
					await this.sendPackets(this.bufferEnd); // send including packets before this.buffer_start
					if (canWait && !this.compression && data.length+MAX_CAN_WAIT_PACKET_PRELUDE_BYTES <= this.buffer.length)
					{	// (in the compressed protocol don't defer the packet tail, to keep the compressed packet layout simple)
						this.buffer.set(data);
						this.bufferStart = data.length;
						this.bufferEnd = data.length;
						return true;
					}
					await this.sendData(data);
				}
			}
			catch (e)
			{	throw new SendWithDataError(e instanceof Error ? e.message : e+'', packetSize);
			}
			finally
			{	if (logPromise)
				{	await logPromise;
				}
			}
		}
		else if (typeof(data) == 'string')
		{	let dataLength = data.length * 4;
			if (this.bufferEnd+dataLength > this.buffer.length)
			{	dataLength = utf8StringLength(data);
			}
			if (this.bufferEnd+dataLength <= this.buffer.length)
			{	// short string
				const from = this.bufferEnd;
				this.writeShortString(data);
				if (canWait && this.bufferEnd+MAX_CAN_WAIT_PACKET_PRELUDE_BYTES <= this.buffer.length)
				{	if (logData)
					{	await logData(this.buffer.subarray(from, this.bufferEnd));
					}
					return true;
				}
				if (!logData)
				{	await this.send();
				}
				else
				{	await promiseAllSettledThrow([logData(this.buffer.subarray(from, this.bufferEnd)), this.send()]);
				}
				return false;
			}
			else
			{	// long string
				const packetSize = this.bufferEnd - this.bufferStart - 4 + dataLength;
				try
				{	// A packet boundary can fall in the middle of a multi-byte UTF-8 character, because MySQL
					// reassembles the multi-packet payload byte-for-byte before parsing it. But `encodeInto()`
					// never emits partial characters (it returns `{read: 0, written: 0}` if the next character
					// doesn't fit the destination), so such a straddling character is encoded to `carry` and split
					// by hand: the current packet is completed with `carry[0 .. carryStart]`, and the next packet's
					// payload begins with `carry[carryStart .. carryEnd]`.
					const carry = new Uint8Array(4); // 4 == max length of a UTF-8 encoded character
					let carryStart = 0;
					let carryEnd = 0;
					let packetSizeRemaining = packetSize;
					while (packetSizeRemaining >= 0xFFFFFF)
					{	// send current packet part + data chunk = 0xFFFFFF
						this.setHeader(0xFFFFFF);
						await this.sendPackets(this.bufferEnd); // send including packets before this.bufferStart
						let dataChunkLen = 0xFFFFFF - (this.bufferEnd - this.bufferStart - 4);
						dataLength -= dataChunkLen;
						while (dataChunkLen > 0)
						{	let part: Uint8Array;
							if (carryEnd > carryStart)
							{	// the tail of the character that was split at the previous packet boundary
								part = carry.subarray(carryStart, carryEnd);
								carryStart = carryEnd;
							}
							else
							{	const {read, written} = encoder.encodeInto(data, this.buffer.subarray(0, dataChunkLen));
								if (written > 0)
								{	data = data.slice(read);
									part = this.buffer.subarray(0, written);
								}
								else
								{	// a multi-byte character straddles the packet boundary (1 to 3 bytes of space remain)
									const char = String.fromCodePoint(data.codePointAt(0)!);
									const charLen = encoder.encodeInto(char, carry).written;
									debugAssert(charLen > dataChunkLen);
									data = data.slice(char.length);
									part = carry.subarray(0, dataChunkLen);
									carryStart = dataChunkLen;
									carryEnd = charLen;
								}
							}
							if (!logData)
							{	await this.sendData(part);
							}
							else
							{	await promiseAllSettledThrow([logData(part), this.sendData(part)]);
							}
							dataChunkLen -= part.length;
						}
						this.bufferStart = 0;
						this.bufferEnd = 4; // after header
						packetSizeRemaining = dataLength;
					}
					debugAssert(packetSizeRemaining < 0xFFFFFF);
					if (this.bufferStart+4+packetSizeRemaining <= this.buffer.length) // if previous packets + header + payload can fit my buffer
					{	const from = this.bufferEnd;
						if (carryEnd > carryStart)
						{	// the tail of the character that was split at the last packet boundary
							this.buffer.set(carry.subarray(carryStart, carryEnd), this.bufferEnd);
							this.bufferEnd += carryEnd - carryStart;
							dataLength -= carryEnd - carryStart;
							carryStart = carryEnd;
						}
						const {read, written} = encoder.encodeInto(data, this.buffer.subarray(this.bufferEnd));
						debugAssert(read == data.length);
						debugAssert(written == dataLength);
						this.bufferEnd += written;
						if (canWait && this.bufferEnd+MAX_CAN_WAIT_PACKET_PRELUDE_BYTES <= this.buffer.length)
						{	if (logData)
							{	await logData(this.buffer.subarray(from, this.bufferEnd));
							}
							return true;
						}
						this.setHeader(packetSizeRemaining);
						if (!logData)
						{	await this.sendPackets(this.bufferEnd);
						}
						else
						{	await promiseAllSettledThrow([logData(this.buffer.subarray(from, this.bufferEnd)), this.sendPackets(this.bufferEnd)]);
						}
					}
					else
					{	this.setHeader(packetSizeRemaining);
						await this.sendPackets(this.bufferEnd); // send including packets before this.bufferStart
						if (carryEnd > carryStart)
						{	// the tail of the character that was split at the last packet boundary
							const part = carry.subarray(carryStart, carryEnd);
							dataLength -= part.length;
							carryStart = carryEnd;
							if (!logData)
							{	await this.sendData(part);
							}
							else
							{	await promiseAllSettledThrow([logData(part), this.sendData(part)]);
							}
						}
						while (dataLength > 0)
						{	const {read, written} = encoder.encodeInto(data, this.buffer.subarray(0, Math.min(dataLength, this.buffer.length)));
							data = data.slice(read);
							dataLength -= written;
							const part = this.buffer.subarray(0, written);
							if (!logData)
							{	await this.sendData(part);
							}
							else
							{	await promiseAllSettledThrow([logData(part), this.sendData(part)]);
							}
						}
					}
				}
				catch (e)
				{	throw new SendWithDataError(e instanceof Error ? e.message : e+'', packetSize);
				}
			}
		}
		else // (Reader | {readonly readable: ReadableStream<Uint8Array>}) & (Seeker | {readonly size: number})
		{	// 1. Calc the size of the data to send
			let dataLength: number;
			if ('size' in data)
			{	dataLength = data.size;
			}
			else
			{	const pos = await data.seek(0, Deno.SeekMode.Current);
				dataLength = await data.seek(0, Deno.SeekMode.End);
				await data.seek(pos, Deno.SeekMode.Start);
				dataLength -= pos;
			}
			// 2. If 0, use `this.send()`
			if (dataLength <= 0)
			{	if (canWait && this.bufferEnd+MAX_CAN_WAIT_PACKET_PRELUDE_BYTES <= this.buffer.length)
				{	return true;
				}
				await this.send();
				return false;
			}
			// 3. Get `ReadableStream`
			let readable;
			if ('read' in data)
			{	const reader = data;
				readable = new RdStream({read: b => reader.read(b)});
			}
			else
			{	readable = data.readable;
			}
			// 4. Get reader
			const reader = readable.getReader({mode: 'byob'});
			// 5. Calc packet size
			const alreadyFilled = this.bufferEnd - this.bufferStart - 4;
			const packetSize = alreadyFilled + dataLength;
			let canSend = Math.min(packetSize, 0xFFFFFF);
			let packetSizeRemaining = packetSize - canSend;
			this.setHeader(canSend);
			canSend -= alreadyFilled;
			this.bufferStart = 0; // `setHeader()` will set the header to the beginning of `this.buffer`
			// 6. If at least half buffer is used, send it's contents. Because later i'll read from the reader to the end of buffer.
			if (this.bufferEnd > this.buffer.length/2)
			{	try
				{	await this.sendPackets(this.bufferEnd);
				}
				catch (e)
				{	throw new SendWithDataError(e instanceof Error ? e.message : e+'', packetSize);
				}
				this.bufferEnd = 0;
			}
			// 7. Pipe
			while (true)
			{	const {value, done} = await reader.read(this.buffer.subarray(this.bufferEnd, this.bufferEnd+canSend));
				if (done)
				{	throw new Error(`Unexpected end of stream`);
				}
				this.buffer = new Uint8Array(value.buffer);
				try
				{	// when `bufferEnd > 0` the sent bytes begin with packet headers, and when it's 0, they're a continuation of the current packet payload
					const promise = this.bufferEnd>0 ? this.sendPackets(this.bufferEnd+value.length) : this.sendData(this.buffer.subarray(0, value.length));
					if (!logData)
					{	await promise;
					}
					else
					{	await promiseAllSettledThrow([logData(value), promise]);
					}
				}
				catch (e)
				{	throw new SendWithDataError(e instanceof Error ? e.message : e+'', packetSize);
				}
				canSend -= value.length;
				if (canSend > 0)
				{	this.bufferEnd = 0;
				}
				else
				{	if (packetSizeRemaining == 0)
					{	break;
					}
					canSend = Math.min(packetSizeRemaining, 0xFFFFFF);
					packetSizeRemaining -= canSend;
					this.setHeader(canSend);
					this.bufferEnd = 4;
				}
			}
		}
		// prepare for reader
		this.bufferStart = 0;
		this.bufferEnd = 0;
		return false;
	}
}
