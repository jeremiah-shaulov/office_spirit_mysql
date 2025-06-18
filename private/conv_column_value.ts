import {ColumnFlags, MysqlType} from './constants.ts';
import {type ColumnValue} from './resultsets.ts';

const NONSAFE_INTEGER_MIN_LEN = Math.min((Number.MIN_SAFE_INTEGER+'').length, (Number.MAX_SAFE_INTEGER+'').length) - 1;
const DATE_LEN_NO_MILLIS = 'YYYY-MM-DD HH:MM:SS'.length;
const DATE_LEN_WITH_MILLIS = 'YYYY-MM-DD HH:MM:SS.mmm'.length;
const C_MINUS = '-'.charCodeAt(0);
const C_ZERO = '0'.charCodeAt(0);
const C_ONE = '1'.charCodeAt(0);
const C_TWO = '2'.charCodeAt(0);
const C_THREE = '3'.charCodeAt(0);
const C_FOUR = '4'.charCodeAt(0);
const C_FIVE = '5'.charCodeAt(0);
const C_SPACE = ' '.charCodeAt(0);
const C_COLON = ':'.charCodeAt(0);
const C_DOT = '.'.charCodeAt(0);
const C_E = 'e'.charCodeAt(0);
const C_E_CAP = 'E'.charCodeAt(0);

/**	Convert column value fetched through text protocol.
	All values come stringified, and i need to convert them according to column type.
 **/
export function convColumnValue(value: Uint8Array, type: MysqlType, flags: number, decoder: TextDecoder, jsonAsString: boolean, datesAsString: boolean, isForSerialize: boolean, tz: {getTimezoneMsecOffsetFromSystem: () => number}): ColumnValue
{	switch (type)
	{	case MysqlType.MYSQL_TYPE_NULL:
			return null;

		case MysqlType.MYSQL_TYPE_BIT:
			return value[0] != 0;

		case MysqlType.MYSQL_TYPE_DOUBLE:
		case MysqlType.MYSQL_TYPE_FLOAT:
			return dataToNumber(value);

		// deno-lint-ignore no-fallthrough
		case MysqlType.MYSQL_TYPE_LONGLONG:
		{	if (value.length > NONSAFE_INTEGER_MIN_LEN)
			{	const isNegative = value[0] == C_MINUS;
				let i = 0;
				if (isNegative)
				{	i = 1;
				}
				let result = BigInt(value[i++] - C_ZERO);
				for (const iEnd=value.length; i<iEnd; i++)
				{	result *= 10n;
					result += BigInt(value[i] - C_ZERO);
				}
				if (isNegative)
				{	result = -result;
				}
				if (result<Number.MIN_SAFE_INTEGER || result>Number.MAX_SAFE_INTEGER)
				{	return result;
				}
			}
			// else fallthrough to int
		}

		case MysqlType.MYSQL_TYPE_TINY:
		case MysqlType.MYSQL_TYPE_SHORT:
		case MysqlType.MYSQL_TYPE_LONG:
		case MysqlType.MYSQL_TYPE_INT24:
		case MysqlType.MYSQL_TYPE_YEAR:
			return dataToInt(value);

		case MysqlType.MYSQL_TYPE_JSON:
			return isForSerialize ? value.slice() : jsonAsString ? decoder.decode(value) : JSON.parse(decoder.decode(value));

		case MysqlType.MYSQL_TYPE_DATE:
		case MysqlType.MYSQL_TYPE_DATETIME:
		case MysqlType.MYSQL_TYPE_TIMESTAMP:
			if (datesAsString)
			{	return decoder.decode(value);
			}
			return dataToDate(value, tz.getTimezoneMsecOffsetFromSystem());

		case MysqlType.MYSQL_TYPE_TIME:
			return dataToTime(value);

		default:
			if ((flags & ColumnFlags.BINARY) && type!=MysqlType.MYSQL_TYPE_NEWDECIMAL && type!=MysqlType.MYSQL_TYPE_DECIMAL || isForSerialize)
			{	return value.slice();
			}
			else
			{	return decoder.decode(value);
			}
	}
}

