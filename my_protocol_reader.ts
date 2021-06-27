import {debug_assert} from './debug_assert.ts';
import {ServerDisconnectedError} from './errors.ts';

export const BUFFER_LEN = 8*1024;

export class MyProtocolReader
{	protected buffer;
	protected buffer_start = 0;
	protected buffer_end = 0;
	protected sequence_id = 0;
	protected payload_length = 0;
	protected packet_offset = 0;

	protected data_view: DataView;

	protected constructor(protected conn: Deno.Conn, protected decoder: TextDecoder, use_buffer: Uint8Array|undefined)
	{	this.buffer = use_buffer ?? new Uint8Array(BUFFER_LEN);
		this.data_view = new DataView(this.buffer.buffer);
		debug_assert(this.buffer.length == BUFFER_LEN);
	}

	close()
	{	this.conn.close();
		let {buffer} = this;
		this.buffer = new Uint8Array;
		return buffer; // this buffer can be recycled
	}

	protected is_at_end_of_packet()
	{	return this.packet_offset >= this.payload_length;
	}

	protected go_to_end_of_packet()
	{	debug_assert(this.packet_offset <= this.payload_length);
		return this.read_void(this.payload_length-this.packet_offset);
	}

	protected go_to_end_of_packet_async()
	{	return this.read_void_async(this.payload_length-this.packet_offset);
	}

	/**	Immediately after read_uint8() or read_uint8_async(), it's possible to put the just read byte back, so you will read it again.
	 **/
	protected unput(byte: number)
	{	debug_assert(this.buffer_start>0 && this.packet_offset>0);
		this.buffer_start--;
		this.packet_offset--;
		this.buffer[this.buffer_start] = byte;
	}


	// --- 1. recv_*

	private async recv_at_least(n_bytes: number, can_eof=false)
	{	debug_assert(n_bytes <= BUFFER_LEN);
		if (this.buffer_start == this.buffer_end)
		{	this.buffer_start = 0;
			this.buffer_end = 0;
		}
		else if (this.buffer_start > BUFFER_LEN-n_bytes)
		{	this.buffer.copyWithin(0, this.buffer_start, this.buffer_end);
			this.buffer_end -= this.buffer_start;
			this.buffer_start = 0;
		}
		let to = this.buffer_start + n_bytes;
		while (this.buffer_end < to)
		{	let n_read = await this.conn.read(this.buffer.subarray(this.buffer_end));
			if (n_read == null)
			{	if (can_eof && this.buffer_end-this.buffer_start==0)
				{	return false;
				}
				throw new ServerDisconnectedError('Server disconnected');
			}
			this.buffer_end += n_read;
		}
		return true;
	}

	/**	Don't call if buffer.subarray(buffer_start, buffer_end).indexOf(0) != -1.
		If !by_parts, can read a string not longer than BUFFER_LEN, or exception will be thrown.
		If by_parts, can return -1, indicating that buffer[buffer_start .. buffer_end] contains partial string.
		Returns i, where buffer[i] == 0, and buffer[buffer_start .. i] is the string.
	 **/
	private async recv_to_nul(by_parts=false)
	{	debug_assert(this.buffer.subarray(this.buffer_start, this.buffer_end).indexOf(0) == -1);
		if (this.buffer_start == this.buffer_end)
		{	this.buffer_start = 0;
			this.buffer_end = 0;
		}
		while (true)
		{	if (this.buffer_end == BUFFER_LEN)
			{	if (by_parts)
				{	return -1;
				}
				if (this.buffer_start == 0)
				{	throw new Error(`String is too long for this operation. Longer than ${BUFFER_LEN/1024} kib`);
				}
				this.buffer_end -= this.buffer_start;
				this.buffer.copyWithin(0, this.buffer_start);
				this.buffer_start = 0;
			}
			debug_assert(this.buffer_end < BUFFER_LEN);
			let n_read = await this.conn.read(this.buffer.subarray(this.buffer_end));
			if (n_read == null)
			{	throw new ServerDisconnectedError('Server disconnected');
			}
			this.buffer_end += n_read;
			let i = this.buffer.subarray(0, this.buffer_end).indexOf(0, this.buffer_end-n_read);
			if (i != -1)
			{	debug_assert(this.buffer[i] == 0);
				return i;
			}
		}
	}


