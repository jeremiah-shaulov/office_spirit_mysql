import {Column, type ColumnValue} from './resultsets.ts';
import {ColumnFlags, MysqlType} from './constants.ts';
import {MyProtocolReaderWriter} from './my_protocol_reader_writer.ts';
import {RowType} from './my_protocol.ts';
import {debugAssert} from './debug_assert.ts';
import {convColumnValue} from './conv_column_value.ts';

const encoder = new TextEncoder;

// deno-lint-ignore no-explicit-any
type Any = any;

export class MyProtocolReaderWriterSerializer extends MyProtocolReaderWriter
{	constructor(writer: WritableStreamDefaultWriter<Uint8Array>, reader: ReadableStreamBYOBReader, decoder: TextDecoder, useBuffer: Uint8Array|undefined)
	{	super(writer, reader, decoder, useBuffer);
	}

	serializeBegin()
	{	this.startWritingNewPacket();
	}

	/**	Serialize a row, so it can be stored to a file.
		This uses the same format as Mysql binary protocol, so the `deserializeRowBinary()` counterpart method
		can be used for 2 purposes: deserializing the row back into Javascript object, and reading the row from the MySQL server.
	 **/
	async serializeRowBinary(row: ColumnValue[], columns: Column[], datesAsString: boolean, tz: {getTimezoneMsecOffsetFromSystem: () => number})
	{	// 1. Write the null mask
		let nullMask = 0;
		let nullBit = 4; // starts from bit offset 1 << 2, according to protocol definition
		const nRows = row.length;
		for (let i=0; i<nRows; i++)
		{	const value = row[i];
			if (value == null)
			{	nullMask |= nullBit;
			}
			if (nullBit == 0x80)
			{	this.buffer[this.bufferEnd++] = nullMask;
				nullMask = 0;
				nullBit = 1;
			}
			else
			{	nullBit <<= 1;
			}
		}
		if (nullBit != 1)
		{	this.buffer[this.bufferEnd++] = nullMask;
		}
		// 2. Write the row data
		for (let i=0; i<nRows; i++)
		{	const value = row[i];
			if (value != null)
			{	const {typeId, flags} = columns[i];
				switch (typeId)
				{	case MysqlType.MYSQL_TYPE_TINY:
						if (flags & ColumnFlags.UNSIGNED)
						{	this.writeUint8(Number(value));
						}
						else
						{	this.writeInt8(Number(value));
						}
						break;
					case MysqlType.MYSQL_TYPE_SHORT:
					case MysqlType.MYSQL_TYPE_YEAR:
						if (flags & ColumnFlags.UNSIGNED)
						{	this.writeUint16(Number(value));
						}
						else
						{	this.writeInt16(Number(value));
						}
						break;
					case MysqlType.MYSQL_TYPE_INT24:
					case MysqlType.MYSQL_TYPE_LONG:
						if (flags & ColumnFlags.UNSIGNED)
						{	this.writeUint32(Number(value));
						}
						else
						{	this.writeInt32(Number(value));
						}
						break;
					case MysqlType.MYSQL_TYPE_LONGLONG:
						if (flags & ColumnFlags.UNSIGNED)
						{	this.writeUint64(typeof(value)=='bigint' ? value : BigInt(Number(value)));
						}
						else
						{	this.writeInt64(typeof(value)=='bigint' ? value : BigInt(Number(value)));
						}
						break;
					case MysqlType.MYSQL_TYPE_FLOAT:
						this.writeFloat(Number(value));
						break;
					case MysqlType.MYSQL_TYPE_DOUBLE:
						this.writeDouble(Number(value));
						break;
					case MysqlType.MYSQL_TYPE_DATE:
					case MysqlType.MYSQL_TYPE_DATETIME:
					case MysqlType.MYSQL_TYPE_TIMESTAMP:
					{	let year = 0;
						let month = 0;
						let day = 0;
						let hour = 0;
						let minute = 0;
						let second = 0;
						let micro = 0;
						if (!datesAsString)
						{	let date = value instanceof Date ? value : new Date(0);
							const timezoneMsecOffsetFromSystem = tz.getTimezoneMsecOffsetFromSystem();
							if (timezoneMsecOffsetFromSystem != 0)
							{	date = new Date(date.getTime() + timezoneMsecOffsetFromSystem);
							}
							if (date.getTime() != 0)
							{	year = date.getFullYear();
								month = date.getMonth() + 1;
								day = date.getDate();
								hour = date.getHours();
								minute = date.getMinutes();
								second = date.getSeconds();
								micro = date.getMilliseconds() * 1000;
							}
						}
						else
						{	const str = value+'';
							year = parseInt(str.slice(0, 4));
							month = parseInt(str.slice(5, 7));
							day = parseInt(str.slice(8, 10));
							if (str.length > 11)
							{	hour = parseInt(str.slice(11, 13));
								minute = parseInt(str.slice(14, 16));
								second = parseInt(str.slice(17, 19));
								if (str.length > 20)
								{	micro = parseInt(str.slice(20));
								}
							}
						}
						this.writeUint8(micro!=0 ? 11 : hour+minute+second!=0 ? 7 : year+month+day!=0 ? 4 : 0);
						if (year+month+day != 0)
						{	this.writeUint16(year);
							this.writeUint8(month);
							this.writeUint8(day);
							if (hour+minute+second+micro != 0)
							{	this.writeUint8(hour);
								this.writeUint8(minute);
								this.writeUint8(second);
								if (micro != 0)
								{	this.writeUint32(micro);
								}
							}
						}
						break;
					}
					case MysqlType.MYSQL_TYPE_TIME:
					{	let num = Number(value);
						if (num == 0)
						{	this.writeUint8(0);
						}
						else
						{	const isNegative = num < 0;
							if (isNegative)
							{	num = -num;
							}
							const micro = Math.trunc(num * 1_000_000) % 1_000_000;
							num = Math.trunc(num);
							const seconds = num % 60;
							num = Math.trunc(num / 60);
							const minutes = num % 60;
							num = Math.trunc(num / 60);
							const hours = num % 24;
							const days = Math.trunc(num / 24);
							this.writeUint8(micro!=0 ? 12 : hours+minutes+seconds+days!=0 ? 8 : 0);
							if (hours+minutes+seconds+days != 0)
							{	this.writeUint8(isNegative ? 1 : 0);
								this.writeUint32(days);
								this.writeUint8(hours);
								this.writeUint8(minutes);
								this.writeUint8(seconds);
								if (micro != 0)
								{	this.writeUint32(micro);
								}
							}
						}
						break;
					}
					case MysqlType.MYSQL_TYPE_BIT:
						this.writeUint16(Number(value) ? 257 : 256);
						break;
					default:
					{	const v = value instanceof Uint8Array ? value : typeof(value)=='string' ? encoder.encode(value) : this.buffer.subarray(0, 0);
						this.writeLenencInt(v.length);
						if (this.bufferEnd+v.length <= this.buffer.length)
						{	this.buffer.set(v, this.bufferEnd);
							this.bufferEnd += v.length;
						}
						else if (i < nRows-1)
						{	this.ensureRoom(v.length);
							this.buffer.set(v, this.bufferEnd);
							this.bufferEnd += v.length;
						}
						else
						{	await this.sendWithData(v, false);
							this.startWritingNewPacket();
						}
					}
				}
			}
		}
		// 3. Maybe flush
		if (this.bufferEnd-4 >= this.buffer.length/2)
		{	await this.send();
			this.startWritingNewPacket();
		}
	}

