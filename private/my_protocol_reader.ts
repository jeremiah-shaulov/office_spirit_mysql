import {debugAssert} from './debug_assert.ts';
import {ServerDisconnectedError} from './errors.ts';

const INIT_BUFFER_LEN = 8*1024;

const STUB = new Uint8Array;

export class MyProtocolReader
{	protected buffer: Uint8Array;
	protected bufferStart = 0;
	protected bufferEnd = 0;
	protected sequenceId = 0;
	protected payloadLength = 0;
	protected packetOffset = 0; // can be negative, if correctNearPacketBoundary() joined 2 packets
	protected dataView: DataView;

	private origBuffer: Uint8Array;

	protected constructor(protected conn: Deno.Conn, protected decoder: TextDecoder, useBuffer: Uint8Array|undefined)
	{	this.buffer = useBuffer ?? new Uint8Array(INIT_BUFFER_LEN);
		this.origBuffer = this.buffer;
		this.dataView = new DataView(this.buffer.buffer);
		debugAssert(this.buffer.length == INIT_BUFFER_LEN);
	}

	recycleBuffer()
	{	const {origBuffer} = this;
		this.origBuffer = this.buffer = STUB;
		this.dataView = new DataView(STUB.buffer);
		return origBuffer; // this buffer can be recycled
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
			this.dataView = new DataView(newBuffer.buffer);
		}
	}

	protected isAtEndOfPacket()
	{	return this.packetOffset >= this.payloadLength;
	}

	protected gotoEndOfPacket()
	{	debugAssert(this.packetOffset <= this.payloadLength);
		return this.readVoid(this.payloadLength-this.packetOffset);
	}

	protected gotoEndOfPacketAsync()
	{	return this.readVoidAsync(this.payloadLength-this.packetOffset);
	}

	/**	Immediately after readUint8() or readUint8Async(), it's possible to put the just read byte back, so you will read it again.
	 **/
	protected unput(byte: number)
	{	debugAssert(this.bufferStart>0 && this.packetOffset>0);
		this.bufferStart--;
		this.packetOffset--;
		this.buffer[this.bufferStart] = byte;
	}


	// --- 1. recv*

	private async recvAtLeast(nBytes: number, canEof=false)
	{	debugAssert(nBytes <= this.buffer.length);
		if (this.bufferStart == this.bufferEnd)
		{	this.bufferStart = 0;
			this.bufferEnd = 0;
		}
		else if (this.bufferStart > this.buffer.length-nBytes)
		{	this.buffer.copyWithin(0, this.bufferStart, this.bufferEnd);
			this.bufferEnd -= this.bufferStart;
			this.bufferStart = 0;
		}
		const to = this.bufferStart + nBytes;
		while (this.bufferEnd < to)
		{	const nRead = await this.conn.read(this.buffer.subarray(this.bufferEnd));
			if (nRead == null)
			{	if (canEof && this.bufferEnd-this.bufferStart==0)
				{	return false;
				}
				throw new ServerDisconnectedError('Lost connection to server');
			}
			this.bufferEnd += nRead;
		}
		return true;
	}

	/**	Don't call if buffer.subarray(bufferStart, bufferEnd).indexOf(0) != -1.
		Only can read strings not longer than buffer.length, and not across packet boundary, or exception will be thrown.
		Returns i, where buffer[i] == 0, and buffer[bufferStart .. i] is the string.
	 **/
	private async recvToNul()
	{	if (this.bufferStart == this.bufferEnd)
		{	this.bufferStart = 0;
			this.bufferEnd = 0;
		}
		while (true)
		{	if (this.bufferEnd == this.buffer.length)
			{	if (this.bufferStart == 0)
				{	throw new Error(`String is too long for this operation. Longer than ${this.buffer.length/1024} kib`);
				}
				this.bufferEnd -= this.bufferStart;
				this.buffer.copyWithin(0, this.bufferStart);
				this.bufferStart = 0;
			}
			debugAssert(this.bufferEnd < this.buffer.length);
			const nRead = await this.conn.read(this.buffer.subarray(this.bufferEnd));
			if (nRead == null)
			{	throw new ServerDisconnectedError('Lost connection to server');
			}
			this.bufferEnd += nRead;
			const i = this.buffer.subarray(0, this.bufferEnd).indexOf(0, this.bufferEnd-nRead);
			if (i != -1)
			{	debugAssert(this.buffer[i] == 0);
				return i;
			}
		}
	}


	// --- 2. Reading packet headers

	/**	If buffer contains full header, consume it, and return true. Else return false.
	 **/
	protected readPacketHeader()
	{	if (this.bufferEnd-this.bufferStart >= 4)
		{	const header = this.dataView.getUint32(this.bufferStart, true);
			this.bufferStart += 4;
			this.payloadLength = header & 0xFFFFFF;
			this.sequenceId = (header >> 24) + 1; // inc sequenceId
			this.packetOffset = 0; // start counting offset
			return true;
		}
		return false;
	}

	/**	To read a header, do: readPacketHeader() || await readPacketHeaderAsync().
		This allows to avoid unnecessary promise awaiting.
	 **/
	protected async readPacketHeaderAsync()
	{	debugAssert(this.bufferEnd-this.bufferStart < 4); // use readPacketHeader() first
		await this.recvAtLeast(4);
		const header = this.dataView.getUint32(this.bufferStart, true);
		this.bufferStart += 4;
		this.payloadLength = header & 0xFFFFFF;
		this.sequenceId = (header >> 24) + 1; // inc sequenceId
		this.packetOffset = 0; // start counting offset
	}

	private async correctNearPacketBoundary()
	{	debugAssert(this.packetOffset > 0xFFFFFF-9); // otherwise don't call me
		debugAssert(this.payloadLength <= 0xFFFFFF); // payloadLength is 3-byte in the packet header
		if (this.payloadLength == 0xFFFFFF)
		{	const tail = this.payloadLength - this.packetOffset;
			const wantRead = tail + 4; // plus 4 byte header that follows
			while (this.bufferEnd-this.bufferStart < wantRead)
			{	this.buffer.copyWithin(0, this.bufferStart, this.bufferEnd);
				this.bufferEnd -= this.bufferStart;
				this.bufferStart = 0;
				const nRead = await this.conn.read(this.buffer.subarray(this.bufferEnd));
				if (nRead == null)
				{	throw new ServerDisconnectedError('Lost connection to server');
				}
				this.bufferEnd += nRead;
			}
			// Next packet header
			const header = this.dataView.getUint32(this.bufferStart+tail, true);
			this.payloadLength = header & 0xFFFFFF;
			this.sequenceId = (header >> 24) + 1; // inc sequenceId
			this.packetOffset = -tail;
			// Cut header to join 2 payload parts
			this.buffer.copyWithin(this.bufferStart+4, this.bufferStart, this.bufferStart+tail);
			// Skip bytes where header laid
			this.bufferStart += 4;
		}
	}


	// --- 3. Reading numbers

	/**	If buffer contains full uint8_t, consume it. Else return undefined.
	 **/
	protected readUint8()
	{	if (this.bufferEnd > this.bufferStart && this.packetOffset <= 0xFFFFFF-1)
		{	debugAssert(this.payloadLength-this.packetOffset >= 1);
			this.packetOffset++;
			return this.buffer[this.bufferStart++];
		}
	}

	/**	To read a uint8_t, do: readUint8() ?? await readUint8Async().
		This allows to avoid unnecessary promise awaiting.
	 **/
	protected async readUint8Async()
	{	if (this.packetOffset > 0xFFFFFF-1)
		{	await this.correctNearPacketBoundary();
		}
		await this.recvAtLeast(1);
		const value = this.buffer[this.bufferStart++];
		this.packetOffset++;
		return value;
	}

	/**	If buffer contains full int8_t, consume it. Else return undefined.
	 **/
	protected readInt8()
	{	if (this.bufferEnd > this.bufferStart && this.packetOffset <= 0xFFFFFF-1)
		{	debugAssert(this.payloadLength-this.packetOffset >= 1);
			this.packetOffset++;
			return this.dataView.getInt8(this.bufferStart++);
		}
	}

	/**	To read a int8_t, do: readInt8() ?? await readInt8Async().
		This allows to avoid unnecessary promise awaiting.
	 **/
	protected async readInt8Async()
	{	if (this.packetOffset > 0xFFFFFF-1)
		{	await this.correctNearPacketBoundary();
		}
		await this.recvAtLeast(1);
		const value = this.dataView.getInt8(this.bufferStart++);
		this.packetOffset++;
		return value;
	}

	/**	If buffer contains full uint16_t, consume it. Else return undefined.
	 **/
	protected readUint16()
	{	if (this.bufferEnd-this.bufferStart >= 2 && this.packetOffset <= 0xFFFFFF-2)
		{	debugAssert(this.payloadLength-this.packetOffset >= 2);
			const value = this.dataView.getUint16(this.bufferStart, true);
			this.bufferStart += 2;
			this.packetOffset += 2;
			return value;
		}
	}

	/**	To read a uint16_t, do: readUint16() ?? await readUint16Async().
		This allows to avoid unnecessary promise awaiting.
	 **/
	protected async readUint16Async()
	{	if (this.packetOffset > 0xFFFFFF-2)
		{	await this.correctNearPacketBoundary();
		}
		await this.recvAtLeast(2);
		const value = this.dataView.getUint16(this.bufferStart, true);
		this.bufferStart += 2;
		this.packetOffset += 2;
		return value;
	}

	/**	If buffer contains full int16_t, consume it. Else return undefined.
	 **/
	protected readInt16()
	{	if (this.bufferEnd-this.bufferStart >= 2 && this.packetOffset <= 0xFFFFFF-2)
		{	debugAssert(this.payloadLength-this.packetOffset >= 2);
			const value = this.dataView.getInt16(this.bufferStart, true);
			this.bufferStart += 2;
			this.packetOffset += 2;
			return value;
		}
	}

	/**	To read a int16_t, do: readInt16() ?? await readInt16Async().
		This allows to avoid unnecessary promise awaiting.
	 **/
	protected async readInt16Async()
	{	if (this.packetOffset > 0xFFFFFF-2)
		{	await this.correctNearPacketBoundary();
		}
		await this.recvAtLeast(2);
		const value = this.dataView.getInt16(this.bufferStart, true);
		this.bufferStart += 2;
		this.packetOffset += 2;
		return value;
	}

	/**	If buffer contains full 3-byte little-endian unsigned int, consume it. Else return undefined.
	 **/
	protected readUint24()
	{	if (this.bufferEnd-this.bufferStart >= 3 && this.packetOffset <= 0xFFFFFF-3)
		{	debugAssert(this.payloadLength-this.packetOffset >= 3);
			const value = this.dataView.getUint16(this.bufferStart, true) | (this.dataView.getUint8(this.bufferStart+2) << 16);
			this.bufferStart += 3;
			this.packetOffset += 3;
			return value;
		}
	}

	/**	To read a 3-byte little-endian unsigned int, do: readUint24() ?? await readUint24Async().
		This allows to avoid unnecessary promise awaiting.
	 **/
	protected async readUint24Async()
	{	if (this.packetOffset > 0xFFFFFF-3)
		{	await this.correctNearPacketBoundary();
		}
		await this.recvAtLeast(3);
		const value = this.dataView.getUint16(this.bufferStart, true) | (this.dataView.getUint8(this.bufferStart+2) << 16);
		this.bufferStart += 3;
		this.packetOffset += 3;
		return value;
	}

	/**	If buffer contains full uint32_t, consume it. Else return undefined.
	 **/
	protected readUint32()
	{	if (this.bufferEnd-this.bufferStart >= 4 && this.packetOffset <= 0xFFFFFF-4)
		{	debugAssert(this.payloadLength-this.packetOffset >= 4);
			const value = this.dataView.getUint32(this.bufferStart, true);
			this.bufferStart += 4;
			this.packetOffset += 4;
			return value;
		}
	}

	/**	To read a uint32_t, do: readUint32() ?? await readUint32Async().
		This allows to avoid unnecessary promise awaiting.
	 **/
	protected async readUint32Async()
	{	if (this.packetOffset > 0xFFFFFF-4)
		{	await this.correctNearPacketBoundary();
		}
		await this.recvAtLeast(4);
		const value = this.dataView.getUint32(this.bufferStart, true);
		this.bufferStart += 4;
		this.packetOffset += 4;
		return value;
	}

	/**	If buffer contains full int32_t, consume it. Else return undefined.
	 **/
	protected readInt32()
	{	if (this.bufferEnd-this.bufferStart >= 4 && this.packetOffset <= 0xFFFFFF-4)
		{	debugAssert(this.payloadLength-this.packetOffset >= 4);
			const value = this.dataView.getInt32(this.bufferStart, true);
			this.bufferStart += 4;
			this.packetOffset += 4;
			return value;
		}
	}

	/**	To read a int32_t, do: readInt32() ?? await readInt32Async().
		This allows to avoid unnecessary promise awaiting.
	 **/
	protected async readInt32Async()
	{	if (this.packetOffset > 0xFFFFFF-4)
		{	await this.correctNearPacketBoundary();
		}
		await this.recvAtLeast(4);
		const value = this.dataView.getInt32(this.bufferStart, true);
		this.bufferStart += 4;
		this.packetOffset += 4;
		return value;
	}

	/**	If buffer contains full uint64_t, consume it. Else return undefined.
	 **/
	protected readUint64()
	{	if (this.bufferEnd-this.bufferStart >= 8 && this.packetOffset <= 0xFFFFFF-8)
		{	debugAssert(this.payloadLength-this.packetOffset >= 8);
			const value = this.dataView.getBigUint64(this.bufferStart, true);
			this.bufferStart += 8;
			this.packetOffset += 8;
			return value;
		}
	}

	/**	To read a uint64_t, do: readUint64() ?? await readUint64Async().
		This allows to avoid unnecessary promise awaiting.
	 **/
	protected async readUint64Async()
	{	if (this.packetOffset > 0xFFFFFF-8)
		{	await this.correctNearPacketBoundary();
		}
		await this.recvAtLeast(8);
		const value = this.dataView.getBigUint64(this.bufferStart, true);
		this.bufferStart += 8;
		this.packetOffset += 8;
		return value;
	}

	/**	If buffer contains full int64_t, consume it. Else return undefined.
	 **/
	protected readInt64()
	{	if (this.bufferEnd-this.bufferStart >= 8 && this.packetOffset <= 0xFFFFFF-8)
		{	debugAssert(this.payloadLength-this.packetOffset >= 8);
			const value = this.dataView.getBigInt64(this.bufferStart, true);
			this.bufferStart += 8;
			this.packetOffset += 8;
			return value;
		}
	}

	/**	To read a int64_t, do: readInt64() ?? await readInt64Async().
		This allows to avoid unnecessary promise awaiting.
	 **/
	protected async readInt64Async()
	{	if (this.packetOffset > 0xFFFFFF-8)
		{	await this.correctNearPacketBoundary();
		}
		await this.recvAtLeast(8);
		const value = this.dataView.getBigInt64(this.bufferStart, true);
		this.bufferStart += 8;
		this.packetOffset += 8;
		return value;
	}

	/**	If buffer contains full float, consume it. Else return undefined.
	 **/
	protected readFloat()
	{	if (this.bufferEnd-this.bufferStart >= 4 && this.packetOffset <= 0xFFFFFF-4)
		{	debugAssert(this.payloadLength-this.packetOffset >= 4);
			const value = this.dataView.getFloat32(this.bufferStart, true);
			this.bufferStart += 4;
			this.packetOffset += 4;
			return value;
		}
	}

	/**	To read a IEEE 754 32-bit single-precision, do: readFloat() ?? await readFloatAsync().
		This allows to avoid unnecessary promise awaiting.
	 **/
	protected async readFloatAsync()
	{	if (this.packetOffset > 0xFFFFFF-4)
		{	await this.correctNearPacketBoundary();
		}
		await this.recvAtLeast(4);
		const value = this.dataView.getFloat32(this.bufferStart, true);
		this.bufferStart += 4;
		this.packetOffset += 4;
		return value;
	}

	/**	If buffer contains full double, consume it. Else return undefined.
	 **/
	protected readDouble()
	{	if (this.bufferEnd-this.bufferStart >= 8 && this.packetOffset <= 0xFFFFFF-8)
		{	debugAssert(this.payloadLength-this.packetOffset >= 8);
			const value = this.dataView.getFloat64(this.bufferStart, true);
			this.bufferStart += 8;
			this.packetOffset += 8;
			return value;
		}
	}

	/**	To read a IEEE 754 32-bit double-precision, do: readDouble() ?? await readDoubleAsync().
		This allows to avoid unnecessary promise awaiting.
	 **/
	protected async readDoubleAsync()
	{	if (this.packetOffset > 0xFFFFFF-8)
		{	await this.correctNearPacketBoundary();
		}
		await this.recvAtLeast(8);
		const value = this.dataView.getFloat64(this.bufferStart, true);
		this.bufferStart += 8;
		this.packetOffset += 8;
		return value;
	}

	/**	If buffer contains full length-encoded integer, consume it. Else return undefined.
		Null value (0xFB) will be returned as -1.
	 **/
	protected readLenencInt()
	{	if (this.bufferEnd > this.bufferStart && this.packetOffset <= 0xFFFFFF-9)
		{	debugAssert(this.payloadLength-this.packetOffset >= 1);
			const desc = this.buffer[this.bufferStart];
			switch (desc)
			{	case 0xFE:
				{	if (this.bufferEnd-this.bufferStart < 9)
					{	return;
					}
					debugAssert(this.payloadLength-this.packetOffset >= 9);
					const value64 = this.dataView.getBigUint64(this.bufferStart+1, true);
					this.bufferStart += 9;
					this.packetOffset += 9;
					return value64<Number.MIN_SAFE_INTEGER || value64>Number.MAX_SAFE_INTEGER ? value64 : Number(value64);
				}
				case 0xFD:
				{	if (this.bufferEnd-this.bufferStart < 4)
					{	return;
					}
					debugAssert(this.payloadLength-this.packetOffset >= 4);
					const value = this.dataView.getUint16(this.bufferStart+1, true) | (this.dataView.getUint8(this.bufferStart+3) << 16);
					this.bufferStart += 4;
					this.packetOffset += 4;
					return value;
				}
				case 0xFC:
				{	if (this.bufferEnd-this.bufferStart < 3)
					{	return;
					}
					debugAssert(this.payloadLength-this.packetOffset >= 3);
					const value = this.dataView.getUint16(this.bufferStart+1, true);
					this.bufferStart += 3;
					this.packetOffset += 3;
					return value;
				}
				case 0xFB:
				{	this.packetOffset++;
					this.bufferStart++;
					return -1;
				}
				default:
				{	this.packetOffset++;
					this.bufferStart++
					return desc;
				}
			}
		}
	}

	/**	To read a length-encoded integer, do: readLenencInt() ?? await readLenencIntAsync().
		This allows to avoid unnecessary promise awaiting.
		Null value (0xFB) will be returned as -1.
	 **/
	protected async readLenencIntAsync()
	{	if (this.packetOffset > 0xFFFFFF-9)
		{	await this.correctNearPacketBoundary();
		}
		if (this.bufferEnd == this.bufferStart)
		{	await this.recvAtLeast(1);
		}
		const desc = this.buffer[this.bufferStart];
		switch (desc)
		{	case 0xFE:
			{	debugAssert(this.payloadLength-this.packetOffset >= 9);
				await this.recvAtLeast(9);
				const value64 = this.dataView.getBigUint64(this.bufferStart+1, true);
				this.bufferStart += 9;
				this.packetOffset += 9;
				return value64<Number.MIN_SAFE_INTEGER || value64>Number.MAX_SAFE_INTEGER ? value64 : Number(value64);
			}
			case 0xFD:
			{	debugAssert(this.payloadLength-this.packetOffset >= 4);
				await this.recvAtLeast(4);
				const value = this.dataView.getUint16(this.bufferStart+1, true) | (this.dataView.getUint8(this.bufferStart+3) << 16);
				this.bufferStart += 4;
				this.packetOffset += 4;
				return value;
			}
			case 0xFC:
			{	debugAssert(this.payloadLength-this.packetOffset >= 3);
				await this.recvAtLeast(3);
				const value = this.dataView.getUint16(this.bufferStart+1, true);
				this.bufferStart += 3;
				this.packetOffset += 3;
				return value;
			}
			case 0xFB:
			{	this.packetOffset++;
				this.bufferStart++;
				return -1;
			}
			default:
			{	this.packetOffset++;
				this.bufferStart++;
				return desc;
			}
		}
	}


	// --- 4. Reading bytes

	/**	If buffer contains len bytes, consume them. Else return undefined.
		Returns pointer to buffer. If you want to use these data after next read operation, you need to copy them.
	 **/
	protected readShortBytes(len: number)
	{	if (len > this.buffer.length-4) // minus 4 byte header
		{	throw new Error(`String is too long for this operation. Longer than ${this.buffer.length-4} bytes`);
		}
		const haveBytes = this.bufferEnd - this.bufferStart;
		if (haveBytes >= len)
		{	const lenInCurPacket = this.payloadLength - this.packetOffset;
			if (lenInCurPacket >= len)
			{	this.bufferStart += len;
				this.packetOffset += len;
				return this.buffer.subarray(this.bufferStart-len, this.bufferStart);
			}
			else if (haveBytes >= len+4) // across packet boundary: count 4-byte header
			{	const value = new Uint8Array(len);
				value.set(this.buffer.subarray(this.bufferStart, this.bufferStart+lenInCurPacket));
				this.bufferStart += lenInCurPacket;
				len -= lenInCurPacket;
				this.readPacketHeader();
				value.set(this.buffer.subarray(this.bufferStart, this.bufferStart+len), lenInCurPacket);
				this.bufferStart += len;
				debugAssert(this.bufferStart <= this.bufferEnd);
				return value;
			}
		}
	}

	/**	To read len bytes, where len<=buffer.length-4, do: readShortBytes() ?? await readShortBytesAsync().
		This allows to avoid unnecessary promise awaiting.
		Returns pointer to buffer. If you want to use these data after next read operation, you need to copy them.
	 **/
	protected async readShortBytesAsync(len: number)
	{	debugAssert(len <= this.buffer.length-4); // use readShortBytes() first
		const lenInCurPacket = this.payloadLength - this.packetOffset;
		if (lenInCurPacket >= len)
		{	await this.recvAtLeast(len);
			this.bufferStart += len;
			this.packetOffset += len;
			return this.buffer.subarray(this.bufferStart-len, this.bufferStart);
		}
		else
		{	await this.recvAtLeast(lenInCurPacket + 4);
			const value = new Uint8Array(len);
			value.set(this.buffer.subarray(this.bufferStart, this.bufferStart+lenInCurPacket));
			this.bufferStart += lenInCurPacket;
			len -= lenInCurPacket;
			this.readPacketHeader();
			await this.recvAtLeast(len);
			value.set(this.buffer.subarray(this.bufferStart, this.bufferStart+len), lenInCurPacket);
			this.bufferStart += len;
			debugAssert(this.bufferStart <= this.bufferEnd);
			return value;
		}
	}

	/**	If buffer contains full null-terminated blob, consume it. Else return undefined.
		Returns pointer to buffer. If you want to use these data after next read operation, you need to copy them.
	 **/
	protected readShortNulBytes()
	{	const i = this.buffer.subarray(0, this.bufferEnd).indexOf(0, this.bufferStart);
		if (i != -1)
		{	const value = this.buffer.subarray(this.bufferStart, i);
			this.packetOffset += i - this.bufferStart + 1;
			this.bufferStart = i + 1;
			debugAssert(this.packetOffset <= this.payloadLength); // only call this function where the string is known not to cross packet boundary
			return value;
		}
	}

	/**	To read a null-terminated blob that can fit buffer.length (not across packet boundary), do: readShortNulBytes() ?? await readShortNulBytesAsync().
		This allows to avoid unnecessary promise awaiting.
		If the blob was longer than buffer.length, error is thrown.
		Returns pointer to buffer. If you want to use these data after next read operation, you need to copy them.
	 **/
	protected async readShortNulBytesAsync()
	{	const i = await this.recvToNul();
		const value = this.buffer.subarray(this.bufferStart, i);
		this.packetOffset += i - this.bufferStart + 1;
		this.bufferStart = i + 1;
		debugAssert(this.packetOffset <= this.payloadLength); // only call this function where the string is known not to cross packet boundary
		return value;
	}

	/**	If buffer contains full blob with length-encoded length, consume it. Else return undefined.
		Null value (0xFB) will be returned as empty buffer.
	 **/
	protected readShortLenencBytes()
	{	if (this.bufferEnd > this.bufferStart && this.packetOffset <= 0xFFFFFF-9)
		{	debugAssert(this.payloadLength-this.packetOffset >= 1);
			let strLen = -1;
			let allLen = -1;
			switch (this.buffer[this.bufferStart])
			{	case 0xFE:
				{	if (this.bufferEnd-this.bufferStart < 9)
					{	return;
					}
					debugAssert(this.payloadLength-this.packetOffset >= 9);
					const value = this.dataView.getBigUint64(this.bufferStart+1, true);
					if (value <= this.buffer.length)
					{	strLen = Number(value);
						allLen = strLen + 9;
					}
					break;
				}
				case 0xFD:
				{	if (this.bufferEnd-this.bufferStart < 4)
					{	return;
					}
					debugAssert(this.payloadLength-this.packetOffset >= 4);
					strLen = this.dataView.getUint16(this.bufferStart+1, true) | (this.dataView.getUint8(this.bufferStart+3) << 16);
					allLen = strLen + 4;
					break;
				}
				case 0xFC:
				{	if (this.bufferEnd-this.bufferStart < 3)
					{	return;
					}
					debugAssert(this.payloadLength-this.packetOffset >= 3);
					strLen = this.dataView.getUint16(this.bufferStart+1, true);
					allLen = strLen + 3;
					break;
				}
				case 0xFB:
				{	this.packetOffset++;
					this.bufferStart++;
					return new Uint8Array;
				}
				default:
				{	strLen = this.buffer[this.bufferStart];
					allLen = strLen + 1;
				}
			}
			if (strLen != -1)
			{	const haveBytes = this.bufferEnd - this.bufferStart;
				if (haveBytes >= allLen)
				{	const lenInCurPacket = this.payloadLength - this.packetOffset;
					if (lenInCurPacket >= allLen)
					{	this.bufferStart += allLen;
						this.packetOffset += allLen;
						return this.buffer.subarray(this.bufferStart-strLen, this.bufferStart);
					}
					else if (haveBytes >= allLen+4) // across packet boundary: count 4-byte header
					{	const value = new Uint8Array(strLen);
						const numLen = allLen - strLen;
						value.set(this.buffer.subarray(this.bufferStart+numLen, this.bufferStart+lenInCurPacket));
						this.bufferStart += lenInCurPacket;
						strLen -= lenInCurPacket - numLen;
						this.readPacketHeader();
						value.set(this.buffer.subarray(this.bufferStart, this.bufferStart+strLen), lenInCurPacket-numLen);
						this.bufferStart += strLen;
						debugAssert(this.bufferStart <= this.bufferEnd);
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
	protected async readShortLenencBytesAsync()
	{	const len = this.readLenencInt() ?? await this.readLenencIntAsync();
		if (len > this.buffer.length-4)
		{	throw new Error(`String is too long for this operation. Longer than ${this.buffer.length-4} bytes`);
		}
		const n = Number(len);
		if (n <= -1)
		{	return new Uint8Array; // null
		}
		return this.readShortBytes(n) ?? await this.readShortBytesAsync(n);
	}

	/**	If buffer contains full packet, consume it. Else return undefined.
		Returns pointer to buffer. If you want to use these data after next read operation, you need to copy them.
	 **/
	protected readShortEofBytes()
	{	const len = this.payloadLength - this.packetOffset;
		if (this.bufferEnd-this.bufferStart >= len)
		{	this.bufferStart += len;
			this.packetOffset += len;
			let bytes = this.buffer.subarray(this.bufferStart-len, this.bufferStart);
			if (bytes[bytes.length - 1] == 0)
			{	bytes = bytes.subarray(0, -1);
			}
			return bytes;
		}
	}

	/**	To read a blob that can fit buffer.length to end of packet, do: readShortEofBytes() ?? await readShortEofBytesAsync().
		This allows to avoid unnecessary promise awaiting.
		Returns pointer to buffer. If you want to use these data after next read operation, you need to copy them.
	 **/
	protected async readShortEofBytesAsync()
	{	const len = this.payloadLength - this.packetOffset;
		debugAssert(this.bufferEnd-this.bufferStart < len); // use readShortEofBytes() first
		await this.recvAtLeast(len);
		this.bufferStart += len;
		this.packetOffset += len;
		let bytes = this.buffer.subarray(this.bufferStart-len, this.bufferStart);
		if (bytes[bytes.length - 1] == 0)
		{	bytes = bytes.subarray(0, -1);
		}
		return bytes;
	}

	/**	Copies bytes to provided buffer.
	 **/
	protected async readBytesToBuffer(dest: Uint8Array)
	{	let pos = 0;
		while (pos < dest.length)
		{	let lenInCurPacket = this.payloadLength - this.packetOffset;
			if (lenInCurPacket == 0)
			{	this.readPacketHeader() || await this.readPacketHeaderAsync();
				lenInCurPacket = this.payloadLength - this.packetOffset;
			}
			let haveBytes = this.bufferEnd - this.bufferStart;
			while (haveBytes>0 && lenInCurPacket>0 && pos<dest.length)
			{	const len = Math.min(haveBytes, lenInCurPacket, dest.length-pos);
				dest.set(this.buffer.subarray(this.bufferStart, this.bufferStart+len), pos);
				pos += len;
				this.packetOffset += len;
				this.bufferStart += len;
				haveBytes -= len;
				lenInCurPacket -= len;
			}
			while (lenInCurPacket>0 && pos<dest.length)
			{	const n = await this.conn.read(dest.subarray(pos, Math.min(dest.length, pos+lenInCurPacket)));
				if (n == null)
				{	throw new ServerDisconnectedError('Lost connection to server');
				}
				pos += n;
				this.packetOffset += n;
				this.bufferStart = 0;
				this.bufferEnd = 0;
				lenInCurPacket -= n;
			}
		}
	}


	// --- 5. Skip bytes

	/**	If buffer contains len bytes, skip them and return true. Else return false.
	 **/
	protected readVoid(len: number)
	{	if (this.bufferEnd-this.bufferStart >= len && this.packetOffset <= 0xFFFFFF-len)
		{	this.bufferStart += len;
			this.packetOffset += len;
			return true;
		}
		return false;
	}

	/**	To skip len bytes, do: readVoid() ?? await readVoidAsync().
		This allows to avoid unnecessary promise awaiting.
	 **/
	protected async readVoidAsync(len: number)
	{	while (len > 0)
		{	if (this.packetOffset > 0xFFFFFF-1)
			{	await this.correctNearPacketBoundary();
			}
			let lenInCurPacket = Math.min(len, this.payloadLength-this.packetOffset);
			len -= lenInCurPacket;
			this.packetOffset += lenInCurPacket;
			if (this.bufferEnd > this.bufferStart)
			{	lenInCurPacket -= this.bufferEnd - this.bufferStart;
			}
			while (lenInCurPacket > 0)
			{	const nRead = await this.conn.read(this.buffer);
				if (nRead == null)
				{	throw new ServerDisconnectedError('Lost connection to server');
				}
				lenInCurPacket -= nRead;
				this.bufferEnd = nRead;
			}
			this.bufferStart = this.bufferEnd + lenInCurPacket;
		}
	}


	// --- 6. Reading strings

	/**	If buffer contains full fixed-length string, consume it. Else return undefined.
	 **/
	protected readShortString(len: number)
	{	const bytes = this.readShortBytes(len);
		if (bytes != undefined)
		{	return this.decoder.decode(bytes);
		}
	}

	/**	To read a fixed-length string that can fit buffer.length-4, do: readShortString() ?? await readShortStringAsync().
		This allows to avoid unnecessary promise awaiting.
	 **/
	protected async readShortStringAsync(len: number)
	{	debugAssert(len <= this.buffer.length-4); // use readShortString() first
		const lenInCurPacket = this.payloadLength - this.packetOffset;
		if (lenInCurPacket >= len)
		{	await this.recvAtLeast(len);
			this.bufferStart += len;
			this.packetOffset += len;
			return this.decoder.decode(this.buffer.subarray(this.bufferStart-len, this.bufferStart));
		}
		else
		{	await this.recvAtLeast(lenInCurPacket + 4);
			const value = new Uint8Array(len);
			value.set(this.buffer.subarray(this.bufferStart, this.bufferStart+lenInCurPacket));
			this.bufferStart += lenInCurPacket;
			len -= lenInCurPacket;
			this.readPacketHeader();
			await this.recvAtLeast(len);
			value.set(this.buffer.subarray(this.bufferStart, this.bufferStart+len), lenInCurPacket);
			this.bufferStart += len;
			debugAssert(this.bufferStart <= this.bufferEnd);
			return this.decoder.decode(value);
		}
	}

	/**	If buffer contains full nul-string, consume it. Else return undefined.
	 **/
	protected readShortNulString()
	{	const i = this.buffer.subarray(0, this.bufferEnd).indexOf(0, this.bufferStart);
		if (i != -1)
		{	const value = this.decoder.decode(this.buffer.subarray(this.bufferStart, i));
			this.packetOffset += i - this.bufferStart + 1;
			this.bufferStart = i + 1;
			debugAssert(this.packetOffset <= this.payloadLength); // only call this function where the string is known not to cross packet boundary
			return value;
		}
	}

	/**	To read a nul-string that can fit buffer.length, do: readShortNulString() ?? await readShortNulStringAsync().
		This allows to avoid unnecessary promise awaiting.
		If the string was longer than buffer.length, error is thrown.
	 **/
	protected async readShortNulStringAsync()
	{	const i = await this.recvToNul();
		const value = this.decoder.decode(this.buffer.subarray(this.bufferStart, i));
		this.packetOffset += i - this.bufferStart + 1;
		this.bufferStart = i + 1;
		debugAssert(this.packetOffset <= this.payloadLength); // only call this function where the string is known not to cross packet boundary
		return value;
	}

	/**	If buffer contains full string with length-encoded length, consume it. Else return undefined.
		Null value (0xFB) will be returned as ''.
	 **/
	protected readShortLenencString()
	{	const data = this.readShortLenencBytes();
		if (data != undefined)
		{	return this.decoder.decode(data);
		}
	}

	/**	To read a fixed-length string that can fit buffer.length-4, do: readShortLenencString() ?? await readShortLenencStringAsync().
		This allows to avoid unnecessary promise awaiting.
		Null value (0xFB) will be returned as ''.
	 **/
	protected async readShortLenencStringAsync()
	{	const len = this.readLenencInt() ?? await this.readLenencIntAsync();
		if (len > this.buffer.length-4)
		{	throw new Error(`String is too long for this operation. Longer than ${this.buffer.length-4} bytes`);
		}
		const n = Number(len);
		if (n <= -1)
		{	return ''; // null
		}
		return this.decoder.decode(this.readShortBytes(n) ?? await this.readShortBytesAsync(n));
	}

	/**	If buffer contains full packet, consume it. Else return undefined.
	 **/
	protected readShortEofString()
	{	const len = this.payloadLength - this.packetOffset;
		if (this.bufferEnd-this.bufferStart >= len)
		{	this.bufferStart += len;
			this.packetOffset += len;
			let bytes = this.buffer.subarray(this.bufferStart-len, this.bufferStart);
			if (bytes[bytes.length - 1] == 0)
			{	bytes = bytes.subarray(0, -1);
			}
			return this.decoder.decode(bytes);
		}
	}

	/**	To read a string that can fit buffer.length to end of packet, do: readShortEofString() ?? await readShortEofStringAsync().
		This allows to avoid unnecessary promise awaiting.
	 **/
	protected async readShortEofStringAsync()
	{	const len = this.payloadLength - this.packetOffset;
		debugAssert(this.bufferEnd-this.bufferStart < len); // use readShortEofString() first
		await this.recvAtLeast(len);
		this.bufferStart += len;
		this.packetOffset += len;
		let bytes = this.buffer.subarray(this.bufferStart-len, this.bufferStart);
		if (bytes[bytes.length - 1] == 0)
		{	bytes = bytes.subarray(0, -1);
		}
		return this.decoder.decode(bytes);
	}
}
