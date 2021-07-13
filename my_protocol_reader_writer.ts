import {debug_assert} from './debug_assert.ts';
import {utf8_string_length} from './utf8_string_length.ts';
import {MyProtocolReader} from './my_protocol_reader.ts';
import {writeAll} from './deps.ts';
import {SendWithDataError} from "./errors.ts";
import {Sql} from './sql.ts';

const MAX_CAN_WAIT_PACKET_PRELUDE_BYTES = 12; // >= packet header (4-byte) + COM_STMT_SEND_LONG_DATA (1-byte) + stmt_id (4-byte) + n_param (2-byte)

export type SqlSource = string | Uint8Array | Sql | Deno.Reader&Deno.Seeker | Deno.Reader&{readonly size: number};

const encoder = new TextEncoder;

export class MyProtocolReaderWriter extends MyProtocolReader
{	protected start_writing_new_packet(reset_sequence_id=false, packet_start=0)
	{	debug_assert(this.buffer_end==this.buffer_start || packet_start>0); // must read all before starting to write
		this.buffer_start = packet_start;
		this.buffer_end = packet_start + 4; // after header
		if (reset_sequence_id)
		{	this.sequence_id = 0;
		}
	}

	protected discard_packet()
	{	debug_assert(this.buffer_end >= this.buffer_start+4);
		this.buffer_end = this.buffer_start;
	}

	protected write_uint8(value: number)
	{	debug_assert(this.buffer_end < this.buffer.length); // please, call ensure_room() if writing long packet
		this.buffer[this.buffer_end++] = value;
	}

	protected write_uint16(value: number)
	{	debug_assert(this.buffer.length-this.buffer_end >= 2); // please, call ensure_room() if writing long packet
		this.data_view.setUint16(this.buffer_end, value, true);
		this.buffer_end += 2;
	}

	/*protected write_uint24(value: number)
	{	debug_assert(this.buffer.length-this.buffer_end >= 3); // please, call ensure_room() if writing long packet
		this.data_view.setUint16(this.buffer_end, value&0xFFFF, true);
		this.buffer_end += 2;
		this.buffer[this.buffer_end++] = value >> 16;
	}*/

	protected write_uint32(value: number)
	{	debug_assert(this.buffer.length-this.buffer_end >= 4); // please, call ensure_room() if writing long packet
		this.data_view.setUint32(this.buffer_end, value, true);
		this.buffer_end += 4;
	}

	protected write_uint64(value: bigint)
	{	debug_assert(this.buffer.length-this.buffer_end >= 8); // please, call ensure_room() if writing long packet
		this.data_view.setBigUint64(this.buffer_end, value, true);
		this.buffer_end += 8;
	}

	protected write_lenenc_int(value: number|bigint)
	{	if (value < 0)
		{	throw new Error('Must be nonnegative number');
		}
		else if (value < 0xFB)
		{	debug_assert(this.buffer_end < this.buffer.length); // please, call ensure_room() if writing long packet
			this.buffer[this.buffer_end++] = Number(value);
		}
		else if (value <= 0xFFFF)
		{	debug_assert(this.buffer.length-this.buffer_end >= 3); // please, call ensure_room() if writing long packet
			this.buffer[this.buffer_end++] = 0xFC;
			this.data_view.setUint16(this.buffer_end, Number(value), true);
			this.buffer_end += 2;
		}
		else if (value <= 0xFFFFFF)
		{	debug_assert(this.buffer.length-this.buffer_end >= 4); // please, call ensure_room() if writing long packet
			let n = Number(value);
			this.buffer[this.buffer_end++] = 0xFD;
			this.data_view.setUint16(this.buffer_end, n&0xFFFF, true);
			this.buffer_end += 2;
			this.buffer[this.buffer_end++] = n >> 16;
		}
		else
		{	debug_assert(this.buffer.length-this.buffer_end >= 9); // please, call ensure_room() if writing long packet
			this.buffer[this.buffer_end++] = 0xFE;
			this.data_view.setBigUint64(this.buffer_end, BigInt(value), true);
			this.buffer_end += 8;
		}
	}

	protected write_double(value: number)
	{	debug_assert(this.buffer.length-this.buffer_end >= 8); // please, call ensure_room() if writing long packet
		this.data_view.setFloat64(this.buffer_end, value, true);
		this.buffer_end += 8;
	}

	protected write_zero(n_bytes: number)
	{	debug_assert(this.buffer.length-this.buffer_end >= n_bytes); // please, call ensure_room() if writing long packet
		this.buffer.fill(0, this.buffer_end, this.buffer_end+n_bytes);
		this.buffer_end += n_bytes;
	}

	protected write_bytes(bytes: Uint8Array)
	{	debug_assert(this.buffer.length-this.buffer_end >= bytes.byteLength); // please, call ensure_room() if writing long packet
		this.buffer.set(bytes, this.buffer_end);
		this.buffer_end += bytes.byteLength;
	}

