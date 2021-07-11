import {debug_assert} from './debug_assert.ts';
import {ServerDisconnectedError} from './errors.ts';

const INIT_BUFFER_LEN = 8*1024;

const STUB = new Uint8Array;

export class MyProtocolReader
{	protected buffer: Uint8Array;
	protected buffer_start = 0;
	protected buffer_end = 0;
	protected sequence_id = 0;
	protected payload_length = 0;
	protected packet_offset = 0; // can be negative, if correct_near_packet_boundary() joined 2 packets
	protected orig_buffer: Uint8Array;

	protected data_view: DataView;

	protected constructor(protected conn: Deno.Conn, protected decoder: TextDecoder, use_buffer: Uint8Array|undefined)
	{	this.buffer = use_buffer ?? new Uint8Array(INIT_BUFFER_LEN);
		this.orig_buffer = this.buffer;
		this.data_view = new DataView(this.buffer.buffer);
		debug_assert(this.buffer.length == INIT_BUFFER_LEN);
	}

	close()
	{	this.conn.close();
		let {orig_buffer} = this;
		this.orig_buffer = this.buffer = STUB;
		this.data_view = new DataView(STUB.buffer);
		return orig_buffer; // this buffer can be recycled
	}

	protected ensure_room(room: number)
	{	let want_len = this.buffer_end + room;
		if (want_len > this.buffer.length)
		{	debug_assert(Number.isFinite(want_len));
			let len = this.buffer.length * 2;
			while (len < want_len)
			{	len *= 2;
			}
			let new_buffer = new Uint8Array(len);
			new_buffer.set(this.buffer);
			this.buffer = new_buffer;
			this.data_view = new DataView(new_buffer.buffer);
		}
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
	{	debug_assert(n_bytes <= this.buffer.length);
		if (this.buffer_start == this.buffer_end)
		{	this.buffer_start = 0;
			this.buffer_end = 0;
		}
		else if (this.buffer_start > this.buffer.length-n_bytes)
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
		Only can read strings not longer than buffer.length, and not across packet boundary, or exception will be thrown.
		Returns i, where buffer[i] == 0, and buffer[buffer_start .. i] is the string.
	 **/
	private async recv_to_nul()
	{	if (this.buffer_start == this.buffer_end)
		{	this.buffer_start = 0;
			this.buffer_end = 0;
		}
		while (true)
		{	if (this.buffer_end == this.buffer.length)
			{	if (this.buffer_start == 0)
				{	throw new Error(`String is too long for this operation. Longer than ${this.buffer.length/1024} kib`);
				}
				this.buffer_end -= this.buffer_start;
				this.buffer.copyWithin(0, this.buffer_start);
				this.buffer_start = 0;
			}
			debug_assert(this.buffer_end < this.buffer.length);
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
	{	debug_assert(this.buffer_end-this.buffer_start < 4); // use read_packet_header() first
		await this.recv_at_least(4);
		let header = this.data_view.getUint32(this.buffer_start, true);
		this.buffer_start += 4;
		this.payload_length = header & 0xFFFFFF;
		this.sequence_id = (header >> 24) + 1; // inc sequence_id
		this.packet_offset = 0; // start counting offset
	}

	private async correct_near_packet_boundary()
	{	debug_assert(this.packet_offset > 0xFFFFFF-9); // otherwise don't call me
		debug_assert(this.payload_length <= 0xFFFFFF); // payload_length is 3-byte in the packet header
		if (this.payload_length == 0xFFFFFF)
		{	let tail = this.payload_length - this.packet_offset;
			let want_read = tail + 4; // plus 4 byte header that follows
			while (this.buffer_end-this.buffer_start < want_read)
			{	this.buffer.copyWithin(0, this.buffer_start, this.buffer_end);
				this.buffer_end -= this.buffer_start;
				this.buffer_start = 0;
				let n_read = await this.conn.read(this.buffer.subarray(this.buffer_end));
				if (n_read == null)
				{	throw new ServerDisconnectedError('Server disconnected');
				}
				this.buffer_end += n_read;
			}
			// Next packet header
			let header = this.data_view.getUint32(this.buffer_start+tail, true);
			this.payload_length = header & 0xFFFFFF;
			this.sequence_id = (header >> 24) + 1; // inc sequence_id
			this.packet_offset = -tail;
			// Cut header to join 2 payload parts
			this.buffer.copyWithin(this.buffer_start+4, this.buffer_start, this.buffer_start+tail);
			// Skip bytes where header laid
			this.buffer_start += 4;
		}
	}


	// --- 3. Reading numbers

	/**	If buffer contains full uint8_t, consume it. Else return undefined.
	 **/
	protected read_uint8()
	{	if (this.buffer_end > this.buffer_start && this.packet_offset <= 0xFFFFFF-1)
		{	debug_assert(this.payload_length-this.packet_offset >= 1);
			this.packet_offset++;
			return this.buffer[this.buffer_start++];
		}
	}

	/**	To read a uint8_t, do: read_uint8() ?? await read_uint8_async().
		This allows to avoid unnecessary promise awaiting.
	 **/
	protected async read_uint8_async()
	{	if (this.packet_offset > 0xFFFFFF-1)
		{	await this.correct_near_packet_boundary();
		}
		await this.recv_at_least(1);
		let value = this.buffer[this.buffer_start++];
		this.packet_offset++;
		return value;
	}

	/**	If buffer contains full uint16_t, consume it. Else return undefined.
	 **/
	protected read_uint16()
	{	if (this.buffer_end-this.buffer_start >= 2 && this.packet_offset <= 0xFFFFFF-2)
		{	debug_assert(this.payload_length-this.packet_offset >= 2);
			let value = this.data_view.getUint16(this.buffer_start, true);
			this.buffer_start += 2;
			this.packet_offset += 2;
			return value;
		}
	}

	/**	To read a uint16_t, do: read_uint16() ?? await read_uint16_async().
		This allows to avoid unnecessary promise awaiting.
	 **/
	protected async read_uint16_async()
	{	if (this.packet_offset > 0xFFFFFF-2)
		{	await this.correct_near_packet_boundary();
		}
		await this.recv_at_least(2);
		let value = this.data_view.getUint16(this.buffer_start, true);
		this.buffer_start += 2;
		this.packet_offset += 2;
		return value;
	}

	/**	If buffer contains full 3-byte little-endian unsigned int, consume it. Else return undefined.
	 **/
	protected read_uint24()
	{	if (this.buffer_end-this.buffer_start >= 3 && this.packet_offset <= 0xFFFFFF-3)
		{	debug_assert(this.payload_length-this.packet_offset >= 3);
			let value = this.data_view.getUint16(this.buffer_start, true) | (this.data_view.getUint8(this.buffer_start+2) << 16);
			this.buffer_start += 3;
			this.packet_offset += 3;
			return value;
		}
	}

	/**	To read a 3-byte little-endian unsigned int, do: read_uint24() ?? await read_uint24_async().
		This allows to avoid unnecessary promise awaiting.
	 **/
	protected async read_uint24_async()
	{	if (this.packet_offset > 0xFFFFFF-3)
		{	await this.correct_near_packet_boundary();
		}
		await this.recv_at_least(3);
		let value = this.data_view.getUint16(this.buffer_start, true) | (this.data_view.getUint8(this.buffer_start+2) << 16);
		this.buffer_start += 3;
		this.packet_offset += 3;
		return value;
	}

	/**	If buffer contains full uint32_t, consume it. Else return undefined.
	 **/
	protected read_uint32()
	{	if (this.buffer_end-this.buffer_start >= 4 && this.packet_offset <= 0xFFFFFF-4)
		{	debug_assert(this.payload_length-this.packet_offset >= 4);
			let value = this.data_view.getUint32(this.buffer_start, true);
			this.buffer_start += 4;
			this.packet_offset += 4;
			return value;
		}
	}

	/**	To read a uint32_t, do: read_uint32() ?? await read_uint32_async().
		This allows to avoid unnecessary promise awaiting.
	 **/
	protected async read_uint32_async()
	{	if (this.packet_offset > 0xFFFFFF-4)
		{	await this.correct_near_packet_boundary();
		}
		await this.recv_at_least(4);
		let value = this.data_view.getUint32(this.buffer_start, true);
		this.buffer_start += 4;
		this.packet_offset += 4;
		return value;
	}

	/**	If buffer contains full uint64_t, consume it. Else return undefined.
	 **/
	protected read_uint64()
	{	if (this.buffer_end-this.buffer_start >= 8 && this.packet_offset <= 0xFFFFFF-8)
		{	debug_assert(this.payload_length-this.packet_offset >= 8);
			let value = this.data_view.getBigUint64(this.buffer_start, true);
			this.buffer_start += 8;
			this.packet_offset += 8;
			return value;
		}
	}

	/**	To read a uint64_t, do: read_uint64() ?? await read_uint64_async().
		This allows to avoid unnecessary promise awaiting.
	 **/
	protected async read_uint64_async()
	{	if (this.packet_offset > 0xFFFFFF-8)
		{	await this.correct_near_packet_boundary();
		}
		await this.recv_at_least(8);
		let value = this.data_view.getBigUint64(this.buffer_start, true);
		this.buffer_start += 8;
		this.packet_offset += 8;
		return value;
	}

	/**	If buffer contains full float, consume it. Else return undefined.
	 **/
	protected read_float()
	{	if (this.buffer_end-this.buffer_start >= 4 && this.packet_offset <= 0xFFFFFF-4)
		{	debug_assert(this.payload_length-this.packet_offset >= 4);
			let value = this.data_view.getFloat32(this.buffer_start, true);
			this.buffer_start += 4;
			this.packet_offset += 4;
			return value;
		}
	}

	/**	To read a IEEE 754 32-bit single-precision, do: read_float() ?? await read_float_async().
		This allows to avoid unnecessary promise awaiting.
	 **/
	protected async read_float_async()
	{	if (this.packet_offset > 0xFFFFFF-4)
		{	await this.correct_near_packet_boundary();
		}
		await this.recv_at_least(4);
		let value = this.data_view.getFloat32(this.buffer_start, true);
		this.buffer_start += 4;
		this.packet_offset += 4;
		return value;
	}

	/**	If buffer contains full double, consume it. Else return undefined.
	 **/
	protected read_double()
	{	if (this.buffer_end-this.buffer_start >= 8 && this.packet_offset <= 0xFFFFFF-8)
		{	debug_assert(this.payload_length-this.packet_offset >= 8);
			let value = this.data_view.getFloat64(this.buffer_start, true);
			this.buffer_start += 8;
			this.packet_offset += 8;
			return value;
		}
	}

	/**	To read a IEEE 754 32-bit double-precision, do: read_double() ?? await read_double_async().
		This allows to avoid unnecessary promise awaiting.
	 **/
	protected async read_double_async()
	{	if (this.packet_offset > 0xFFFFFF-8)
		{	await this.correct_near_packet_boundary();
		}
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
	{	if (this.buffer_end > this.buffer_start && this.packet_offset <= 0xFFFFFF-9)
		{	debug_assert(this.payload_length-this.packet_offset >= 1);
			switch (this.buffer[this.buffer_start])
			{	case 0xFE:
				{	if (this.buffer_end-this.buffer_start < 9)
					{	return;
					}
					debug_assert(this.payload_length-this.packet_offset >= 9);
					let value_64 = this.data_view.getBigUint64(this.buffer_start+1, true);
					this.buffer_start += 9;
					this.packet_offset += 9;
					return value_64<Number.MIN_SAFE_INTEGER || value_64>Number.MAX_SAFE_INTEGER ? value_64 : Number(value_64);
				}
				case 0xFD:
				{	if (this.buffer_end-this.buffer_start < 4)
					{	return;
					}
					debug_assert(this.payload_length-this.packet_offset >= 4);
					let value = this.data_view.getUint16(this.buffer_start+1, true) | (this.data_view.getUint8(this.buffer_start+3) << 16);
					this.buffer_start += 4;
					this.packet_offset += 4;
					return value;
				}
				case 0xFC:
				{	if (this.buffer_end-this.buffer_start < 3)
					{	return;
					}
					debug_assert(this.payload_length-this.packet_offset >= 3);
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
	{	if (this.packet_offset > 0xFFFFFF-9)
		{	await this.correct_near_packet_boundary();
		}
		if (this.buffer_end == this.buffer_start)
		{	await this.recv_at_least(1);
		}
		switch (this.buffer[this.buffer_start])
		{	case 0xFE:
			{	debug_assert(this.payload_length-this.packet_offset >= 9);
				await this.recv_at_least(9);
				let value_64 = this.data_view.getBigUint64(this.buffer_start+1, true);
				this.buffer_start += 9;
				this.packet_offset += 9;
				return value_64<Number.MIN_SAFE_INTEGER || value_64>Number.MAX_SAFE_INTEGER ? value_64 : Number(value_64);
			}
			case 0xFD:
			{	debug_assert(this.payload_length-this.packet_offset >= 4);
				await this.recv_at_least(4);
				let value = this.data_view.getUint16(this.buffer_start+1, true) | (this.data_view.getUint8(this.buffer_start+3) << 16);
				this.buffer_start += 4;
				this.packet_offset += 4;
				return value;
			}
			case 0xFC:
			{	debug_assert(this.payload_length-this.packet_offset >= 3);
				await this.recv_at_least(3);
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
	{	if (len > this.buffer.length-4) // minus 4 byte header
		{	throw new Error(`String is too long for this operation. Longer than ${this.buffer.length-4} bytes`);
		}
		let have_bytes = this.buffer_end - this.buffer_start;
		if (have_bytes >= len)
		{	let len_in_cur_packet = this.payload_length - this.packet_offset;
			if (len_in_cur_packet >= len)
			{	this.buffer_start += len;
				this.packet_offset += len;
				return this.buffer.subarray(this.buffer_start-len, this.buffer_start);
			}
			else if (have_bytes >= len+4) // across packet boundary: count 4-byte header
			{	let value = new Uint8Array(len);
				value.set(this.buffer.subarray(this.buffer_start, this.buffer_start+len_in_cur_packet));
				this.buffer_start += len_in_cur_packet;
				len -= len_in_cur_packet;
				this.read_packet_header();
				value.set(this.buffer.subarray(this.buffer_start, this.buffer_start+len), len_in_cur_packet);
				this.buffer_start += len;
				debug_assert(this.buffer_start <= this.buffer_end);
				return value;
			}
		}
	}

	/**	To read len bytes, where len<=buffer.length-4, do: read_short_bytes() ?? await read_short_bytes_async().
		This allows to avoid unnecessary promise awaiting.
		Returns pointer to buffer. If you want to use these data after next read operation, you need to copy them.
	 **/
	protected async read_short_bytes_async(len: number)
	{	debug_assert(len <= this.buffer.length-4); // use read_short_bytes() first
		let len_in_cur_packet = this.payload_length - this.packet_offset;
		if (len_in_cur_packet >= len)
		{	await this.recv_at_least(len);
			this.buffer_start += len;
			this.packet_offset += len;
			return this.buffer.subarray(this.buffer_start-len, this.buffer_start);
		}
		else
		{	await this.recv_at_least(len_in_cur_packet + 4);
			let value = new Uint8Array(len);
			value.set(this.buffer.subarray(this.buffer_start, this.buffer_start+len_in_cur_packet));
			this.buffer_start += len_in_cur_packet;
			len -= len_in_cur_packet;
			this.read_packet_header();
			await this.recv_at_least(len);
			value.set(this.buffer.subarray(this.buffer_start, this.buffer_start+len), len_in_cur_packet);
			this.buffer_start += len;
			debug_assert(this.buffer_start <= this.buffer_end);
			return value;
		}
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
			debug_assert(this.packet_offset <= this.payload_length); // only call this function where the string is known not to cross packet boundary
			return value;
		}
	}

	/**	To read a null-terminated blob that can fit buffer.length (not across packet boundary), do: read_short_nul_bytes() ?? await read_short_nul_bytes_async().
		This allows to avoid unnecessary promise awaiting.
		If the blob was longer than buffer.length, error is thrown.
		Returns pointer to buffer. If you want to use these data after next read operation, you need to copy them.
	 **/
	protected async read_short_nul_bytes_async()
	{	let i = await this.recv_to_nul();
		let value = this.buffer.subarray(this.buffer_start, i);
		this.packet_offset += i - this.buffer_start + 1;
		this.buffer_start = i + 1;
		debug_assert(this.packet_offset <= this.payload_length); // only call this function where the string is known not to cross packet boundary
		return value;
	}

	/**	If buffer contains full blob with length-encoded length, consume it. Else return undefined.
		Null value (0xFB) will be returned as empty buffer.
	 **/
	protected read_short_lenenc_bytes()
	{	if (this.buffer_end > this.buffer_start && this.packet_offset <= 0xFFFFFF-9)
		{	debug_assert(this.payload_length-this.packet_offset >= 1);
			let str_len = -1;
			let all_len = -1;
			switch (this.buffer[this.buffer_start])
			{	case 0xFE:
				{	if (this.buffer_end-this.buffer_start < 9)
					{	return;
					}
					debug_assert(this.payload_length-this.packet_offset >= 9);
					let value = this.data_view.getBigUint64(this.buffer_start+1, true);
					if (value <= this.buffer.length)
					{	str_len = Number(value);
						all_len = str_len + 9;
					}
					break;
				}
				case 0xFD:
				{	if (this.buffer_end-this.buffer_start < 4)
					{	return;
					}
					debug_assert(this.payload_length-this.packet_offset >= 4);
					str_len = this.data_view.getUint16(this.buffer_start+1, true) | (this.data_view.getUint8(this.buffer_start+3) << 16);
					all_len = str_len + 4;
					break;
				}
				case 0xFC:
				{	if (this.buffer_end-this.buffer_start < 3)
					{	return;
					}
					debug_assert(this.payload_length-this.packet_offset >= 3);
					str_len = this.data_view.getUint16(this.buffer_start+1, true);
					all_len = str_len + 3;
					break;
				}
				case 0xFB:
				{	this.packet_offset++;
					this.buffer_start++;
					return new Uint8Array;
				}
				default:
				{	str_len = this.buffer[this.buffer_start];
					all_len = str_len + 1;
				}
			}
			if (str_len != -1)
			{	let have_bytes = this.buffer_end - this.buffer_start;
				if (have_bytes >= all_len)
				{	let len_in_cur_packet = this.payload_length - this.packet_offset;
					if (len_in_cur_packet >= all_len)
					{	this.buffer_start += all_len;
						this.packet_offset += all_len;
						return this.buffer.subarray(this.buffer_start-str_len, this.buffer_start);
					}
					else if (have_bytes >= all_len+4) // across packet boundary: count 4-byte header
					{	let value = new Uint8Array(str_len);
						let num_len = all_len - str_len;
						value.set(this.buffer.subarray(this.buffer_start+num_len, this.buffer_start+len_in_cur_packet));
						this.buffer_start += len_in_cur_packet;
						str_len -= len_in_cur_packet - num_len;
						this.read_packet_header();
						value.set(this.buffer.subarray(this.buffer_start, this.buffer_start+str_len), len_in_cur_packet-num_len);
						this.buffer_start += str_len;
						debug_assert(this.buffer_start <= this.buffer_end);
						return value;
					}
				}
			}
		}
	}

	/**	Reads blob with length-encoded length. The blob must be not longer than buffer.length-4 bytes, or error will be thrown.
		Returns pointer to buffer. If you want to use these data after next read operation, you need to copy them.
		Null value (0xFB) will be returned as empty buffer.
	 **/
	protected async read_short_lenenc_bytes_async()
	{	let len = this.read_lenenc_int() ?? await this.read_lenenc_int_async();
		if (len > this.buffer.length-4)
		{	throw new Error(`String is too long for this operation. Longer than ${this.buffer.length-4} bytes`);
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

	/**	To read a blob that can fit buffer.length to end of packet, do: read_short_eof_bytes() ?? await read_short_eof_bytes_async().
		This allows to avoid unnecessary promise awaiting.
		Returns pointer to buffer. If you want to use these data after next read operation, you need to copy them.
	 **/
	protected async read_short_eof_bytes_async()
	{	let len = this.payload_length - this.packet_offset;
		debug_assert(this.buffer_end-this.buffer_start < len); // use read_short_eof_bytes() first
		await this.recv_at_least(len);
		this.buffer_start += len;
		this.packet_offset += len;
		let bytes = this.buffer.subarray(this.buffer_start-len, this.buffer_start);
		if (bytes[bytes.length - 1] == 0)
		{	bytes = bytes.subarray(0, -1);
		}
		return bytes;
	}

	/**	Copies bytes to provided buffer.
	 **/
	protected async read_bytes_to_buffer(dest: Uint8Array)
	{	let pos = 0;
		while (pos < dest.length)
		{	let len_in_cur_packet = this.payload_length - this.packet_offset;
			if (len_in_cur_packet == 0)
			{	this.read_packet_header() || await this.read_packet_header_async();
				len_in_cur_packet = this.payload_length - this.packet_offset;
			}
			let have_bytes = this.buffer_end - this.buffer_start;
			while (have_bytes>0 && len_in_cur_packet>0 && pos<dest.length)
			{	let len = Math.min(have_bytes, len_in_cur_packet, dest.length-pos);
				dest.set(this.buffer.subarray(this.buffer_start, this.buffer_start+len), pos);
				pos += len;
				this.packet_offset += len;
				this.buffer_start += len;
				have_bytes -= len;
				len_in_cur_packet -= len;
			}
			while (len_in_cur_packet>0 && pos<dest.length)
			{	let n = await this.conn.read(dest.subarray(pos, Math.min(dest.length, pos+len_in_cur_packet)));
				if (n == null)
				{	throw new ServerDisconnectedError('Server disconnected');
				}
				pos += n;
				this.packet_offset += n;
				this.buffer_start = 0;
				this.buffer_end = 0;
				len_in_cur_packet -= n;
			}
		}
	}


	// --- 5. Skip bytes

	/**	If buffer contains len bytes, skip them and return true. Else return false.
	 **/
	protected read_void(len: number)
	{	if (this.buffer_end-this.buffer_start >= len && this.packet_offset <= 0xFFFFFF-len)
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
	{	while (len > 0)
		{	if (this.packet_offset > 0xFFFFFF-1)
			{	await this.correct_near_packet_boundary();
			}
			let len_in_cur_packet = Math.min(len, this.payload_length-this.packet_offset);
			len -= len_in_cur_packet;
			this.packet_offset += len_in_cur_packet;
			if (this.buffer_end > this.buffer_start)
			{	len_in_cur_packet -= this.buffer_end - this.buffer_start;
			}
			while (len_in_cur_packet > 0)
			{	let n_read = await this.conn.read(this.buffer);
				if (n_read == null)
				{	throw new ServerDisconnectedError('Server disconnected');
				}
				len_in_cur_packet -= n_read;
			}
			this.buffer_start = 0;
			this.buffer_end = -len_in_cur_packet;
		}
	}


	// --- 6. Reading strings

	/**	If buffer contains full fixed-length string, consume it. Else return undefined.
	 **/
	protected read_short_string(len: number)
	{	let bytes = this.read_short_bytes(len);
		if (bytes != undefined)
		{	return this.decoder.decode(bytes);
		}
	}

	/**	To read a fixed-length string that can fit buffer.length-4, do: read_short_string() ?? await read_short_string_async().
		This allows to avoid unnecessary promise awaiting.
	 **/
	protected async read_short_string_async(len: number)
	{	debug_assert(len <= this.buffer.length-4); // use read_short_bytes() first
		let len_in_cur_packet = this.payload_length - this.packet_offset;
		if (len_in_cur_packet >= len)
		{	await this.recv_at_least(len);
			this.buffer_start += len;
			this.packet_offset += len;
			return this.decoder.decode(this.buffer.subarray(this.buffer_start-len, this.buffer_start));
		}
		else
		{	await this.recv_at_least(len_in_cur_packet + 4);
			let value = new Uint8Array(len);
			value.set(this.buffer.subarray(this.buffer_start, this.buffer_start+len_in_cur_packet));
			this.buffer_start += len_in_cur_packet;
			len -= len_in_cur_packet;
			this.read_packet_header();
			await this.recv_at_least(len);
			value.set(this.buffer.subarray(this.buffer_start, this.buffer_start+len), len_in_cur_packet);
			this.buffer_start += len;
			debug_assert(this.buffer_start <= this.buffer_end);
			return this.decoder.decode(value);
		}
	}

	/**	If buffer contains full nul-string, consume it. Else return undefined.
	 **/
	protected read_short_nul_string()
	{	let i = this.buffer.subarray(0, this.buffer_end).indexOf(0, this.buffer_start);
		if (i != -1)
		{	let value = this.decoder.decode(this.buffer.subarray(this.buffer_start, i));
			this.packet_offset += i - this.buffer_start + 1;
			this.buffer_start = i + 1;
			debug_assert(this.packet_offset <= this.payload_length); // only call this function where the string is known not to cross packet boundary
			return value;
		}
	}

	/**	To read a nul-string that can fit buffer.length, do: read_short_nul_string() ?? await read_short_nul_string_async().
		This allows to avoid unnecessary promise awaiting.
		If the string was longer than buffer.length, error is thrown.
	 **/
	protected async read_short_nul_string_async()
	{	let i = await this.recv_to_nul();
		let value = this.decoder.decode(this.buffer.subarray(this.buffer_start, i));
		this.packet_offset += i - this.buffer_start + 1;
		this.buffer_start = i + 1;
		debug_assert(this.packet_offset <= this.payload_length); // only call this function where the string is known not to cross packet boundary
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

	/**	To read a fixed-length string that can fit buffer.length-4, do: read_short_lenenc_string() ?? await read_short_lenenc_string_async().
		This allows to avoid unnecessary promise awaiting.
		Null value (0xFB) will be returned as ''.
	 **/
	protected async read_short_lenenc_string_async()
	{	let len = this.read_lenenc_int() ?? await this.read_lenenc_int_async();
		if (len > this.buffer.length-4)
		{	throw new Error(`String is too long for this operation. Longer than ${this.buffer.length-4} bytes`);
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

	/**	To read a string that can fit buffer.length to end of packet, do: read_short_eof_string() ?? await read_short_eof_string_async().
		This allows to avoid unnecessary promise awaiting.
	 **/
	protected async read_short_eof_string_async()
	{	let len = this.payload_length - this.packet_offset;
		debug_assert(this.buffer_end-this.buffer_start < len); // use read_short_eof_string() first
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
