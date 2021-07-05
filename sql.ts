import {debug_assert} from './debug_assert.ts';
import {AllowedSqlIdents, DEFAULT_ALLOWED_SQL_IDENTS} from './allowed_sql_idents.ts';

const C_APOS = "'".charCodeAt(0);
const C_QUOT = '"'.charCodeAt(0);
const C_BACKTICK = '`'.charCodeAt(0);
const C_BACKSLASH = '\\'.charCodeAt(0);
const C_SPACE = ' '.charCodeAt(0);
const C_MINUS = '-'.charCodeAt(0);
const C_DOT = '.'.charCodeAt(0);
const C_COLON = ':'.charCodeAt(0);
const C_ZERO = '0'.charCodeAt(0);
const C_ONE = '1'.charCodeAt(0);
const C_TWO = '2'.charCodeAt(0);
const C_THREE = '3'.charCodeAt(0);
const C_NINE = '9'.charCodeAt(0);
const C_X = 'x'.charCodeAt(0);
const C_A_CAP = 'A'.charCodeAt(0);
const C_A = 'a'.charCodeAt(0);
const C_Z_CAP = 'Z'.charCodeAt(0);
const C_Z = 'z'.charCodeAt(0);
const C_DOLLAR = '$'.charCodeAt(0);
const C_UNDERSCORE = '_'.charCodeAt(0);
const C_SEMICOLON = ';'.charCodeAt(0);
const C_COMMA = ','.charCodeAt(0);
const C_AT = '@'.charCodeAt(0);
const C_HASH = '#'.charCodeAt(0);
const C_SLASH = '/'.charCodeAt(0);
const C_TIMES = '*'.charCodeAt(0);
const C_PAREN_OPEN = '('.charCodeAt(0);
const C_PAREN_CLOSE = ')'.charCodeAt(0);
const C_SQUARE_OPEN = '['.charCodeAt(0);
const C_SQUARE_CLOSE = ']'.charCodeAt(0);
const C_BRACE_OPEN = '{'.charCodeAt(0);
const C_BRACE_CLOSE = '}'.charCodeAt(0);

const NUMBER_ALLOC_CHAR_LEN = Math.max((Number.MIN_SAFE_INTEGER+'').length, (Number.MAX_SAFE_INTEGER+'').length, (Number.MAX_VALUE+'').length, (Number.MIN_VALUE+'').length);
const BIGINT_ALLOC_CHAR_LEN = Math.max((0x8000_0000_0000_0000n+'').length, (0x7FFF_FFFF_FFFF_FFFFn+'').length);
const DATE_ALLOC_CHAR_LEN = '2000-01-01 00:00:00.000'.length;

const encoder = new TextEncoder;
const decoder = new TextDecoder;

const enum Want
{	NOTHING,
	CONVERT_QUOT_TO_BACKTICK,
	REMOVE_QUOT,
}

const enum State
{	SQL,
	APOS,
	QUOT,
	BACKTICK,
}

export class Sql
{	allowedSqlIdents: AllowedSqlIdents = DEFAULT_ALLOWED_SQL_IDENTS;
	readonly estimateByteLength: number;

	constructor(private strings: TemplateStringsArray, private params: any[])
	{	let len = 0;
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
		this.estimateByteLength = len;
	}