function dataToInt(value: Uint8Array)
{	const isNegative = value[0] == C_MINUS;
	let i = 0;
	if (isNegative)
	{	i = 1;
	}
	let result = value[i++] - C_ZERO;
	for (const iEnd=value.length; i<iEnd; i++)
	{	result *= 10;
		result += value[i] - C_ZERO;
	}
	return isNegative ? -result : result;
}

function dataToNumber(value: Uint8Array)
{	const isNegative = value[0] == C_MINUS;
	let i = 0;
	if (isNegative)
	{	i = 1;
	}
	let result = 0;
	let decimalExponent = 0;
	let decimalExponentInc = 0;
	while (i < value.length)
	{	const c = value[i];
		if (c == C_DOT)
		{	decimalExponentInc = -1;
		}
		else if (c==C_E || c==C_E_CAP)
		{	decimalExponent += dataToInt(value.subarray(i+1));
			break;
		}
		else
		{	result *= 10;
			result += value[i] - C_ZERO;
			decimalExponent += decimalExponentInc;
		}
		i++;
	}
	if (decimalExponent)
	{	result *= 10 ** decimalExponent;
	}
	return isNegative ? -result : result;
}

function dataToTime(value: Uint8Array)
{	const isNegative = value[0] == C_MINUS;
	let i = isNegative ? 1 : 0;
	// hours
	let hours = value[i++] - C_ZERO;
	hours *= 10;
	hours += value[i++] - C_ZERO;
	if (value[i] != C_COLON)
	{	hours *= 10;
		hours += value[i++] - C_ZERO;
	}
	// minutes
	i++; // skip ':'
	let minutes = value[i++] - C_ZERO;
	minutes *= 10;
	minutes += value[i++] - C_ZERO;
	minutes += hours * 60;
	// seconds
	i++; // skip ':'
	let seconds = value[i++] - C_ZERO;
	seconds *= 10;
	seconds += value[i++] - C_ZERO;
	seconds += minutes * 60;
	// frac
	if (value[i] == C_DOT)
	{	let frac = 0;
		let j = value.length - 1;
		// cut trailing zeroes
		for (; j>i; j--)
		{	if (value[j] != C_ZERO)
			{	break;
			}
		}
		// read
		for (; j>i; j--)
		{	frac += value[j] - C_ZERO;
			frac /= 10;
		}
		// add
		seconds += frac;
	}
	// result
	return isNegative ? -seconds : seconds;
}

function dataToDate(value: Uint8Array, timezoneMsecOffsetFromSystem: number)
{	let pos = value.indexOf(C_MINUS, 1);
	const year = dataToInt(value.subarray(0, pos));
	pos++;
	let pos2 = value.indexOf(C_MINUS, pos);
	const month = dataToInt(value.subarray(pos, pos2));
	pos = pos2 + 1;
	pos2 = value.indexOf(C_SPACE, pos);
	let day, hour=0, minute=0, second=0, frac=0;
	if (pos2 == -1)
	{	day = dataToInt(value.subarray(pos));
	}
	else
	{	day = dataToInt(value.subarray(pos, pos2));
		pos = pos2 + 1;
		pos2 = value.indexOf(C_COLON, pos);
		hour = dataToInt(value.subarray(pos, pos2));
		pos = pos2 + 1;
		pos2 = value.indexOf(C_COLON, pos);
		if (pos2 == -1)
		{	minute = dataToInt(value.subarray(pos));
		}
		else
		{	minute = dataToInt(value.subarray(pos, pos2));
			pos = pos2 + 1;
			pos2 = value.indexOf(C_DOT, pos);
			if (pos2 == -1)
			{	second = dataToInt(value.subarray(pos));
			}
			else
			{	second = dataToInt(value.subarray(pos, pos2));
				frac = dataToNumber(value.subarray(pos2)); // from .
			}
		}
	}
	let date = new Date(year, month-1, day, hour, minute, second, frac*1000);
	if (timezoneMsecOffsetFromSystem != 0)
	{	date = new Date(date.getTime() - timezoneMsecOffsetFromSystem);
	}
	return date;
}

