import {debug_assert} from './debug_assert.ts';

const encoder = new TextEncoder;
const decoder = new TextDecoder;

const C_APOS = "'".charCodeAt(0);
const C_QUOT = '"'.charCodeAt(0);
const C_BACKTICK = '`'.charCodeAt(0);
const C_BACKSLASH = '\\'.charCodeAt(0);
const C_SPACE = ' '.charCodeAt(0);
const C_DASH = '-'.charCodeAt(0);
const C_DOT = '.'.charCodeAt(0);
const C_COLON = ':'.charCodeAt(0);
const C_ZERO = '0'.charCodeAt(0);
const C_ONE = '1'.charCodeAt(0);
const C_TWO = '2'.charCodeAt(0);
const C_THREE = '3'.charCodeAt(0);
const C_X = 'x'.charCodeAt(0);
const C_A_CAP = 'A'.charCodeAt(0);

const NUMBER_ALLOC_CHAR_LEN = Math.max((Number.MIN_SAFE_INTEGER+'').length, (Number.MAX_SAFE_INTEGER+'').length, (Number.MAX_VALUE+'').length, (Number.MIN_VALUE+'').length);
const BIGINT_ALLOC_CHAR_LEN = Math.max((0x8000_0000_0000_0000n+'').length, (0x7FFF_FFFF_FFFF_FFFFn+'').length);
const DATE_ALLOC_CHAR_LEN = '2000-01-01 00:00:00.000'.length;

const enum Want
{	NOTHING,
	CONVERT_QUOT_TO_BACKTICK,
	REMOVE_QUOT,
}

export class Sql
{	constructor(private strings: TemplateStringsArray, private params: any[])
	{
	}

	encode(no_backslash_escapes=false): Uint8Array
	{	let {strings, params} = this;
		// Calc size of buffer to allocate, and validate+convert input parameters
		let len = 0;
		for (let s of strings)
		{	len += s.length + 10; // if byte length of s is longer than s.length+10, will realloc later
		}
		for (let i=0, i_end=params.length; i<i_end; i++)
		{	let param = params[i];
			if (param == null)
			{	len += 4; // 'NULL'.length
			}
			else if (typeof(param)=='function' || typeof(param)=='symbol')
			{	len += 4; // 'NULL'.length
				params[i] = null;
			}
			else if (typeof(param) == 'boolean')
			{	len += 5; // 'FALSE'.length
			}
			else if (typeof(param) == 'number')
			{	len += NUMBER_ALLOC_CHAR_LEN;
			}
			else if (typeof(param) == 'bigint')
			{	if (param<-0x8000_0000_0000_0000n || param>0x7FFF_FFFF_FFFF_FFFFn)
				{	throw new Error(`Cannot represent such bigint: ${param}`);
				}
				len += BIGINT_ALLOC_CHAR_LEN;
			}
			else if (typeof(param) == 'string')
			{	len += param.length + 10; // if byte length of param is longer than param.length+10, will realloc later
			}
			else if (param instanceof Date)
			{	len += DATE_ALLOC_CHAR_LEN;
			}
			else if (param.buffer instanceof ArrayBuffer)
			{	len += param.byteLength*2 + 3; // like x'01020304'
			}
			else if (typeof(param.read) == 'function')
			{	throw new Error(`Cannot stringify Deno.Reader`);
			}
			else
			{	param = JSON.stringify(param);
				len += param.length + 10; // if byte length of param is longer than param.length+10, will realloc later
				params[i] = param;
			}
		}
		// Allocate the buffer
		let result = new Uint8Array(len);
		// Append strings (except the last one) and params to the buffer
		function append(s: string)
		{	while (true)
			{	let {read, written} = encoder.encodeInto(s, result.subarray(pos));
				pos += written;
				if (read == s.length)
				{	break;
				}
				s = s.slice(read);
				let tmp = new Uint8Array(Math.max(result.length*2, result.length+s.length+result.length/2));
				tmp.set(result.subarray(0, pos));
				result = tmp;
			}
		}
		function ensure_room(room: number)
		{	if (pos+room > result.length)
			{	let tmp = new Uint8Array(Math.max(result.length*2, result.length+Math.max(room, result.length/2)));
				tmp.set(result.subarray(0, pos));
				result = tmp;
			}
		}
		let pos = 0;
		let n_param = 0;
		let want = Want.NOTHING;
		let i_end = strings.length - 1;
		for (let i=0; i<i_end; i++)
		{	let s = strings[i];
			let param = params[n_param++];
			// Append part of string literal
			if (want == Want.REMOVE_QUOT)
			{	s = s.slice(1);
			}
			let from = pos;
			append(s);
			// Convert '"' -> '`' if needed
			if (want == Want.CONVERT_QUOT_TO_BACKTICK)
			{	result[from] = C_BACKTICK;
			}
			// What kind of quote is using
			let qt = result[pos - 1];
			if (strings[i+1].charCodeAt(0) != qt)
			{	throw new Error(`Inappropriately quoted parameter`);
			}
			// Append param, as is
			if (param == null)
			{	pos--;
				append('NULL');
				want = Want.REMOVE_QUOT;
			}
			else if (param === false)
			{	pos--;
				append('FALSE');
				want = Want.REMOVE_QUOT;
			}
			else if (param === true)
			{	pos--;
				append('TRUE');
				want = Want.REMOVE_QUOT;
			}
			else if (typeof(param) == 'number')
			{	pos--;
				append(param+'');
				want = Want.REMOVE_QUOT;
			}
			else if (typeof(param) == 'bigint')
			{	pos--;
				append(param+'');
				want = Want.REMOVE_QUOT;
			}
			else if (param instanceof Date)
			{	ensure_room(DATE_ALLOC_CHAR_LEN);
				pos += date_encode_into(param, result.subarray(pos));
				want = Want.NOTHING;
			}
			else if (param.buffer instanceof ArrayBuffer)
			{	pos--;
				let param_len = param.byteLength;
				ensure_room(param_len*2 + 3); // like x'01020304'
				result[pos++] = C_X;
				result[pos++] = C_APOS;
				for (let j=0; j<param_len; j++)
				{	let byte = param[j];
					let high = byte >> 4;
					let low = byte & 0xFF;
					result[pos++] = high < 10 ? C_ZERO+high : high-10+C_A_CAP;
					result[pos++] = low < 10 ? C_ZERO+low : low-10+C_A_CAP;
				}
				result[pos++] = C_APOS;
				want = Want.REMOVE_QUOT;
			}
			else
			{	debug_assert(typeof(param) == 'string');
				from = pos;
				append(param);
				// Escape chars in param
				let n_add = 0;
				if (qt == C_APOS)
				{	for (let j=from; j<pos; j++)
					{	switch (result[j])
						{	case C_APOS:
								n_add++;
								break;
							case 0:
							case C_BACKSLASH:
								if (!no_backslash_escapes)
								{	n_add++;
								}
						}
					}
					ensure_room(n_add);
					for (let j=pos-1, k=j+n_add; k!=j; k--, j--)
					{	switch (result[j])
						{	case C_APOS:
								result[k--] = C_APOS;
								result[k] = C_APOS;
								break;
							case 0:
								if (!no_backslash_escapes)
								{	result[k--] = C_ZERO;
									result[k] = C_BACKSLASH;
									break;
								}
								// fall through
							case C_BACKSLASH:
								if (!no_backslash_escapes)
								{	result[k--] = C_BACKSLASH;
									result[k] = C_BACKSLASH;
									break;
								}
								// fall through
							default:
								result[k] = result[j];
						}
					}
					want = Want.NOTHING;
				}
				else if (qt==C_QUOT || qt==C_BACKTICK)
				{	result[from - 1] = C_BACKTICK;
					for (let j=from; j<pos; j++)
					{	switch (result[j])
						{	case C_BACKTICK:
								n_add++;
						}
					}
					ensure_room(n_add);
					for (let j=pos-1, k=j+n_add; k!=j; k--, j--)
					{	switch (result[j])
						{	case C_BACKTICK:
								result[k--] = C_BACKTICK;
								result[k] = C_BACKTICK;
								break;
							default:
								result[k] = result[j];
						}
					}
					want = Want.CONVERT_QUOT_TO_BACKTICK;
				}
				else
				{	throw new Error(`Inappropriately quoted parameter`);
				}
				pos += n_add;
			}
		}
		// Append the last string
		let s = strings[i_end];
		if (want == Want.REMOVE_QUOT)
		{	s = s.slice(1);
		}
		let from = pos;
		append(s);
		if (want == Want.CONVERT_QUOT_TO_BACKTICK)
		{	result[from] = C_BACKTICK;
		}
		// Done
		return result.subarray(0, pos);
	}