	/**	Call this method after you serialized all rows.
	 **/
	async serializeEnd()
	{	if (this.bufferEnd > 4)
		{	await this.send();
		}
		else
		{	this.bufferStart = 0;
			this.bufferEnd = 0;
		}
	}

	/**	Reads a row from the MySQL server, or from another readable stream (like file), and deserializes it into a Javascript object.
		It deals with the MySQL binary protocol.
	 **/
	async deserializeRowBinary(rowType: RowType, columns: Column[], datesAsString: boolean, tz: {getTimezoneMsecOffsetFromSystem: () => number}, maxColumnLen: number, noJsonParse=false)
	{	let row: Any;
		switch (rowType)
		{	case RowType.OBJECT:
			case RowType.LAST_COLUMN_READER:
			case RowType.LAST_COLUMN_READABLE:
				row = {};
				break;
			case RowType.MAP:
				row = new Map;
				break;
			case RowType.ARRAY:
				row = [];
				break;
			default:
				debugAssert(rowType==RowType.FIRST_COLUMN || rowType==RowType.VOID);
		}
		let buffer: Uint8Array|undefined;
		let lastColumnReaderLen = 0;
		const nColumns = columns.length;
		const nullBitsLen = (nColumns + 2 + 7) >> 3;
		const nullBits = (this.readShortBytes(nullBitsLen) ?? await this.readShortBytesAsync(nullBitsLen)).slice();
		let nullBitsI = 0;
		let nullBitMask = 4; // starts from bit offset 1 << 2, according to protocol definition
		for (let i=0; i<nColumns; i++)
		{	let value: ColumnValue = null;
			const isNull = nullBits[nullBitsI] & nullBitMask;
			if (nullBitMask != 0x80)
			{	nullBitMask <<= 1;
			}
			else
			{	nullBitsI++;
				nullBitMask = 1;
			}
			const {typeId, flags, name} = columns[i];
			if (!isNull)
			{	switch (typeId)
				{	case MysqlType.MYSQL_TYPE_TINY:
						if (flags & ColumnFlags.UNSIGNED)
						{	value = this.readUint8() ?? await this.readUint8Async();
						}
						else
						{	value = this.readInt8() ?? await this.readInt8Async();
						}
						break;
					case MysqlType.MYSQL_TYPE_SHORT:
					case MysqlType.MYSQL_TYPE_YEAR:
						if (flags & ColumnFlags.UNSIGNED)
						{	value = this.readUint16() ?? await this.readUint16Async();
						}
						else
						{	value = this.readInt16() ?? await this.readInt16Async();
						}
						break;
					case MysqlType.MYSQL_TYPE_INT24:
					case MysqlType.MYSQL_TYPE_LONG:
						if (flags & ColumnFlags.UNSIGNED)
						{	value = this.readUint32() ?? await this.readUint32Async();
						}
						else
						{	value = this.readInt32() ?? await this.readInt32Async();
						}
						break;
					case MysqlType.MYSQL_TYPE_LONGLONG:
						if (flags & ColumnFlags.UNSIGNED)
						{	value = this.readUint64() ?? await this.readUint64Async();
							if (value <= Number.MAX_SAFE_INTEGER)
							{	value = Number(value); // as happen in text protocol
							}
						}
						else
						{	value = this.readInt64() ?? await this.readInt64Async();
							if (value>=Number.MIN_SAFE_INTEGER && value<=Number.MAX_SAFE_INTEGER)
							{	value = Number(value); // as happen in text protocol
							}
						}
						break;
					case MysqlType.MYSQL_TYPE_FLOAT:
						value = this.readFloat() ?? await this.readFloatAsync();
						break;
					case MysqlType.MYSQL_TYPE_DOUBLE:
						value = this.readDouble() ?? await this.readDoubleAsync();
						break;
					case MysqlType.MYSQL_TYPE_DATE:
					case MysqlType.MYSQL_TYPE_DATETIME:
					case MysqlType.MYSQL_TYPE_TIMESTAMP:
					{	const len = this.readUint8() ?? await this.readUint8Async();
						if (len >= 4)
						{	const year = this.readUint16() ?? await this.readUint16Async();
							const month = this.readUint8() ?? await this.readUint8Async();
							const day = this.readUint8() ?? await this.readUint8Async();
							let hour=0, minute=0, second=0, micro=0;
							if (len >= 7)
							{	hour = this.readUint8() ?? await this.readUint8Async();
								minute = this.readUint8() ?? await this.readUint8Async();
								second = this.readUint8() ?? await this.readUint8Async();
								if (len >= 11)
								{	micro = this.readUint32() ?? await this.readUint32Async();
								}
							}
							if (!datesAsString)
							{	value = new Date(year, month-1, day, hour, minute, second, micro/1000);
								const timezoneMsecOffsetFromSystem = tz.getTimezoneMsecOffsetFromSystem();
								if (timezoneMsecOffsetFromSystem != 0)
								{	value = new Date(value.getTime() - timezoneMsecOffsetFromSystem);
								}
							}
							else
							{	value = `${year<10 ? '000'+year : year<100 ? '00'+year : year<1000 ? '0'+year : year}-${month<10 ? '0'+month : month}-${day<10 ? '0'+day : day}`;
								if (len >= 7)
								{	value += ` ${hour<10 ? '0'+hour : hour}:${minute<10 ? '0'+minute : minute}:${second<10 ? '0'+second : second}`;
									if (len >= 11)
									{	value += `.${micro<10 ? '00000'+micro : micro<100 ? '0000'+micro : micro<1000 ? '000'+micro : micro<10000 ? '00'+micro : micro<100000 ? '0'+micro : micro}`;
									}
								}
							}
						}
						else
						{	value = datesAsString ? '0000-00-00 00:00:00' : new Date(0);
						}
						break;
					}
					case MysqlType.MYSQL_TYPE_TIME:
					{	const len = this.readUint8() ?? await this.readUint8Async();
						if (len >= 8)
						{	const isNegative = this.readUint8() ?? await this.readUint8Async();
							const days = this.readUint32() ?? await this.readUint32Async();
							let hours = this.readUint8() ?? await this.readUint8Async();
							let minutes = this.readUint8() ?? await this.readUint8Async();
							let seconds = this.readUint8() ?? await this.readUint8Async();
							hours += days * 24;
							minutes += hours * 60;
							seconds += minutes * 60;
							if (len >= 12)
							{	const micro = this.readUint32() ?? await this.readUint32Async();
								seconds += micro / 1_000_000;
							}
							value = isNegative ? -seconds : seconds;
						}
						else
						{	value = 0;
						}
						break;
					}
					case MysqlType.MYSQL_TYPE_BIT:
					{	// MySQL sends bit value as blob with length=1
						value = (this.readUint16() ?? await this.readUint16Async()) == 257;
						break;
					}
					default:
					{	let len = this.readLenencInt() ?? await this.readLenencIntAsync();
						if (len > Number.MAX_SAFE_INTEGER)
						{	throw new Error(`Field is too long: ${len} bytes`);
						}
						len = Number(len);
						if ((rowType==RowType.LAST_COLUMN_READER || rowType==RowType.LAST_COLUMN_READABLE) && i+1==nColumns)
						{	lastColumnReaderLen = len;
						}
						else if (len>maxColumnLen || rowType==RowType.VOID)
						{	this.readVoid(len) || await this.readVoidAsync(len);
						}
						else if ((flags & ColumnFlags.BINARY) && (typeId!=MysqlType.MYSQL_TYPE_JSON || noJsonParse))
						{	value = await this.readBytesToBuffer(new Uint8Array(len));
						}
						else
						{	if (len <= this.buffer.length)
							{	value = this.readShortString(len) ?? await this.readShortStringAsync(len);
							}
							else
							{	if (!buffer || buffer.length<len)
								{	buffer = new Uint8Array(len);
								}
								const v = await this.readBytesToBuffer(buffer.subarray(0, len));
								buffer = new Uint8Array(v.buffer);
								value = this.decoder.decode(v);
							}
							if (typeId == MysqlType.MYSQL_TYPE_JSON)
							{	value = JSON.parse(value);
							}
						}
					}
				}
			}
			switch (rowType)
			{	case RowType.OBJECT:
				case RowType.LAST_COLUMN_READER:
				case RowType.LAST_COLUMN_READABLE:
					row[name] = value;
					break;
				case RowType.MAP:
					row.set(name, value);
					break;
				case RowType.ARRAY:
					row[i] = value;
					break;
				case RowType.FIRST_COLUMN:
					if (i == 0)
					{	row = value;
					}
					break;
				default:
					debugAssert(rowType == RowType.VOID);
			}
		}
		return {row, lastColumnReaderLen};
	}