export function dateToData(date: Date)
{	let milli = date.getMilliseconds();
	const data = new Uint8Array(milli==0 ? DATE_LEN_NO_MILLIS : DATE_LEN_WITH_MILLIS);

	let year = date.getFullYear();
	data[3] = C_ZERO + year % 10;
	year = Math.trunc(year / 10);
	data[2] = C_ZERO + year % 10;
	year = Math.trunc(year / 10);
	data[1] = C_ZERO + year % 10;
	year = Math.trunc(year / 10);
	data[0] = C_ZERO + year;

	data[4] = C_MINUS;

	const month = date.getMonth() + 1;
	if (month < 10)
	{	data[5] = C_ZERO;
		data[6] = C_ZERO + month;
	}
	else
	{	data[5] = C_ONE;
		data[6] = (C_ZERO - 10) + month;
	}

	data[7] = C_MINUS;

	const day = date.getDate();
	if (day < 10)
	{	data[8] = C_ZERO;
		data[9] = C_ZERO + day;
	}
	else if (day < 20)
	{	data[8] = C_ONE;
		data[9] = (C_ZERO - 10) + day;
	}
	else if (day < 30)
	{	data[8] = C_TWO;
		data[9] = (C_ZERO - 20) + day;
	}
	else
	{	data[8] = C_THREE;
		data[9] = (C_ZERO - 30) + day;
	}

	data[10] = C_SPACE;

	const hour = date.getHours();
	if (hour < 10)
	{	data[11] = C_ZERO;
		data[12] = C_ZERO + hour;
	}
	else if (hour < 20)
	{	data[11] = C_ONE;
		data[12] = (C_ZERO - 10) + hour;
	}
	else
	{	data[11] = C_TWO;
		data[12] = (C_ZERO - 20) + hour;
	}

	data[13] = C_COLON;

	const minute = date.getMinutes();
	if (minute < 10)
	{	data[14] = C_ZERO;
		data[15] = C_ZERO + minute;
	}
	else if (minute < 20)
	{	data[14] = C_ONE;
		data[15] = (C_ZERO - 10) + minute;
	}
	else if (minute < 30)
	{	data[14] = C_TWO;
		data[15] = (C_ZERO - 20) + minute;
	}
	else if (minute < 40)
	{	data[14] = C_THREE;
		data[15] = (C_ZERO - 30) + minute;
	}
	else if (minute < 50)
	{	data[14] = C_FOUR;
		data[15] = (C_ZERO - 40) + minute;
	}
	else
	{	data[14] = C_FIVE;
		data[15] = (C_ZERO - 50) + minute;
	}

	data[16] = C_COLON;

	const second = date.getSeconds();
	if (second < 10)
	{	data[17] = C_ZERO;
		data[18] = C_ZERO + second;
	}
	else if (second < 20)
	{	data[17] = C_ONE;
		data[18] = (C_ZERO - 10) + second;
	}
	else if (second < 30)
	{	data[17] = C_TWO;
		data[18] = (C_ZERO - 20) + second;
	}
	else if (second < 40)
	{	data[17] = C_THREE;
		data[18] = (C_ZERO - 30) + second;
	}
	else if (second < 50)
	{	data[17] = C_FOUR;
		data[18] = (C_ZERO - 40) + second;
	}
	else
	{	data[17] = C_FIVE;
		data[18] = (C_ZERO - 50) + second;
	}

	if (milli != 0)
	{	data[19] = C_DOT;

		data[22] = C_ZERO + milli % 10;
		milli = Math.trunc(milli / 10);
		data[21] = C_ZERO + milli % 10;
		milli = Math.trunc(milli / 10);
		data[20] = C_ZERO + milli;
	}

	return data;
}