	// --- 2. Reading packet headers

	/**	If buffer contains full header, consume it, and return true. Else return false.
	 **/
	protected read_packet_header()
	{	if (this.buffer_end-this.buffer_start >= 4)
		{	let header = this.data_view.getUint32(this.buffer_start, true);
			this.buffer_start += 4;
			this.payload_length = header & 0xFFFFFF;
			this.sequence_id = (header >> 24) + 1; // inc sequence_id
			this.packet_offset = 0; // start counting offset
			return true;
		}
		return false;
	}

	/**	To read a header, do: read_packet_header() || await read_packet_header_async().
		This allows to avoid unnecessary promise awaiting.
	 **/
	protected async read_packet_header_async()
	{	debug_assert(this.buffer_end-this.buffer_start < 4);
		await this.recv_at_least(4);
		let header = this.data_view.getUint32(this.buffer_start, true);
		this.buffer_start += 4;
		this.payload_length = header & 0xFFFFFF;
		this.sequence_id = (header >> 24) + 1; // inc sequence_id
		this.packet_offset = 0; // start counting offset
	}


	// --- 3. Reading numbers

	/**	If buffer contains full uint8_t, consume it. Else return undefined.
	 **/
	protected read_uint8()
	{	if (this.buffer_end > this.buffer_start)
		{	this.packet_offset++;
			return this.buffer[this.buffer_start++];
		}
	}

	/**	To read a uint8_t, do: read_uint8() ?? await read_uint8_async().
		This allows to avoid unnecessary promise awaiting.
	 **/
	protected async read_uint8_async()
	{	debug_assert(this.buffer_end == this.buffer_start);
		await this.recv_at_least(1);
		this.packet_offset++;
		return this.buffer[this.buffer_start++];
	}

	/**	If buffer contains full uint16_t, consume it. Else return undefined.
	 **/
	protected read_uint16()
	{	if (this.buffer_end-this.buffer_start >= 2)
		{	let value = this.data_view.getUint16(this.buffer_start, true);
			this.buffer_start += 2;
			this.packet_offset += 2;
			return value;
		}
	}

	/**	To read a uint16_t, do: read_uint16() ?? await read_uint16_async().
		This allows to avoid unnecessary promise awaiting.
	 **/
	protected async read_uint16_async()
	{	debug_assert(this.buffer_end-this.buffer_start < 2);
		await this.recv_at_least(2);
		let value = this.data_view.getUint16(this.buffer_start, true);
		this.buffer_start += 2;
		this.packet_offset += 2;
		return value;
	}

	/**	If buffer contains full 3-byte little-endian unsigned int, consume it. Else return undefined.
	 **/
	protected read_uint24()
	{	if (this.buffer_end-this.buffer_start >= 3)
		{	let value = this.data_view.getUint16(this.buffer_start, true) | (this.data_view.getUint8(this.buffer_start+2) << 16);
			this.buffer_start += 3;
			this.packet_offset += 3;
			return value;
		}
	}

	/**	To read a 3-byte little-endian unsigned int, do: read_uint24() ?? await read_uint24_async().
		This allows to avoid unnecessary promise awaiting.
	 **/
	protected async read_uint24_async()
	{	debug_assert(this.buffer_end-this.buffer_start < 3);
		await this.recv_at_least(3);
		let value = this.data_view.getUint16(this.buffer_start, true) | (this.data_view.getUint8(this.buffer_start+2) << 16);
		this.buffer_start += 3;
		this.packet_offset += 3;
		return value;
	}

	/**	If buffer contains full uint32_t, consume it. Else return undefined.
	 **/
	protected read_uint32()
	{	if (this.buffer_end-this.buffer_start >= 4)
		{	let value = this.data_view.getUint32(this.buffer_start, true);
			this.buffer_start += 4;
			this.packet_offset += 4;
			return value;
		}
	}

