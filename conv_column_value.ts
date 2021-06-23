import {FieldType} from './constants.ts';

const SAFE_INTEGER_LEN = Math.min((Number.MIN_SAFE_INTEGER+'').length, (Number.MAX_SAFE_INTEGER+'').length) - 1;
const C_MINUS = '-'.charCodeAt(0);
const C_ZERO = '0'.charCodeAt(0);
const C_SPACE = ' '.charCodeAt(0);
const C_COLON = ':'.charCodeAt(0);
const C_DOT = '.'.charCodeAt(0);
const C_E = 'e'.charCodeAt(0);
const C_E_CAP = 'E'.charCodeAt(0);

const decoder = new TextDecoder;

export function conv_column_value(value: Uint8Array, type: FieldType)
{	switch (type)
	{	case FieldType.MYSQL_TYPE_NULL:
			return null;

		case FieldType.MYSQL_TYPE_BIT:
			return value[0] != 0;

		case FieldType.MYSQL_TYPE_DECIMAL:
		case FieldType.MYSQL_TYPE_DOUBLE:
		case FieldType.MYSQL_TYPE_FLOAT:
			return data_to_number(value);

		case FieldType.MYSQL_TYPE_LONGLONG:
		{	if (value.length > SAFE_INTEGER_LEN)
			{	let is_negative = value[0] == C_MINUS;
				let i = 0;
				if (is_negative)
				{	i = 1;
				}
				let result = BigInt(value[i++] - C_ZERO);
				for (let i_end=value.length; i<i_end; i++)
				{	result *= 10n;
					result += BigInt(value[i] - C_ZERO);
				}
				if (is_negative)
				{	result = -result;
				}
				if (result<Number.MIN_SAFE_INTEGER || result>Number.MAX_SAFE_INTEGER)
				{	return result;
				}
			}
			// else fallthrough to int
		}

		case FieldType.MYSQL_TYPE_TINY:
		case FieldType.MYSQL_TYPE_SHORT:
		case FieldType.MYSQL_TYPE_LONG:
		case FieldType.MYSQL_TYPE_INT24:
		case FieldType.MYSQL_TYPE_YEAR:
			return data_to_int(value);

		case FieldType.MYSQL_TYPE_JSON:
			return JSON.parse(decoder.decode(value));

		case FieldType.MYSQL_TYPE_TINY_BLOB:
		case FieldType.MYSQL_TYPE_MEDIUM_BLOB:
		case FieldType.MYSQL_TYPE_LONG_BLOB:
			// don't know why, but string values are returned as MYSQL_TYPE_BLOB
			return value.slice();

		case FieldType.MYSQL_TYPE_DATE:
		case FieldType.MYSQL_TYPE_DATETIME:
		case FieldType.MYSQL_TYPE_TIMESTAMP:
		{	let pos = value.indexOf(C_MINUS, 1);
			let year = data_to_int(value.subarray(0, pos));
			pos++;
			let pos2 = value.indexOf(C_MINUS, pos);
			let month = data_to_int(value.subarray(pos, pos2));
			pos = pos2 + 1;
			pos2 = value.indexOf(C_SPACE, pos);
			let day, hour=0, minute=0, second=0, frac=0;
			if (pos2 == -1)
			{	day = data_to_int(value.subarray(pos));
			}
			else
			{	day = data_to_int(value.subarray(pos, pos2));
				pos = pos2 + 1;
				pos2 = value.indexOf(C_COLON, pos);
				hour = data_to_int(value.subarray(pos, pos2));
				pos = pos2 + 1;
				pos2 = value.indexOf(C_COLON, pos);
				if (pos2 == -1)
				{	minute = data_to_int(value.subarray(pos));
				}
				else
				{	minute = data_to_int(value.subarray(pos, pos2));
					pos = pos2 + 1;
					pos2 = value.indexOf(C_DOT, pos);
					if (pos2 == -1)
					{	second = data_to_int(value.subarray(pos));
					}
					else
					{	second = data_to_int(value.subarray(pos, pos2));
						frac = data_to_number(value.subarray(pos2)); // from .
					}
				}
			}
			return new Date(year, month-1, day, hour, minute, second, frac*1000);
		}

		default:
			return decoder.decode(value);
	}
}

function data_to_int(value: Uint8Array)
{	let is_negative = value[0] == C_MINUS;
	let i = 0;
	if (is_negative)
	{	i = 1;
	}
	let result = value[i++] - C_ZERO;
	for (let i_end=value.length; i<i_end; i++)
	{	result *= 10;
		result += value[i] - C_ZERO;
	}
	return is_negative ? -result : result;
}

function data_to_number(value: Uint8Array)
{	let is_negative = value[0] == C_MINUS;
	let i = 0;
	if (is_negative)
	{	i = 1;
	}
	let result = 0;
	let decimal_exponent = 0;
	let decimal_exponent_inc = 0;
	while (i < value.length)
	{	let c = value[i];
		if (c == C_DOT)
		{	decimal_exponent_inc = -1;
		}
		else if (c==C_E || c==C_E_CAP)
		{	decimal_exponent += data_to_int(value.subarray(i+1));
			break;
		}
		else
		{	result *= 10;
			result += value[i] - C_ZERO;
			decimal_exponent += decimal_exponent_inc;
		}
		i++;
	}
	if (decimal_exponent)
	{	result *= 10 ** decimal_exponent;
	}
	return is_negative ? -result : result;
}
