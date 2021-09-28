import {debugAssert} from './debug_assert.ts';
import {utf8StringLength} from './utf8_string_length.ts';
import {MyProtocolReader} from './my_protocol_reader.ts';
import {writeAll} from './deps.ts';
import {SendWithDataError} from "./errors.ts";

const MAX_CAN_WAIT_PACKET_PRELUDE_BYTES = 12; // >= packet header (4-byte) + COM_STMT_SEND_LONG_DATA (1-byte) + stmt_id (4-byte) + n_param (2-byte)

// deno-lint-ignore no-explicit-any
type Any = any;

interface ToSqlBytes
{	toSqlBytesWithParamsBackslashAndBuffer(putParamsTo: Any[]|undefined, noBackslashEscapes: boolean, buffer: Uint8Array): Uint8Array;
}
export type SqlSource = string | Uint8Array | Deno.Reader&Deno.Seeker | Deno.Reader&{readonly size: number} | ToSqlBytes;

const encoder = new TextEncoder;

export class MyProtocolReaderWriter extends MyProtocolReader
{	protected startWritingNewPacket(resetSequenceId=false, packetStart=0)
	{	debugAssert(this.bufferEnd==this.bufferStart || packetStart>0); // must read all before starting to write
		this.bufferStart = packetStart;
		this.bufferEnd = packetStart + 4; // after header
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

	protected writeUint16(value: number)
	{	debugAssert(this.buffer.length-this.bufferEnd >= 2); // please, call ensureRoom() if writing long packet
		this.dataView.setUint16(this.bufferEnd, value, true);
		this.bufferEnd += 2;
	}

	/*protected writeUint24(value: number)
	{	debugAssert(this.buffer.length-this.bufferEnd >= 3); // please, call ensureRoom() if writing long packet
		this.dataView.setUint16(this.bufferEnd, value&0xFFFF, true);
		this.bufferEnd += 2;
		this.buffer[this.bufferEnd++] = value >> 16;
	}*/

	protected writeUint32(value: number)
	{	debugAssert(this.buffer.length-this.bufferEnd >= 4); // please, call ensureRoom() if writing long packet
		this.dataView.setUint32(this.bufferEnd, value, true);
		this.bufferEnd += 4;
	}

	protected writeUint64(value: bigint)
	{	debugAssert(this.buffer.length-this.bufferEnd >= 8); // please, call ensureRoom() if writing long packet
		this.dataView.setBigUint64(this.bufferEnd, value, true);
		this.bufferEnd += 8;
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
			this.dataView.setUint16(this.bufferEnd, Number(value), true);
			this.bufferEnd += 2;
		}
		else if (value <= 0xFFFFFF)
		{	debugAssert(this.buffer.length-this.bufferEnd >= 4); // please, call ensureRoom() if writing long packet
			const n = Number(value);
			this.buffer[this.bufferEnd++] = 0xFD;
			this.dataView.setUint16(this.bufferEnd, n&0xFFFF, true);
			this.bufferEnd += 2;
			this.buffer[this.bufferEnd++] = n >> 16;
		}
		else
		{	debugAssert(this.buffer.length-this.bufferEnd >= 9); // please, call ensureRoom() if writing long packet
			this.buffer[this.bufferEnd++] = 0xFE;
			this.dataView.setBigUint64(this.bufferEnd, BigInt(value), true);
			this.bufferEnd += 8;
		}
	}

	protected writeDouble(value: number)
	{	debugAssert(this.buffer.length-this.bufferEnd >= 8); // please, call ensureRoom() if writing long packet
		this.dataView.setFloat64(this.bufferEnd, value, true);
		this.bufferEnd += 8;
	}

	protected writeZero(nBytes: number)
	{	debugAssert(this.buffer.length-this.bufferEnd >= nBytes); // please, call ensureRoom() if writing long packet
		this.buffer.fill(0, this.bufferEnd, this.bufferEnd+nBytes);
		this.bufferEnd += nBytes;
	}

	protected writeBytes(bytes: Uint8Array)
	{	debugAssert(this.buffer.length-this.bufferEnd >= bytes.byteLength); // please, call ensureRoom() if writing long packet
		this.buffer.set(bytes, this.bufferEnd);
		this.bufferEnd += bytes.byteLength;
	}

	protected writeLenencBytes(bytes: Uint8Array)
	{	this.writeLenencInt(bytes.length);
		this.writeBytes(bytes);
	}

	protected writeNulBytes(bytes: Uint8Array)
	{	const z = bytes.indexOf(0);
		if (z == -1)
		{	this.writeBytes(bytes);
			this.writeUint8(0);
		}
		else
		{	this.writeBytes(bytes.subarray(0, z+1));
		}
	}

	protected writeString(value: string)
	{	this.writeBytes(encoder.encode(value));
	}