	toString(no_backslash_escapes=false)
	{	return decoder.decode(this.encode(no_backslash_escapes));
	}
}

export function sql(strings: TemplateStringsArray, ...params: any[])
{	return new Sql(strings, params);
}

function date_encode_into(date: Date, buffer: Uint8Array)
{	let year = date.getFullYear();
	let month = date.getMonth() + 1;
	let day = date.getDate();
	let hours = date.getHours();
	let minutes = date.getMinutes();
	let seconds = date.getSeconds();
	let millis = date.getMilliseconds();
	// year
	buffer[3] = C_ZERO + year % 10;
	year = Math.floor(year / 10);
	buffer[2] = C_ZERO + year % 10;
	year = Math.floor(year / 10);
	buffer[1] = C_ZERO + year % 10;
	year = Math.floor(year / 10);
	buffer[0] = C_ZERO + year % 10;
	// delimiter
	buffer[4] = C_DASH;
	// month
	buffer[5] = month<10 ? C_ZERO : C_ONE;
	buffer[6] = month<10 ? C_ZERO+month : C_ZERO+month-10;
	// delimiter
	buffer[7] = C_DASH;
	// day
	buffer[8] = day<10 ? C_ZERO : day<20 ? C_ONE : day<30 ? C_TWO : C_THREE;
	buffer[9] = day<10 ? C_ZERO+day : day<20 ? C_ZERO+day-10 : day<30 ? C_ZERO+day-20 : C_ZERO+day-30;
	if (millis+seconds+minutes+hours == 0)
	{	return 10;
	}
	// delimiter
	buffer[10] = C_SPACE;
	// hours
	buffer[11] = hours<10 ? C_ZERO : hours<20 ? C_ONE : C_TWO;
	buffer[12] = hours<10 ? C_ZERO+hours : hours<20 ? C_ZERO+hours-10 : C_ZERO+hours-20;
	// delimiter
	buffer[13] = C_COLON;
	// minutes
	buffer[14] = C_ZERO + Math.floor(minutes / 10);
	buffer[15] = C_ZERO + minutes % 10;
	// delimiter
	buffer[16] = C_COLON;
	// seconds
	buffer[17] = C_ZERO + Math.floor(seconds / 10);
	buffer[18] = C_ZERO + seconds % 10;
	if (millis == 0)
	{	// no millis
		return 19;
	}
	// delimiter
	buffer[19] = C_DOT;
	// millis
	buffer[22] = C_ZERO + millis % 10;
	millis = Math.floor(millis / 10);
	buffer[21] = C_ZERO + millis % 10;
	millis = Math.floor(millis / 10);
	buffer[20] = C_ZERO + millis % 10;
	return 23;
}
