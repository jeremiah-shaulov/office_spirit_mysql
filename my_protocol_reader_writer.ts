import {debug_assert} from './debug_assert.ts';
import {utf8_string_length} from './utf8_string_length.ts';
import {MyProtocolReader, BUFFER_LEN} from './my_protocol_reader.ts';
import {writeAll} from './deps.ts';
import {SendWithDataError} from "./errors.ts";

export type SqlSource = string | Uint8Array | Deno.Reader&Deno.Seeker | Deno.Reader&{readonly size: number};

export class MyProtocolReaderWriter extends MyProtocolReader
{	protected encoder = new TextEncoder;

	protected start_writing_new_packet(reset_sequence_id=false)
	{	debug_assert(this.buffer_end == this.buffer_start); // must read all before starting to write
		this.buffer_start = 0;
		this.buffer_end = 4; // after header
		if (reset_sequence_id)
		{	this.sequence_id = 0;
		}
	}

	protected discard_packet()
	{	debug_assert(this.buffer_start==0 && this.buffer_end>=4);
		this.buffer_end = 0; // after header
	}

	protected write_uint8(value: number)
	{	if (this.buffer_end >= BUFFER_LEN)
		{	throw new Error('Packet is too long');
		}
		this.buffer[this.buffer_end++] = value;
	}

	protected write_uint16(value: number)
	{	if (BUFFER_LEN-this.buffer_end < 2)
		{	throw new Error('Packet is too long');
		}
		this.data_view.setUint16(this.buffer_end, value, true);
		this.buffer_end += 2;
	}

	protected write_uint24(value: number)
	{	if (BUFFER_LEN-this.buffer_end < 3)
		{	throw new Error('Packet is too long');
		}
		this.data_view.setUint16(this.buffer_end, value&0xFFFF, true);
		this.buffer_end += 2;
		this.buffer[this.buffer_end++] = value >> 16;
	}

	protected write_uint32(value: number)
	{	if (BUFFER_LEN-this.buffer_end < 4)
		{	throw new Error('Packet is too long');
		}
		this.data_view.setUint32(this.buffer_end, value, true);
		this.buffer_end += 4;
	}

	protected write_uint64(value: bigint)
	{	if (BUFFER_LEN-this.buffer_end < 8)
		{	throw new Error('Packet is too long');
		}
		this.data_view.setBigUint64(this.buffer_end, value, true);
		this.buffer_end += 8;
	}

	protected write_lenenc_int(value: number|bigint)
	{	if (value < 0)
		{	throw new Error('Must be nonnegative number');
		}
		else if (value < 0xFB)
		{	if (this.buffer_end >= BUFFER_LEN)
			{	throw new Error('Packet is too long');
			}
			this.buffer[this.buffer_end++] = Number(value);
		}
		else if (value <= 0xFFFF)
		{	if (BUFFER_LEN-this.buffer_end < 3)
			{	throw new Error('Packet is too long');
			}
			this.buffer[this.buffer_end++] = 0xFC;
			this.data_view.setUint16(this.buffer_end, Number(value), true);
			this.buffer_end += 2;
		}
		else if (value <= 0xFFFFFF)
		{	if (BUFFER_LEN-this.buffer_end < 4)
			{	throw new Error('Packet is too long');
			}
			let n = Number(value);
			this.buffer[this.buffer_end++] = 0xFD;
			this.data_view.setUint16(this.buffer_end, n&0xFFFF, true);
			this.buffer_end += 2;
			this.buffer[this.buffer_end++] = n >> 16;
		}
		else
		{	if (BUFFER_LEN-this.buffer_end < 9)
			{	throw new Error('Packet is too long');
			}
			this.buffer[this.buffer_end++] = 0xFE;
			this.data_view.setBigUint64(this.buffer_end, BigInt(value), true);
			this.buffer_end += 8;
		}
	}

	protected write_double(value: number)
	{	if (BUFFER_LEN-this.buffer_end < 8)
		{	throw new Error('Packet is too long');
		}
		this.data_view.setFloat64(this.buffer_end, value, true);
		this.buffer_end += 8;
	}