	/**	To read a uint32_t, do: read_uint32() ?? await read_uint32_async().
		This allows to avoid unnecessary promise awaiting.
	 **/
	protected async read_uint32_async()
	{	debug_assert(this.buffer_end-this.buffer_start < 4);
		await this.recv_at_least(4);
		let value = this.data_view.getUint32(this.buffer_start, true);
		this.buffer_start += 4;
		this.packet_offset += 4;
		return value;
	}

	/**	If buffer contains full uint64_t, consume it. Else return undefined.
	 **/
	protected read_uint64()
	{	if (this.buffer_end-this.buffer_start >= 8)
		{	let value = this.data_view.getBigUint64(this.buffer_start, true);
			this.buffer_start += 8;
			this.packet_offset += 8;
			return value;
		}
	}

	/**	To read a uint64_t, do: read_uint64() ?? await read_uint64_async().
		This allows to avoid unnecessary promise awaiting.
	 **/
	protected async read_uint64_async()
	{	debug_assert(this.buffer_end-this.buffer_start < 8);
		await this.recv_at_least(8);
		let value = this.data_view.getBigUint64(this.buffer_start, true);
		this.buffer_start += 8;
		this.packet_offset += 8;
		return value;
	}

	/**	If buffer contains full float, consume it. Else return undefined.
	 **/
	protected read_float()
	{	if (this.buffer_end-this.buffer_start >= 4)
		{	let value = this.data_view.getFloat32(this.buffer_start, true);
			this.buffer_start += 4;
			this.packet_offset += 4;
			return value;
		}
	}

	/**	To read a IEEE 754 32-bit single-precision, do: read_float() ?? await read_float_async().
		This allows to avoid unnecessary promise awaiting.
	 **/
	protected async read_float_async()
	{	debug_assert(this.buffer_end-this.buffer_start < 4);
		await this.recv_at_least(4);
		let value = this.data_view.getFloat32(this.buffer_start, true);
		this.buffer_start += 4;
		this.packet_offset += 4;
		return value;
	}

	/**	If buffer contains full double, consume it. Else return undefined.
	 **/
	protected read_double()
	{	if (this.buffer_end-this.buffer_start >= 8)
		{	let value = this.data_view.getFloat64(this.buffer_start, true);
			this.buffer_start += 8;
			this.packet_offset += 8;
			return value;
		}
	}

	/**	To read a IEEE 754 32-bit double-precision, do: read_double() ?? await read_double_async().
		This allows to avoid unnecessary promise awaiting.
	 **/
	protected async read_double_async()
	{	debug_assert(this.buffer_end-this.buffer_start < 8);
		await this.recv_at_least(8);
		let value = this.data_view.getFloat64(this.buffer_start, true);
		this.buffer_start += 8;
		this.packet_offset += 8;
		return value;
	}

	/**	If buffer contains full length-encoded integer, consume it. Else return undefined.
		Null value (0xFB) will be returned as -1.
	 **/
	protected read_lenenc_int()
	{	if (this.buffer_end > this.buffer_start)
		{	switch (this.buffer[this.buffer_start])
			{	case 0xFE:
				{	if (this.buffer_end-this.buffer_start < 9)
					{	return;
					}
					let value = this.data_view.getBigUint64(this.buffer_start+1, true);
					this.buffer_start += 9;
					this.packet_offset += 9;
					return value<Number.MIN_SAFE_INTEGER || value>Number.MAX_SAFE_INTEGER ? value : Number(value);
				}
				case 0xFD:
				{	if (this.buffer_end-this.buffer_start < 4)
					{	return;
					}
					let value = this.data_view.getUint16(this.buffer_start+1, true) | (this.data_view.getUint8(this.buffer_start+3) << 16);
					this.buffer_start += 4;
					this.packet_offset += 4;
					return value;
				}
				case 0xFC:
				{	if (this.buffer_end-this.buffer_start < 3)
					{	return;
					}
					let value = this.data_view.getUint16(this.buffer_start+1, true);
					this.buffer_start += 3;
					this.packet_offset += 3;
					return value;
				}
				case 0xFB:
				{	this.packet_offset++;
					this.buffer_start++;
					return -1;
				}
				default:
				{	this.packet_offset++;
					return this.buffer[this.buffer_start++];
				}
			}
		}
	}