	/**	If `useBuffer` is provided, and it has enough size, will encode to it, and return a `useBuffer.subarray(0, N)`.
		Else, will return a subarray of a new Uint8Array.
	 **/
	encode(no_backslash_escapes=false, use_buffer?: Uint8Array): Uint8Array
	{	let {strings, params} = this;
		// 1. Allocate the buffer
		let result = use_buffer && use_buffer.length>=this.estimateByteLength ? use_buffer : new Uint8Array(this.estimateByteLength);
		// 2. Append strings (except the last one) and params to the buffer
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
		let want = Want.NOTHING;
		let i_end = strings.length - 1;
		for (let i=0; i<i_end; i++)
		{	let s = strings[i];
			let param = params[i];
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
			if (qt==C_APOS || qt==C_BACKTICK || qt==C_QUOT)
			{	if (strings[i+1].charCodeAt(0) != qt)
				{	throw new Error(`Inappropriately quoted parameter`);
				}
				if (qt != C_APOS)
				{	from = pos;
					// Append param, as is
					append(param+'');
					// Escape chars in param
					let n_add = 0;
					result[from - 1] = C_BACKTICK;
					for (let j=from; j<pos; j++)
					{	if (result[j] == C_BACKTICK)
						{	n_add++;
						}
					}
					if (n_add > 0)
					{	ensure_room(n_add);
						for (let j=pos-1, k=j+n_add; k!=j; k--, j--)
						{	let c = result[j];
							if (c == C_BACKTICK)
							{	result[k--] = C_BACKTICK;
							}
							result[k] = c;
						}
						pos += n_add;
					}
					want = Want.CONVERT_QUOT_TO_BACKTICK;
				}
				else if (param == null)
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
						let low = byte & 0xF;
						result[pos++] = high < 10 ? C_ZERO+high : high-10+C_A_CAP;
						result[pos++] = low < 10 ? C_ZERO+low : low-10+C_A_CAP;
					}
					result[pos++] = C_APOS;
					want = Want.REMOVE_QUOT;
				}
				else
				{	param += '';
					from = pos;
					// Append param, as is
					append(param);
					// Escape chars in param
					let n_add = 0;
					for (let j=from; j<pos; j++)
					{	let c = result[j];
						if (c==C_APOS || c==C_BACKSLASH && !no_backslash_escapes)
						{	n_add++;
						}
					}
					if (n_add > 0)
					{	ensure_room(n_add);
						for (let j=pos-1, k=j+n_add; k!=j; k--, j--)
						{	let c = result[j];
							if (c==C_APOS || c==C_BACKSLASH && !no_backslash_escapes)
							{	result[k--] = c;
							}
							result[k] = c;
						}
						pos += n_add;
					}
					want = Want.NOTHING;
				}
			}
			else
			{	// not quoted (part of SQL)
				from = pos;
				// Append param, as is
				param += '';
				append(param);
				// Escape chars in param
				// find how many bytes to add
				let state = State.SQL;
				let paren_level = 0;
				let changes: {j_from: number, j_to: number}[] = [];
				let n_add = 0;
				for (let j=from; j<pos; j++)
				{	let c = result[j];
					switch (state)
					{	case State.SQL:
							switch (c)
							{	case C_SEMICOLON:
								case C_AT:
								case C_SQUARE_OPEN:
								case C_SQUARE_CLOSE:
								case C_BRACE_OPEN:
								case C_BRACE_CLOSE:
									throw new Error(`Invalid character in SQL fragment: ${param}`);
								case C_HASH:
									throw new Error(`Comment in SQL fragment: ${param}`);
								case C_COMMA:
									if (paren_level == 0)
									{	throw new Error(`Comma in SQL fragment: ${param}`);
									}
									break;
								case C_APOS:
									state = State.APOS;
									break;
								case C_BACKTICK:
									state = State.BACKTICK;
									break;
								case C_QUOT:
									result[j] = C_BACKTICK;
									state = State.QUOT;
									break;
								case C_PAREN_OPEN:
									paren_level++;
									break;
								case C_PAREN_CLOSE:
									if (paren_level-- <= 0)
									{	throw new Error(`Unbalanced parenthesis in SQL fragment: ${param}`);
									}
									break;
								case C_SLASH:
									if (result[j+1] == C_TIMES)
									{	throw new Error(`Comment in SQL fragment: ${param}`);
									}
									break;
								case C_MINUS:
									if (result[j+1] == C_MINUS)
									{	throw new Error(`Comment in SQL fragment: ${param}`);
									}
									break;
								default:
									if (c>=C_A && c<=C_Z || c>=C_A_CAP && c<=C_Z_CAP)
									{	let j_from = j;
										let want_quot = true;
										while (j < pos)
										{	c = result[++j];
											if (c>=C_A && c<=C_Z || c>=C_A_CAP && c<=C_Z_CAP || c==C_UNDERSCORE)
											{	continue;
											}
											if (c>=C_ZERO && c<=C_NINE || c==C_DOLLAR || c>=0x80)
											{	want_quot = false;
												continue;
											}
											break;
										}
										if (want_quot)
										{	if (!this.allowedSqlIdents.isAllowed(result.subarray(j_from, j)))
											{	changes[changes.length] = {j_from: j_from-1, j_to: j-1};
												n_add += 2;
											}
										}
										j--;
									}
							}
							break;
						case State.APOS:
							switch (c)
							{	case C_APOS:
									if (result[j+1] == C_APOS)
									{	j++;
									}
									else
									{	state = State.SQL;
									}
									break;
								case C_BACKSLASH:
									if (!no_backslash_escapes)
									{	changes[changes.length] = {j_from: -1, j_to: j};
										n_add++;
									}
							}
							break;
						case State.BACKTICK:
							switch (c)
							{	case C_BACKTICK:
									if (result[j+1] == C_BACKTICK)
									{	j++;
									}
									else
									{	state = State.SQL;
									}
									break;
							}
							break;
						default:
							debug_assert(state == State.QUOT);
							switch (c)
							{	case C_QUOT:
									if (result[j+1] == C_QUOT)
									{	j++;
										result.copyWithin(j, j+1, pos--); // undouble the quote
									}
									else
									{	result[j] = C_BACKTICK;
										state = State.SQL;
									}
									break;
							}
							break;
					}
				}
				if (paren_level > 0)
				{	throw new Error(`Unbalanced parenthesis in SQL fragment: ${param}`);
				}
				if (state != State.SQL)
				{	throw new Error(`Invalid SQL fragment: ${param}`);
				}
				// add needed bytes
				if (n_add > 0)
				{	ensure_room(n_add);
					let n_change = changes.length;
					var {j_from, j_to} = changes[--n_change];
					for (let j=pos-1, k=j+n_add; true; k--, j--)
					{	let c = result[j];
						if (j == j_to)
						{	if (j_from == -1) // if is backslash
							{	// backslash to double
								debug_assert(c == C_BACKSLASH);
								result[k--] = C_BACKSLASH;
								result[k] = C_BACKSLASH;
							}
							else
							{	// identifier to quote
								result[k--] = C_BACKTICK;
								while (j != j_from)
								{	result[k--] = result[j--];
								}
								result[k] = C_BACKTICK;
								j++; // will k--, j-- on next iter
							}
							if (n_change <= 0)
							{	break;
							}
							var {j_from, j_to} = changes[--n_change];
						}
						else
						{	result[k] = c;
						}
					}
					pos += n_add;
				}
			}
		}
		// 3. Append the last string
		let s = strings[i_end];
		if (want == Want.REMOVE_QUOT)
		{	s = s.slice(1);
		}
		let from = pos;
		append(s);
		if (want == Want.CONVERT_QUOT_TO_BACKTICK)
		{	result[from] = C_BACKTICK;
		}
		// 4. Done
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
	buffer[4] = C_MINUS;
	// month
	buffer[5] = month<10 ? C_ZERO : C_ONE;
	buffer[6] = month<10 ? C_ZERO+month : C_ZERO+month-10;
	// delimiter
	buffer[7] = C_MINUS;
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