	/**	Reads a row from the MySQL server when using text protocol, and deserializes it into a Javascript object.
	 **/
	async deserializeRowText(rowType: RowType, columns: Column[], datesAsString: boolean, tz: {getTimezoneMsecOffsetFromSystem: () => number}, maxColumnLen: number, noJsonParse=false)
	{	let row: Any;
		switch (rowType)
		{	case RowType.OBJECT:
			case RowType.LAST_COLUMN_READER:
			case RowType.LAST_COLUMN_READABLE:
				row = {};
				break;
			case RowType.MAP:
				row = new Map;
				break;
			case RowType.ARRAY:
				row = [];
				break;
			default:
				debugAssert(rowType==RowType.FIRST_COLUMN || rowType==RowType.VOID);
		}
		let buffer: Uint8Array|undefined;
		let lastColumnReaderLen = 0;
		const nColumns = columns.length;
		for (let i=0; i<nColumns; i++)
		{	const {typeId, flags, name} = columns[i];
			let len = this.readLenencInt() ?? await this.readLenencIntAsync();
			if (len > Number.MAX_SAFE_INTEGER)
			{	throw new Error(`Field is too long: ${len} bytes`);
			}
			len = Number(len);
			let value: ColumnValue = null;
			if (len != -1) // if not a null value
			{	if ((rowType==RowType.LAST_COLUMN_READER || rowType==RowType.LAST_COLUMN_READABLE) && i+1==nColumns)
				{	lastColumnReaderLen = len;
				}
				else if (len>maxColumnLen || rowType==RowType.VOID)
				{	this.readVoid(len) || await this.readVoidAsync(len);
				}
				else
				{	let v;
					if (len <= this.buffer.length)
					{	v = this.readShortBytes(len) ?? await this.readShortBytesAsync(len);
					}
					else
					{	if (!buffer || buffer.length<len)
						{	buffer = new Uint8Array(len);
						}
						v = await this.readBytesToBuffer(buffer.subarray(0, len));
						buffer = new Uint8Array(v.buffer);
					}
					value = convColumnValue(v, typeId, flags, this.decoder, datesAsString, noJsonParse, tz);
				}
			}
			switch (rowType)
			{	case RowType.OBJECT:
				case RowType.LAST_COLUMN_READER:
				case RowType.LAST_COLUMN_READABLE:
					row[name] = value;
					break;
				case RowType.MAP:
					row.set(name, value);
					break;
				case RowType.ARRAY:
					row[i] = value;
					break;
				case RowType.FIRST_COLUMN:
					if (i == 0)
					{	row = value;
					}
					break;
				default:
					debugAssert(rowType == RowType.VOID);
			}
		}
		return {row, lastColumnReaderLen};
	}
}