	/**	To read a length-encoded integer, do: read_lenenc_int() ?? await read_lenenc_int_async().
		This allows to avoid unnecessary promise awaiting.
		Null value (0xFB) will be returned as -1.
	 **/
	protected async read_lenenc_int_async()
	{	if (this.buffer_end == this.buffer_start)
		{	await this.recv_at_least(1);
		}
		switch (this.buffer[this.buffer_start])
		{	case 0xFE:
			{	await this.recv_at_least(9);
				let value = this.data_view.getBigUint64(this.buffer_start+1, true);
				this.buffer_start += 9;
				this.packet_offset += 9;
				return value<Number.MIN_SAFE_INTEGER || value>Number.MAX_SAFE_INTEGER ? value : Number(value);
			}
			case 0xFD:
			{	await this.recv_at_least(4);
				let value = this.data_view.getUint16(this.buffer_start+1, true) | (this.data_view.getUint8(this.buffer_start+3) << 16);
				this.buffer_start += 4;
				this.packet_offset += 4;
				return value;
			}
			case 0xFC:
			{	await this.recv_at_least(3);
				let value = this.data_view.getUint16(this.buffer_start+1, true);
				this.buffer_start += 3;
				this.packet_offset += 3;
				return value;
			}
			case 0xFB:
			{	this.packet_offset++;
				this.buffer_start++;
				return -1;
			}
			default:
			{	this.packet_offset++;
				return this.buffer[this.buffer_start++];
			}
		}
	}


	// --- 4. Reading bytes

	/**	If buffer contains len bytes, consume them. Else return undefined.
		Returns pointer to buffer. If you want to use these data after next read operation, you need to copy them.
	 **/
	protected read_short_bytes(len: number)
	{	if (this.buffer_end-this.buffer_start >= len)
		{	this.buffer_start += len;
			this.packet_offset += len;
			return this.buffer.subarray(this.buffer_start-len, this.buffer_start);
		}
	}

	/**	To read len bytes, where len<=BUFFER_LEN, do: read_short_bytes() ?? await read_short_bytes_async().
		This allows to avoid unnecessary promise awaiting.
		Returns pointer to buffer. If you want to use these data after next read operation, you need to copy them.
	 **/
	protected async read_short_bytes_async(len: number)
	{	debug_assert(this.buffer_end-this.buffer_start < len);
		await this.recv_at_least(len);
		this.buffer_start += len;
		this.packet_offset += len;
		return this.buffer.subarray(this.buffer_start-len, this.buffer_start);
	}

	/**	If buffer contains full null-terminated blob, consume it. Else return undefined.
		Returns pointer to buffer. If you want to use these data after next read operation, you need to copy them.
	 **/
	protected read_short_nul_bytes()
	{	let i = this.buffer.subarray(0, this.buffer_end).indexOf(0, this.buffer_start);
		if (i != -1)
		{	let value = this.buffer.subarray(this.buffer_start, i);
			this.packet_offset += i - this.buffer_start + 1;
			this.buffer_start = i + 1;
			return value;
		}
	}

	/**	To read a null-terminated blob that can fit BUFFER_LEN, do: read_short_nul_bytes() ?? await read_short_nul_bytes_async().
		This allows to avoid unnecessary promise awaiting.
		If the blob was longer than BUFFER_LEN, error is thrown.
		Returns pointer to buffer. If you want to use these data after next read operation, you need to copy them.
	 **/
	protected async read_short_nul_bytes_async()
	{	let i = await this.recv_to_nul();
		let value = this.buffer.subarray(this.buffer_start, i);
		this.packet_offset += i - this.buffer_start + 1;
		this.buffer_start = i + 1;
		return value;
	}