	protected write_lenenc_bytes(bytes: Uint8Array)
	{	this.write_lenenc_int(bytes.length);
		this.write_bytes(bytes);
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
	{	this.write_bytes(encoder.encode(value));
	}

	protected write_lenenc_string(value: string)
	{	let data = encoder.encode(value);
		this.write_lenenc_int(data.length);
		this.write_bytes(data);
	}

	protected write_nul_string(value: string)
	{	this.write_nul_bytes(encoder.encode(value));
	}

	protected async write_read_chunk(value: Deno.Reader)
	{	debug_assert(this.buffer_end < this.buffer.length); // please, call ensure_room() if writing long packet
		let n = await value.read(this.buffer.subarray(this.buffer_end));
		if (n != null)
		{	this.buffer_end += n;
		}
		return n;
	}

	private set_header(payload_length: number)
	{	let header = payload_length | (this.sequence_id << 24);
		this.sequence_id++;
		this.data_view.setUint32(this.buffer_start, header, true);
	}

	protected send()
	{	this.set_header(this.buffer_end - this.buffer_start - 4);
		let n = this.buffer_end;
		// prepare for reader
		this.buffer_start = 0;
		this.buffer_end = 0;
		// send
		return writeAll(this.conn, this.buffer.subarray(0, n));
	}

	/**	Append long data to the end of current packet, and send the packet (or split to several packets and send them).
	 **/
	protected async send_with_data(data: SqlSource, no_backslash_escapes: boolean, can_wait=false, put_params_to?: any[])
	{	if (data instanceof Sql)
		{	data.sqlPolicy = this.sql_policy;
			data = data.encode(no_backslash_escapes, put_params_to, this.buffer.subarray(this.buffer_end));
			if (data.buffer == this.buffer.buffer)
			{	this.buffer_end += data.length;
				debug_assert(!can_wait); // after sending Sql queries response always follows
				await this.send();
				return 0;
			}
		}
		if (data instanceof Uint8Array)
		{	let packet_size = this.buffer_end - this.buffer_start - 4 + data.length;
			try
			{	let packet_size_remaining = packet_size;
				while (packet_size_remaining >= 0xFFFFFF)
				{	// send current packet part + data chunk = 0xFFFFFF
					this.set_header(0xFFFFFF);
					await writeAll(this.conn, this.buffer.subarray(0, this.buffer_end)); // send including packets before this.buffer_start
					let data_chunk_len = 0xFFFFFF - (this.buffer_end - this.buffer_start - 4);
					await writeAll(this.conn, data.subarray(0, data_chunk_len));
					data = data.subarray(data_chunk_len);
					this.buffer_start = 0;
					this.buffer_end = 4; // after header
					packet_size_remaining = data.length;
				}
				debug_assert(packet_size_remaining < 0xFFFFFF);
				this.set_header(packet_size_remaining);
				if (this.buffer_start+4+packet_size_remaining <= this.buffer.length) // if previous packets + header + payload can fit my buffer
				{	this.buffer.set(data, this.buffer_end);
					this.buffer_end += data.length;
					if (can_wait && this.buffer_end+MAX_CAN_WAIT_PACKET_PRELUDE_BYTES <= this.buffer.length)
					{	return this.buffer_end;
					}
					await writeAll(this.conn, this.buffer.subarray(0, this.buffer_end));
				}
				else
				{	await writeAll(this.conn, this.buffer.subarray(0, this.buffer_end)); // send including packets before this.buffer_start
					if (can_wait && data.length+MAX_CAN_WAIT_PACKET_PRELUDE_BYTES <= this.buffer.length)
					{	this.buffer.set(data);
						this.buffer_start = data.length;
						this.buffer_end = data.length;
						return this.buffer_end;
					}
					await writeAll(this.conn, data);
				}
			}
			catch (e)
			{	throw new SendWithDataError(e.message, packet_size);
			}
		}
		else if (typeof(data) != 'string') // Deno.Reader&Deno.Seeker | Deno.Reader&{readonly size: number}
		{	let data_length: number;
			if ('size' in data)
			{	data_length = data.size;
			}
			else
			{	let pos = await data.seek(0, Deno.SeekMode.Current);
				data_length = await data.seek(0, Deno.SeekMode.End);
				await data.seek(pos, Deno.SeekMode.Start);
				data_length -= pos;
			}
			let packet_size = this.buffer_end - this.buffer_start - 4 + data_length;
			let packet_size_remaining = packet_size;
			while (packet_size_remaining >= 0xFFFFFF)
			{	// send current packet part + data chunk = 0xFFFFFF
				this.set_header(0xFFFFFF);
				try
				{	await writeAll(this.conn, this.buffer.subarray(0, this.buffer_end)); // send including packets before this.buffer_start
				}
				catch (e)
				{	throw new SendWithDataError(e.message, packet_size);
				}
				let data_chunk_len = 0xFFFFFF - (this.buffer_end - this.buffer_start - 4);
				data_length -= data_chunk_len;
				while (data_chunk_len > 0)
				{	let n = await data.read(this.buffer.subarray(0, Math.min(data_chunk_len, this.buffer.length)));
					if (n == null)
					{	throw new Error(`Unexpected end of stream`);
					}
					try
					{	await writeAll(this.conn, this.buffer.subarray(0, n));
					}
					catch (e)
					{	throw new SendWithDataError(e.message, packet_size);
					}
					data_chunk_len -= n;
				}
				this.buffer_start = 0;
				this.buffer_end = 4; // after header
				packet_size_remaining = data_length;
			}
			debug_assert(packet_size_remaining < 0xFFFFFF);
			this.set_header(packet_size_remaining);
			if (this.buffer_start+4+packet_size_remaining <= this.buffer.length) // if previous packets + header + payload can fit my buffer
			{	while (data_length > 0)
				{	let n = await data.read(this.buffer.subarray(this.buffer_end));
					if (n == null)
					{	throw new Error(`Unexpected end of stream`);
					}
					this.buffer_end += n;
					data_length -= n;
				}
				if (can_wait && this.buffer_end+MAX_CAN_WAIT_PACKET_PRELUDE_BYTES <= this.buffer.length)
				{	return this.buffer_end;
				}
				try
				{	await writeAll(this.conn, this.buffer.subarray(0, this.buffer_end));
				}
				catch (e)
				{	throw new SendWithDataError(e.message, packet_size);
				}
			}
			else
			{	try
				{	await writeAll(this.conn, this.buffer.subarray(0, this.buffer_end)); // send including packets before this.buffer_start
				}
				catch (e)
				{	throw new SendWithDataError(e.message, packet_size);
				}
				while (data_length > 0)
				{	let n = await data.read(this.buffer.subarray(0, Math.min(data_length, this.buffer.length)));
					if (n == null)
					{	throw new Error(`Unexpected end of stream`);
					}
					try
					{	await writeAll(this.conn, this.buffer.subarray(0, n));
					}
					catch (e)
					{	throw new SendWithDataError(e.message, packet_size);
					}
					data_length -= n;
				}
			}
		}
		else // long string
		{	let data_length = utf8_string_length(data);
			let packet_size = this.buffer_end - this.buffer_start - 4 + data_length;
			try
			{	let packet_size_remaining = packet_size;
				let for_encode = this.buffer_start+4+packet_size <= this.buffer.length ? this.buffer : new Uint8Array(Math.min(data_length, 4*1024*1024));
				while (packet_size_remaining >= 0xFFFFFF)
				{	// send current packet part + data chunk = 0xFFFFFF
					this.set_header(0xFFFFFF);
					await writeAll(this.conn, this.buffer.subarray(0, this.buffer_end)); // send including packets before this.buffer_start
					let data_chunk_len = 0xFFFFFF - (this.buffer_end - this.buffer_start - 4);
					data_length -= data_chunk_len;
					while (data_chunk_len > 0)
					{	let {read, written} = encoder.encodeInto(data, for_encode.subarray(0, Math.min(data_chunk_len, for_encode.length)));
						data = data.slice(read);
						await writeAll(this.conn, for_encode.subarray(0, written));
						data_chunk_len -= written;
					}
					this.buffer_start = 0;
					this.buffer_end = 4; // after header
					packet_size_remaining = data_length;
				}
				debug_assert(packet_size_remaining < 0xFFFFFF);
				this.set_header(packet_size_remaining);
				if (this.buffer_start+4+packet_size_remaining <= this.buffer.length) // if previous packets + header + payload can fit my buffer
				{	let {read, written} = encoder.encodeInto(data, this.buffer.subarray(this.buffer_end));
					debug_assert(read == data.length);
					debug_assert(written == data_length);
					this.buffer_end += written;
					if (can_wait && this.buffer_end+MAX_CAN_WAIT_PACKET_PRELUDE_BYTES <= this.buffer.length)
					{	return this.buffer_end;
					}
					await writeAll(this.conn, this.buffer.subarray(0, this.buffer_end));
				}
				else
				{	await writeAll(this.conn, this.buffer.subarray(0, this.buffer_end)); // send including packets before this.buffer_start
					while (data_length > 0)
					{	let {read, written} = encoder.encodeInto(data, for_encode.subarray(0, Math.min(data_length, for_encode.length)));
						data = data.slice(read);
						data_length -= written;
						await writeAll(this.conn, for_encode.subarray(0, written));
					}
				}
			}
			catch (e)
			{	throw new SendWithDataError(e.message, packet_size);
			}
		}
		// prepare for reader
		this.buffer_start = 0;
		this.buffer_end = 0;
		return 0;
	}
}
