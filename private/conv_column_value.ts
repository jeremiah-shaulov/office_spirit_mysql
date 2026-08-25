import {Charset, MysqlType} from './constants.ts';
import type {ColumnValue} from './resultsets.ts';

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
const C_PLUS = '+'.charCodeAt(0);
const C_E = 'e'.charCodeAt(0);
const C_E_CAP = 'E'.charCodeAt(0);

/**	Powers of 10 that fit in the double mantissa, so they're represented exactly (10**22 is the last such power).
 **/
const POW10 = [1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22];

const POW10_BIG = [1n, 10n, 100n, 1000n, 10000n, 100000n, 1000000n, 10000000n, 100000000n, 1000000000n, 10000000000n, 100000000000n, 1000000000000n, 10000000000000n, 100000000000000n, 1000000000000000n];

/**	Convert column value fetched through text protocol.
	All values come stringified, and i need to convert them according to column type.
 **/
export function convColumnValue(value: Uint8Array, type: MysqlType, charsetId: Charset, decoder: TextDecoder, jsonAsString: boolean, datesAsString: boolean, isForSerialize: boolean, tz: {getTimezoneMsecOffsetFromSystem: () => number}): ColumnValue
{	switch (type)
	{	case MysqlType.MYSQL_TYPE_NULL:
			return null;

		case MysqlType.MYSQL_TYPE_BIT:
		{	// BIT(N) is stored in ceil(N/8) bytes (big-endian), so any non-zero byte means truthy.
			for (let i=0, iEnd=value.length; i<iEnd; i++)
			{	if (value[i] != 0)
				{	return true;
				}
			}
			return false;
		}

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
			if (charsetId==Charset.BINARY && type!=MysqlType.MYSQL_TYPE_NEWDECIMAL && type!=MysqlType.MYSQL_TYPE_DECIMAL || isForSerialize)
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
{	// The value is a stringified number (ASCII), like '6.52' or '1.17e-38'. MySQL sends the shortest decimal string that round-trips (up to 17 significant digits).
	// Naive digit accumulation with one `result *= 10**exponent` at the end is not correctly rounded, and underflows to 0 for tiny values, so:
	// - If the mantissa fits in 15 digits (exact integer double), and the power of 10 is also exact (10**±22 at most), one multiplication or division is correctly rounded by IEEE-754 - this covers typical values without allocations.
	// - Otherwise compute the exact result through BigInt arithmetic (`dataToNumberSlow`).
	const len = value.length;
	const isNegative = value[0] == C_MINUS;
	let i = isNegative || value[0]==C_PLUS ? 1 : 0;
	const numberStart = i;
	let mantissa = 0; // integer composed of the first at most 15 significant digits, so it's exact
	let nDigits = 0; // how many digits are accumulated to `mantissa` (not counting leading zeroes)
	let exponent = 0; // the value is mantissa * 10**exponent (only accurate while `isExact`)
	let explicitExponent = 0; // the number after 'e', if any
	let mantissaEnd = len; // position of 'e', if any
	let isExact = true; // false if a nonzero digit was dropped, because it didn't fit in `mantissa`
	let isAfterDot = false;
	let hasDigits = false;
	for (; i<len; i++)
	{	const c = value[i];
		if (c == C_DOT)
		{	isAfterDot = true;
		}
		else if (c==C_E || c==C_E_CAP)
		{	mantissaEnd = i++;
			const c2 = value[i];
			const isNegativeExponent = c2 == C_MINUS;
			if (isNegativeExponent || c2==C_PLUS)
			{	i++;
			}
			for (; i<len; i++)
			{	explicitExponent *= 10;
				explicitExponent += value[i] - C_ZERO;
			}
			if (isNegativeExponent)
			{	explicitExponent = -explicitExponent;
			}
			exponent += explicitExponent;
			break;
		}
		else
		{	hasDigits = true;
			if (nDigits < 15)
			{	if (mantissa==0 && c==C_ZERO)
				{	if (isAfterDot)
					{	exponent--; // leading zero after the dot, like in '0.0001'
					}
				}
				else
				{	mantissa *= 10;
					mantissa += c - C_ZERO;
					nDigits++;
					if (isAfterDot)
					{	exponent--;
					}
				}
			}
			else
			{	if (!isAfterDot)
				{	exponent++; // the dropped digit scales the mantissa
				}
				if (c != C_ZERO)
				{	isExact = false;
				}
			}
		}
	}
	if (!hasDigits)
	{	return NaN;
	}
	if (isExact)
	{	if (exponent>=-22 && exponent<=22)
		{	const result = exponent>=0 ? mantissa*POW10[exponent] : mantissa/POW10[-exponent];
			return isNegative ? -result : result;
		}
		if (exponent>22 && exponent-22 <= 15-nDigits)
		{	// mantissa * 10**(exponent-22) is still an exact integer double, and 10**22 is exact
			const result = mantissa * POW10[exponent-22] * POW10[22];
			return isNegative ? -result : result;
		}
		if (mantissa == 0)
		{	return isNegative ? -0 : 0;
		}
	}
	const result = dataToNumberSlow(value, numberStart, mantissaEnd, explicitExponent);
	return isNegative ? -result : result;
}

/**	Fallback for numbers that cannot be converted exactly with double arithmetic: 16+ significant digits, or decimal exponent outside -22 .. 22.
	Uses exact BigInt arithmetic to produce the correctly rounded (to nearest, ties to even) double, like the native parser does.
	`i` .. `iEnd` is the span of the digits (`iEnd` is the position of 'e', or the end of the string), and `exponent` is the explicitly given exponent (the number after 'e').
 **/
function dataToNumberSlow(value: Uint8Array, i: number, iEnd: number, exponent: number)
{	// Read all the digits, so the value is mantissa * 10**exponent
	let mantissa = 0n;
	let chunk = 0;
	let chunkLen = 0;
	let isAfterDot = false;
	for (; i<iEnd; i++)
	{	const c = value[i];
		if (c == C_DOT)
		{	isAfterDot = true;
		}
		else
		{	chunk *= 10;
			chunk += c - C_ZERO;
			if (isAfterDot)
			{	exponent--;
			}
			if (++chunkLen == 15)
			{	mantissa = mantissa*POW10_BIG[15] + BigInt(chunk);
				chunk = 0;
				chunkLen = 0;
			}
		}
	}
	if (chunkLen > 0)
	{	mantissa = mantissa*POW10_BIG[chunkLen] + BigInt(chunk);
	}
	if (mantissa == 0n)
	{	return 0;
	}
	if (exponent >= 0)
	{	return Number(mantissa * 10n**BigInt(exponent)); // Number(bigint) is correctly rounded per the spec
	}
	// The value is mantissa/den
	const den = 10n ** BigInt(-exponent);
	// Find the binary exponent of the value: 2**binExponent <= mantissa/den < 2**(binExponent+1)
	let binExponent = bitLength(mantissa) - bitLength(den);
	if (binExponent>=0 ? mantissa < den<<BigInt(binExponent) : mantissa<<BigInt(-binExponent) < den)
	{	binExponent--;
	}
	// How many mantissa bits the result can have: 53 for normal doubles, fewer for subnormals (the smallest representable bit is 2**-1074)
	const precision = binExponent>=-1022 ? 53 : binExponent+1075;
	// Scale the fraction so that its integer part gets precision+1 bits: the extra bit and the remainder decide the rounding
	const shift = precision - binExponent;
	let num = mantissa;
	let scaledDen = den;
	if (shift >= 0)
	{	num <<= BigInt(shift);
	}
	else
	{	scaledDen <<= BigInt(-shift);
	}
	let intPart = num / scaledDen;
	const roundBit = intPart & 1n;
	intPart >>= 1n;
	if (roundBit && ((intPart & 1n) || num%scaledDen != 0n))
	{	intPart++;
	}
	return Number(intPart) * 2**(binExponent+1-precision);
}

/**	Number of bits in the binary representation of a positive BigInt.
 **/
function bitLength(n: bigint)
{	let nBits = 0;
	while (n >= 0x100000000n)
	{	n >>= 32n;
		nBits += 32;
	}
	return nBits + 32 - Math.clz32(Number(n));
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