	protected write_zero(n_bytes: number)
	{	if (BUFFER_LEN-this.buffer_end < n_bytes)
		{	throw new Error('Packet is too long');
		}
		this.buffer.fill(0, this.buffer_end, this.buffer_end+n_bytes);
		this.buffer_end += n_bytes;
	}

	protected write_bytes(bytes: Uint8Array)
	{	if (BUFFER_LEN-this.buffer_end < bytes.byteLength)
		{	throw new Error('Packet is too long');
		}
		this.buffer.set(bytes, this.buffer_end);
		this.buffer_end += bytes.byteLength;
	}

	protected write_nul_bytes(bytes: Uint8Array)
	{	let z = bytes.indexOf(0);
		if (z == -1)
		{	this.write_bytes(bytes);
			this.write_uint8(0);
		}
		else
		{	this.write_bytes(bytes.subarray(0, z+1));
		}
	}

	protected write_string(value: string)
	{	this.write_bytes(this.encoder.encode(value));
	}

	protected write_lenenc_string(value: string)
	{	let data = this.encoder.encode(value);
		this.write_lenenc_int(data.length);
		this.write_bytes(data);
	}

	protected write_nul_string(value: string)
	{	this.write_nul_bytes(this.encoder.encode(value));
	}

	protected async write_read_chunk(value: Deno.Reader)
	{	if (this.buffer_end >= BUFFER_LEN)
		{	throw new Error('Packet is too long');
		}
		let n = await value.read(this.buffer.subarray(this.buffer_end));
		if (n != null)
		{	this.buffer_end += n;
		}
		return n;
	}

	private set_header(payload_length: number)
	{	let header = payload_length | (this.sequence_id << 24);
		this.sequence_id++;
		this.data_view.setUint32(0, header, true);
	}

	protected send()
	{	this.set_header(this.buffer_end - 4);
		let n = this.buffer_end;
		// prepare for reader
		this.buffer_start = 0;
		this.buffer_end = 0;
		// send
		return writeAll(this.conn, this.buffer.subarray(0, n));
	}