	/**	If buffer contains full blob with length-encoded length, consume it. Else return undefined.
		Null value (0xFB) will be returned as empty buffer.
	 **/
	protected read_short_lenenc_bytes()
	{	if (this.buffer_end > this.buffer_start)
		{	switch (this.buffer[this.buffer_start])
			{	case 0xFE:
				{	if (this.buffer_end-this.buffer_start < 9)
					{	return;
					}
					let value = this.data_view.getBigUint64(this.buffer_start+1, true);
					if (value <= BUFFER_LEN)
					{	let len = Number(value);
						if (this.buffer_end-this.buffer_start >= 9+len)
						{	this.buffer_start += 9 + len;
							this.packet_offset += 9 + len;
							return this.buffer.subarray(this.buffer_start-len, this.buffer_start);
						}
					}
				}
				case 0xFD:
				{	if (this.buffer_end-this.buffer_start < 4)
					{	return;
					}
					let len = this.data_view.getUint16(this.buffer_start+1, true) | (this.data_view.getUint8(this.buffer_start+3) << 16);
					if (this.buffer_end-this.buffer_start >= 4+len)
					{	this.buffer_start += 4 + len;
						this.packet_offset += 4 + len;
						return this.buffer.subarray(this.buffer_start-len, this.buffer_start);
					}
				}
				case 0xFC:
				{	if (this.buffer_end-this.buffer_start < 3)
					{	return;
					}
					let len = this.data_view.getUint16(this.buffer_start+1, true);
					if (this.buffer_end-this.buffer_start >= 3+len)
					{	this.buffer_start += 3 + len;
						this.packet_offset += 3 + len;
						return this.buffer.subarray(this.buffer_start-len, this.buffer_start);
					}
				}
				case 0xFB:
				{	this.packet_offset++;
					this.buffer_start++;
					return new Uint8Array;
				}
				default:
				{	let len = this.buffer[this.buffer_start];
					if (this.buffer_end-this.buffer_start >= 1+len)
					{	this.buffer_start += 1 + len;
						this.packet_offset += 1 + len;
						return this.buffer.subarray(this.buffer_start-len, this.buffer_start);
					}
				}
			}
		}
	}

	/**	Reads blob with length-encoded length. The blob must be not longer than BUFFER_LEN bytes, or error will be thrown.
		Returns pointer to buffer. If you want to use these data after next read operation, you need to copy them.
		Null value (0xFB) will be returned as empty buffer.
	 **/
	protected async read_short_lenenc_bytes_async()
	{	let len = this.read_lenenc_int() ?? await this.read_lenenc_int_async();
		if (len > BUFFER_LEN)
		{	throw new Error(`String is too long for this operation. Longer than ${BUFFER_LEN/1024} kib`);
		}
		let n = Number(len);
		if (n <= -1)
		{	return new Uint8Array; // null
		}
		return this.read_short_bytes(n) ?? await this.read_short_bytes_async(n);
	}

	/**	If buffer contains full packet, consume it. Else return undefined.
		Returns pointer to buffer. If you want to use these data after next read operation, you need to copy them.
	 **/
	protected read_short_eof_bytes()
	{	let len = this.payload_length - this.packet_offset;
		if (this.buffer_end-this.buffer_start >= len)
		{	this.buffer_start += len;
			this.packet_offset += len;
			let bytes = this.buffer.subarray(this.buffer_start-len, this.buffer_start);
			if (bytes[bytes.length - 1] == 0)
			{	bytes = bytes.subarray(0, -1);
			}
			return bytes;
		}
	}

	/**	To read a blob that can fit BUFFER_LEN to end of packet, do: read_short_eof_bytes() ?? await read_short_eof_bytes_async().
		This allows to avoid unnecessary promise awaiting.
		Returns pointer to buffer. If you want to use these data after next read operation, you need to copy them.
	 **/
	protected async read_short_eof_bytes_async()
	{	let len = this.payload_length - this.packet_offset;
		debug_assert(this.buffer_end-this.buffer_start < len);
		await this.recv_at_least(len);
		this.buffer_start += len;
		this.packet_offset += len;
		let bytes = this.buffer.subarray(this.buffer_start-len, this.buffer_start);
		if (bytes[bytes.length - 1] == 0)
		{	bytes = bytes.subarray(0, -1);
		}
		return bytes;
	}