	protected writeLenencString(value: string)
	{	const data = encoder.encode(value);
		this.writeLenencInt(data.length);
		this.writeBytes(data);
	}

	protected writeNulString(value: string)
	{	this.writeNulBytes(encoder.encode(value));
	}

	protected async writeReadChunk(value: Deno.Reader)
	{	debugAssert(this.bufferEnd < this.buffer.length); // please, call ensureRoom() if writing long packet
		const n = await value.read(this.buffer.subarray(this.bufferEnd));
		if (n != null)
		{	this.bufferEnd += n;
		}
		return n;
	}

	private setHeader(payloadLength: number)
	{	const header = payloadLength | (this.sequenceId << 24);
		this.sequenceId++;
		this.dataView.setUint32(this.bufferStart, header, true);
	}

	protected send()
	{	this.setHeader(this.bufferEnd - this.bufferStart - 4);
		const n = this.bufferEnd;
		// prepare for reader
		this.bufferStart = 0;
		this.bufferEnd = 0;
		// send
		return writeAll(this.conn, this.buffer.subarray(0, n));
	}

	/**	Append long data to the end of current packet, and send the packet (or split to several packets and send them).
	 **/
	protected async sendWithData(data: SqlSource, noBackslashEscapes: boolean, canWait=false, putParamsTo?: Any[])
	{	if (typeof(data)=='object' && 'toSqlBytesWithParamsBackslashAndBuffer' in data)
		{	data = data.toSqlBytesWithParamsBackslashAndBuffer(putParamsTo, noBackslashEscapes, this.buffer.subarray(this.bufferEnd));
			if (data.buffer == this.buffer.buffer)
			{	this.bufferEnd += data.length;
				debugAssert(!canWait); // after sending Sql queries response always follows
				await this.send();
				return 0;
			}
		}
		if (data instanceof Uint8Array)
		{	const packetSize = this.bufferEnd - this.bufferStart - 4 + data.length;
			try
			{	let packetSizeRemaining = packetSize;
				while (packetSizeRemaining >= 0xFFFFFF)
				{	// send current packet part + data chunk = 0xFFFFFF
					this.setHeader(0xFFFFFF);
					await writeAll(this.conn, this.buffer.subarray(0, this.bufferEnd)); // send including packets before this.buffer_start
					const dataChunkLen = 0xFFFFFF - (this.bufferEnd - this.bufferStart - 4);
					await writeAll(this.conn, data.subarray(0, dataChunkLen));
					data = data.subarray(dataChunkLen);
					this.bufferStart = 0;
					this.bufferEnd = 4; // after header
					packetSizeRemaining = data.length;
				}
				debugAssert(packetSizeRemaining < 0xFFFFFF);
				this.setHeader(packetSizeRemaining);
				if (this.bufferStart+4+packetSizeRemaining <= this.buffer.length) // if previous packets + header + payload can fit my buffer
				{	this.buffer.set(data, this.bufferEnd);
					this.bufferEnd += data.length;
					if (canWait && this.bufferEnd+MAX_CAN_WAIT_PACKET_PRELUDE_BYTES <= this.buffer.length)
					{	return this.bufferEnd;
					}
					await writeAll(this.conn, this.buffer.subarray(0, this.bufferEnd));
				}
				else
				{	await writeAll(this.conn, this.buffer.subarray(0, this.bufferEnd)); // send including packets before this.buffer_start
					if (canWait && data.length+MAX_CAN_WAIT_PACKET_PRELUDE_BYTES <= this.buffer.length)
					{	this.buffer.set(data);
						this.bufferStart = data.length;
						this.bufferEnd = data.length;
						return this.bufferEnd;
					}
					await writeAll(this.conn, data);
				}
			}
			catch (e)
			{	throw new SendWithDataError(e.message, packetSize);
			}
		}
		else if (typeof(data) != 'string') // Deno.Reader&Deno.Seeker | Deno.Reader&{readonly size: number}
		{	let dataLength: number;
			if ('size' in data)
			{	dataLength = data.size;
			}
			else
			{	const pos = await data.seek(0, Deno.SeekMode.Current);
				dataLength = await data.seek(0, Deno.SeekMode.End);
				await data.seek(pos, Deno.SeekMode.Start);
				dataLength -= pos;
			}
			const packetSize = this.bufferEnd - this.bufferStart - 4 + dataLength;
			let packetSizeRemaining = packetSize;
			while (packetSizeRemaining >= 0xFFFFFF)
			{	// send current packet part + data chunk = 0xFFFFFF
				this.setHeader(0xFFFFFF);
				try
				{	await writeAll(this.conn, this.buffer.subarray(0, this.bufferEnd)); // send including packets before this.buffer_start
				}
				catch (e)
				{	throw new SendWithDataError(e.message, packetSize);
				}
				let dataChunkLen = 0xFFFFFF - (this.bufferEnd - this.bufferStart - 4);
				dataLength -= dataChunkLen;
				while (dataChunkLen > 0)
				{	const n = await data.read(this.buffer.subarray(0, Math.min(dataChunkLen, this.buffer.length)));
					if (n == null)
					{	throw new Error(`Unexpected end of stream`);
					}
					try
					{	await writeAll(this.conn, this.buffer.subarray(0, n));
					}
					catch (e)
					{	throw new SendWithDataError(e.message, packetSize);
					}
					dataChunkLen -= n;
				}
				this.bufferStart = 0;
				this.bufferEnd = 4; // after header
				packetSizeRemaining = dataLength;
			}
			debugAssert(packetSizeRemaining < 0xFFFFFF);
			this.setHeader(packetSizeRemaining);
			if (this.bufferStart+4+packetSizeRemaining <= this.buffer.length) // if previous packets + header + payload can fit my buffer
			{	while (dataLength > 0)
				{	const n = await data.read(this.buffer.subarray(this.bufferEnd));
					if (n == null)
					{	throw new Error(`Unexpected end of stream`);
					}
					this.bufferEnd += n;
					dataLength -= n;
				}
				if (canWait && this.bufferEnd+MAX_CAN_WAIT_PACKET_PRELUDE_BYTES <= this.buffer.length)
				{	return this.bufferEnd;
				}
				try
				{	await writeAll(this.conn, this.buffer.subarray(0, this.bufferEnd));
				}
				catch (e)
				{	throw new SendWithDataError(e.message, packetSize);
				}
			}
			else
			{	try
				{	await writeAll(this.conn, this.buffer.subarray(0, this.bufferEnd)); // send including packets before this.buffer_start
				}
				catch (e)
				{	throw new SendWithDataError(e.message, packetSize);
				}
				while (dataLength > 0)
				{	const n = await data.read(this.buffer.subarray(0, Math.min(dataLength, this.buffer.length)));
					if (n == null)
					{	throw new Error(`Unexpected end of stream`);
					}
					try
					{	await writeAll(this.conn, this.buffer.subarray(0, n));
					}
					catch (e)
					{	throw new SendWithDataError(e.message, packetSize);
					}
					dataLength -= n;
				}
			}
		}
		else // long string
		{	let dataLength = utf8StringLength(data);
			const packetSize = this.bufferEnd - this.bufferStart - 4 + dataLength;
			try
			{	let packetSizeRemaining = packetSize;
				const forEncode = this.bufferStart+4+packetSize <= this.buffer.length ? this.buffer : new Uint8Array(Math.min(dataLength, 4*1024*1024));
				while (packetSizeRemaining >= 0xFFFFFF)
				{	// send current packet part + data chunk = 0xFFFFFF
					this.setHeader(0xFFFFFF);
					await writeAll(this.conn, this.buffer.subarray(0, this.bufferEnd)); // send including packets before this.bufferStart
					let dataChunkLen = 0xFFFFFF - (this.bufferEnd - this.bufferStart - 4);
					dataLength -= dataChunkLen;
					while (dataChunkLen > 0)
					{	const {read, written} = encoder.encodeInto(data, forEncode.subarray(0, Math.min(dataChunkLen, forEncode.length)));
						data = data.slice(read);
						await writeAll(this.conn, forEncode.subarray(0, written));
						dataChunkLen -= written;
					}
					this.bufferStart = 0;
					this.bufferEnd = 4; // after header
					packetSizeRemaining = dataLength;
				}
				debugAssert(packetSizeRemaining < 0xFFFFFF);
				this.setHeader(packetSizeRemaining);
				if (this.bufferStart+4+packetSizeRemaining <= this.buffer.length) // if previous packets + header + payload can fit my buffer
				{	const {read, written} = encoder.encodeInto(data, this.buffer.subarray(this.bufferEnd));
					debugAssert(read == data.length);
					debugAssert(written == dataLength);
					this.bufferEnd += written;
					if (canWait && this.bufferEnd+MAX_CAN_WAIT_PACKET_PRELUDE_BYTES <= this.buffer.length)
					{	return this.bufferEnd;
					}
					await writeAll(this.conn, this.buffer.subarray(0, this.bufferEnd));
				}
				else
				{	await writeAll(this.conn, this.buffer.subarray(0, this.bufferEnd)); // send including packets before this.bufferStart
					while (dataLength > 0)
					{	const {read, written} = encoder.encodeInto(data, forEncode.subarray(0, Math.min(dataLength, forEncode.length)));
						data = data.slice(read);
						dataLength -= written;
						await writeAll(this.conn, forEncode.subarray(0, written));
					}
				}
			}
			catch (e)
			{	throw new SendWithDataError(e.message, packetSize);
			}
		}
		// prepare for reader
		this.bufferStart = 0;
		this.bufferEnd = 0;
		return 0;
	}
}