	/**	Append long data to the end of current packet, and send the packet (or split to several packets and send them).
	 **/
	protected async send_with_data(data: SqlSource)
	{	if (typeof(data) == 'string' && data.length <= BUFFER_LEN)
		{	data = this.encoder.encode(data);
		}
		if (data instanceof Uint8Array)
		{	try
			{	while (this.buffer_end-4 + data.length >= 0xFFFFFF)
				{	// send current packet part + data chunk = 0xFFFFFF
					let data_chunk_len = 0xFFFFFF - (this.buffer_end - 4);
					this.set_header(0xFFFFFF);
					await writeAll(this.conn, this.buffer.subarray(0, this.buffer_end));
					await writeAll(this.conn, data.subarray(0, data_chunk_len));
					data = data.subarray(data_chunk_len);
					this.buffer_end = 4; // after header
				}
				let len = this.buffer_end-4 + data.length;
				debug_assert(len < 0xFFFFFF);
				this.set_header(len);
				if (4+len <= BUFFER_LEN) // if header+payload can fit my buffer
				{	this.buffer.set(data, this.buffer_end);
					this.buffer_end += data.length;
					await writeAll(this.conn, this.buffer.subarray(0, this.buffer_end));
				}
				else
				{	await writeAll(this.conn, this.buffer.subarray(0, this.buffer_end));
					await writeAll(this.conn, data);
				}
			}
			catch (e)
			{	throw new SendWithDataError(e.message);
			}
		}
		else if (typeof(data) != 'string') // Deno.Reader&Deno.Seeker | Deno.Reader&{readonly size: number}
		{	let size: number;
			if ('seek' in data)
			{	size = await data.seek(0, Deno.SeekMode.End);
				await data.seek(0, Deno.SeekMode.Start);
			}
			else
			{	size = data.size;
			}
			while (this.buffer_end-4 + size >= 0xFFFFFF)
			{	// send current packet part + data chunk = 0xFFFFFF
				this.set_header(0xFFFFFF);
				try
				{	await writeAll(this.conn, this.buffer.subarray(0, this.buffer_end));
				}
				catch (e)
				{	throw new SendWithDataError(e.message);
				}
				let data_chunk_len = 0xFFFFFF - (this.buffer_end - 4);
				size -= data_chunk_len;
				while (data_chunk_len > 0)
				{	let n = await data.read(this.buffer.subarray(0, Math.min(data_chunk_len, BUFFER_LEN)));
					if (n == null)
					{	throw new Error(`Unexpected end of stream`);
					}
					try
					{	await writeAll(this.conn, this.buffer.subarray(0, n));
					}
					catch (e)
					{	throw new SendWithDataError(e.message);
					}
					data_chunk_len -= n;
				}
				this.buffer_end = 4; // after header
			}
			let len = this.buffer_end-4 + size;
			debug_assert(len < 0xFFFFFF);
			this.set_header(len);
			if (4+len <= BUFFER_LEN) // if header+payload can fit my buffer
			{	while (size > 0)
				{	let n = await data.read(this.buffer.subarray(this.buffer_end));
					if (n == null)
					{	throw new Error(`Unexpected end of stream`);
					}
					this.buffer_end += n;
					size -= n;
				}
				try
				{	await writeAll(this.conn, this.buffer.subarray(0, this.buffer_end));
				}
				catch (e)
				{	throw new SendWithDataError(e.message);
				}
			}
			else
			{	try
				{	await writeAll(this.conn, this.buffer.subarray(0, this.buffer_end));
				}
				catch (e)
				{	throw new SendWithDataError(e.message);
				}
				while (size > 0)
				{	let n = await data.read(this.buffer.subarray(0, Math.min(size, BUFFER_LEN)));
					if (n == null)
					{	throw new Error(`Unexpected end of stream`);
					}
					try
					{	await writeAll(this.conn, this.buffer.subarray(0, n));
					}
					catch (e)
					{	throw new SendWithDataError(e.message);
					}
					size -= n;
				}
			}
		}
		else // long string
		{	try
			{	let size = utf8_string_length(data);
				while (this.buffer_end-4 + size >= 0xFFFFFF)
				{	// send current packet part + data chunk = 0xFFFFFF
					this.set_header(0xFFFFFF);
					await writeAll(this.conn, this.buffer.subarray(0, this.buffer_end));
					let data_chunk_len = 0xFFFFFF - (this.buffer_end - 4);
					size -= data_chunk_len;
					while (data_chunk_len > 0)
					{	let {read, written} = this.encoder.encodeInto(data, this.buffer.subarray(0, Math.min(data_chunk_len, BUFFER_LEN)));
						data = data.slice(read);
						await writeAll(this.conn, this.buffer.subarray(0, written));
						data_chunk_len -= written;
					}
					this.buffer_end = 4; // after header
				}
				let len = this.buffer_end-4 + size;
				debug_assert(len < 0xFFFFFF);
				this.set_header(len);
				if (4+len <= BUFFER_LEN) // if header+payload can fit my buffer
				{	let {read, written} = this.encoder.encodeInto(data, this.buffer.subarray(this.buffer_end));
					debug_assert(read == data.length);
					debug_assert(written == size);
					this.buffer_end += written;
					await writeAll(this.conn, this.buffer.subarray(0, this.buffer_end));
				}
				else
				{	await writeAll(this.conn, this.buffer.subarray(0, this.buffer_end));
					while (size > 0)
					{	let {read, written} = this.encoder.encodeInto(data, this.buffer.subarray(0, Math.min(size, BUFFER_LEN)));
						data = data.slice(read);
						await writeAll(this.conn, this.buffer.subarray(0, written));
						size -= written;
					}
				}
			}
			catch (e)
			{	throw new SendWithDataError(e.message);
			}
		}
		// prepare for reader
		this.buffer_start = 0;
		this.buffer_end = 0;
	}
}