	/**	Iterates over byte-chunks, till len bytes read.
		Yields subarrays of buffer. Copy them if willing to use after next iteration.
	 **/
	/*protected async *read_bytes(len: number)
	{	this.packet_offset += len;
		if (this.buffer_end > this.buffer_start)
		{	len -= this.buffer_end - this.buffer_start;
			yield this.buffer.subarray(this.buffer_start, this.buffer_end);
		}
		while (len > 0)
		{	let n_read = await this.conn.read(this.buffer);
			if (n_read == null)
			{	throw new ServerDisconnectedError('Server disconnected');
			}
			yield this.buffer.subarray(0, Math.min(n_read, len));
			len -= n_read;
		}
		this.buffer_start = 0;
		this.buffer_end = -len;
	}*/

	/**	Copies bytes to provided buffer.
	 **/
	protected async read_bytes_to_buffer(dest: Uint8Array)
	{	let pos = 0;
		if (this.buffer_end > this.buffer_start)
		{	pos = Math.min(this.buffer_end-this.buffer_start, dest.length);
			dest.set(this.buffer.subarray(this.buffer_start, this.buffer_start+pos));
			this.packet_offset += pos;
			if (pos >= dest.length)
			{	this.buffer_start += pos;
				return;
			}
			this.buffer_start = 0;
			this.buffer_end = 0;
		}
		while (pos < dest.length)
		{	let n = await this.conn.read(dest.subarray(pos));
			if (n == null)
			{	throw new ServerDisconnectedError('Server disconnected');
			}
			pos += n;
			this.packet_offset += n;
		}
	}


	// --- 5. Skip bytes

	/**	If buffer contains len bytes, skip them and return true. Else return false.
	 **/
	protected read_void(len: number)
	{	if (this.buffer_end-this.buffer_start >= len)
		{	this.buffer_start += len;
			this.packet_offset += len;
			return true;
		}
		return false;
	}

	/**	To skip len bytes, do: read_void() ?? await read_void_async().
		This allows to avoid unnecessary promise awaiting.
	 **/
	protected async read_void_async(len: number)
	{	debug_assert(this.buffer_end-this.buffer_start < len);
		this.packet_offset += len;
		if (this.buffer_end > this.buffer_start)
		{	len -= this.buffer_end - this.buffer_start;
		}
		while (len > 0)
		{	let n_read = await this.conn.read(this.buffer);
			if (n_read == null)
			{	throw new ServerDisconnectedError('Server disconnected');
			}
			len -= n_read;
		}
		this.buffer_start = 0;
		this.buffer_end = -len;
	}


	// --- 6. Reading strings

	/**	If buffer contains full fixed-length string, consume it. Else return undefined.
	 **/
	protected read_short_string(len: number)
	{	if (this.buffer_end-this.buffer_start >= len)
		{	this.buffer_start += len;
			this.packet_offset += len;
			return this.decoder.decode(this.buffer.subarray(this.buffer_start-len, this.buffer_start));
		}
	}

	/**	To read a fixed-length string that can fit BUFFER_LEN, do: read_short_string() ?? await read_short_string_async().
		This allows to avoid unnecessary promise awaiting.
	 **/
	protected async read_short_string_async(len: number)
	{	debug_assert(this.buffer_end-this.buffer_start < len);
		await this.recv_at_least(len);
		this.buffer_start += len;
		this.packet_offset += len;
		return this.decoder.decode(this.buffer.subarray(this.buffer_start-len, this.buffer_start));
	}

