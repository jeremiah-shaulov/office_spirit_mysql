import {debugAssert} from './debug_assert.ts';
import {utf8StringLength} from './utf8_string_length.ts';
import {MyProtocolReader} from './my_protocol_reader.ts';
import {RdStream} from './deps.ts';
import {SendWithDataError} from "./errors.ts";
import {Reader, Seeker} from './deno_ifaces.ts';

const MAX_CAN_WAIT_PACKET_PRELUDE_BYTES = 12; // >= packet header (4-byte) + COM_STMT_SEND_LONG_DATA (1-byte) + stmt_id (4-byte) + n_param (2-byte)

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
{	constructor(protected writer: WritableStreamDefaultWriter<Uint8Array>, reader: ReadableStreamBYOBReader, decoder: TextDecoder, useBuffer: Uint8Array|undefined)
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
		}
		else
		{	// continuation (queue another packet after existing not written one)
			this.setHeader(this.bufferEnd - this.bufferStart - 4);
			this.bufferStart = this.bufferEnd;
			this.bufferEnd += 4; // after header
		}
		if (resetSequenceId)
		{	this.sequenceId = 0;
		}
	}

	protected discardPacket()
	{	debugAssert(this.bufferEnd >= this.bufferStart+4);
		this.bufferEnd = this.bufferStart;
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
		return this.writer.write(this.buffer.subarray(0, n));
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
				{	await Promise.all([logData(data), this.send()]);
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
					await this.writer.write(this.buffer.subarray(0, this.bufferEnd)); // send including packets before this.buffer_start
					const dataChunkLen = 0xFFFFFF - (this.bufferEnd - this.bufferStart - 4);
					await this.writer.write(data.subarray(0, dataChunkLen));
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
					await this.writer.write(this.buffer.subarray(0, this.bufferEnd));
				}
				else
				{	this.setHeader(packetSizeRemaining);
					await this.writer.write(this.buffer.subarray(0, this.bufferEnd)); // send including packets before this.buffer_start
					if (canWait && data.length+MAX_CAN_WAIT_PACKET_PRELUDE_BYTES <= this.buffer.length)
					{	this.buffer.set(data);
						this.bufferStart = data.length;
						this.bufferEnd = data.length;
						return true;
					}
					await this.writer.write(data);
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
				{	await Promise.all([logData(this.buffer.subarray(from, this.bufferEnd)), this.send()]);
				}
				return false;
			}
			else
			{	// long string
				const packetSize = this.bufferEnd - this.bufferStart - 4 + dataLength;
				try
				{	let packetSizeRemaining = packetSize;
					while (packetSizeRemaining >= 0xFFFFFF)
					{	// send current packet part + data chunk = 0xFFFFFF
						this.setHeader(0xFFFFFF);
						await this.writer.write(this.buffer.subarray(0, this.bufferEnd)); // send including packets before this.bufferStart
						let dataChunkLen = 0xFFFFFF - (this.bufferEnd - this.bufferStart - 4);
						dataLength -= dataChunkLen;
						while (dataChunkLen > 0)
						{	const {read, written} = encoder.encodeInto(data, this.buffer.subarray(0, dataChunkLen));
							data = data.slice(read);
							const part = this.buffer.subarray(0, written);
							if (!logData)
							{	await this.writer.write(part);
							}
							else
							{	await Promise.all([logData(part), this.writer.write(part)]);
							}
							dataChunkLen -= written;
						}
						this.bufferStart = 0;
						this.bufferEnd = 4; // after header
						packetSizeRemaining = dataLength;
					}
					debugAssert(packetSizeRemaining < 0xFFFFFF);
					if (this.bufferStart+4+packetSizeRemaining <= this.buffer.length) // if previous packets + header + payload can fit my buffer
					{	const {read, written} = encoder.encodeInto(data, this.buffer.subarray(this.bufferEnd));
						debugAssert(read == data.length);
						debugAssert(written == dataLength);
						this.bufferEnd += written;
						if (canWait && this.bufferEnd+MAX_CAN_WAIT_PACKET_PRELUDE_BYTES <= this.buffer.length)
						{	if (logData)
							{	await logData(this.buffer.subarray(this.bufferEnd-written, this.bufferEnd));
							}
							return true;
						}
						this.setHeader(packetSizeRemaining);
						if (!logData)
						{	await this.writer.write(this.buffer.subarray(0, this.bufferEnd));
						}
						else
						{	await Promise.all([logData(this.buffer.subarray(this.bufferEnd-written, this.bufferEnd)), this.writer.write(this.buffer.subarray(0, this.bufferEnd))]);
						}
					}
					else
					{	this.setHeader(packetSizeRemaining);
						await this.writer.write(this.buffer.subarray(0, this.bufferEnd)); // send including packets before this.bufferStart
						while (dataLength > 0)
						{	const {read, written} = encoder.encodeInto(data, this.buffer.subarray(0, Math.min(dataLength, this.buffer.length)));
							data = data.slice(read);
							dataLength -= written;
							const part = this.buffer.subarray(0, written);
							if (!logData)
							{	await this.writer.write(part);
							}
							else
							{	await Promise.all([logData(part), this.writer.write(part)]);
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
				{	await this.writer.write(this.buffer.subarray(0, this.bufferEnd));
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
				{	if (!logData)
					{	await this.writer.write(this.buffer.subarray(0, this.bufferEnd+value.length));
					}
					else
					{	await Promise.all([logData(value), this.writer.write(this.buffer.subarray(0, this.bufferEnd+value.length))]);
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