	/**	If buffer contains full nul-string, consume it. Else return undefined.
	 **/
	protected read_short_nul_string()
	{	let i = this.buffer.subarray(0, this.buffer_end).indexOf(0, this.buffer_start);
		if (i != -1)
		{	let value = this.decoder.decode(this.buffer.subarray(this.buffer_start, i));
			this.packet_offset += i - this.buffer_start + 1;
			this.buffer_start = i + 1;
			return value;
		}
	}

	/**	To read a nul-string that can fit BUFFER_LEN, do: read_short_nul_string() ?? await read_short_nul_string_async().
		This allows to avoid unnecessary promise awaiting.
		If the string was longer than BUFFER_LEN, error is thrown.
	 **/
	protected async read_short_nul_string_async()
	{	let i = await this.recv_to_nul();
		let value = this.decoder.decode(this.buffer.subarray(this.buffer_start, i));
		this.packet_offset += i - this.buffer_start + 1;
		this.buffer_start = i + 1;
		return value;
	}

	/**	If buffer contains full string with length-encoded length, consume it. Else return undefined.
		Null value (0xFB) will be returned as ''.
	 **/
	protected read_short_lenenc_string()
	{	let data = this.read_short_lenenc_bytes();
		if (data != undefined)
		{	return this.decoder.decode(data);
		}
	}

	/**	To read a fixed-length string that can fit BUFFER_LEN, do: read_short_lenenc_string() ?? await read_short_lenenc_string_async().
		This allows to avoid unnecessary promise awaiting.
		Null value (0xFB) will be returned as ''.
	 **/
	protected async read_short_lenenc_string_async()
	{	let len = this.read_lenenc_int() ?? await this.read_lenenc_int_async();
		if (len > BUFFER_LEN)
		{	throw new Error(`String is too long for this operation. Longer than ${BUFFER_LEN/1024} kib`);
		}
		let n = Number(len);
		if (n <= -1)
		{	return ''; // null
		}
		return this.decoder.decode(this.read_short_bytes(n) ?? await this.read_short_bytes_async(n));
	}

	/**	If buffer contains full packet, consume it. Else return undefined.
	 **/
	protected read_short_eof_string()
	{	let len = this.payload_length - this.packet_offset;
		if (this.buffer_end-this.buffer_start >= len)
		{	this.buffer_start += len;
			this.packet_offset += len;
			let bytes = this.buffer.subarray(this.buffer_start-len, this.buffer_start);
			if (bytes[bytes.length - 1] == 0)
			{	bytes = bytes.subarray(0, -1);
			}
			return this.decoder.decode(bytes);
		}
	}

	/**	To read a string that can fit BUFFER_LEN to end of packet, do: read_short_eof_string() ?? await read_short_eof_string_async().
		This allows to avoid unnecessary promise awaiting.
	 **/
	protected async read_short_eof_string_async()
	{	let len = this.payload_length - this.packet_offset;
		debug_assert(this.buffer_end-this.buffer_start < len);
		await this.recv_at_least(len);
		this.buffer_start += len;
		this.packet_offset += len;
		let bytes = this.buffer.subarray(this.buffer_start-len, this.buffer_start);
		if (bytes[bytes.length - 1] == 0)
		{	bytes = bytes.subarray(0, -1);
		}
		return this.decoder.decode(bytes);
	}
}

/*function parse_lenenc(for_data: {data: Uint8Array})
{	let {data} = for_data;
	if (data.length == 0)
	{	return 0;
	}
	switch (data[0])
	{	case 0xFE:
		{	let value = Number(new DataView(data).getBigUint64(1, true));
			for_data.data = data.subarray(9);
			return value;
		}
		case 0xFD:
		{	let view = new DataView(data);
			let value = view.getUint16(1, true) | (view.getUint8(3) << 16);
			for_data.data = data.subarray(4);
			return value;
		}
		case 0xFC:
		{	let value = new DataView(data).getUint16(1, true);
			for_data.data = data.subarray(3);
			return value;
		}
		case 0xFB:
		{	for_data.data = data.subarray(1);
			return -1; // null value
		}
		default:
		{	let value = data[0];
			for_data.data = data.subarray(1);
			return value;
		}
	}
}*/
