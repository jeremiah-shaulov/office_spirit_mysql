import {debug_assert} from './debug_assert.ts';
import {SqlPolicy} from './sql_policy.ts';
import {utf8_string_length} from "./utf8_string_length.ts";

const C_APOS = "'".charCodeAt(0);
const C_QUOT = '"'.charCodeAt(0);
const C_BACKTICK = '`'.charCodeAt(0);
const C_BACKSLASH = '\\'.charCodeAt(0);
const C_SPACE = ' '.charCodeAt(0);
const C_TAB = '\t'.charCodeAt(0);
const C_CR = '\r'.charCodeAt(0);
const C_LF = '\n'.charCodeAt(0);
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
const C_AMP = '&'.charCodeAt(0);
const C_PIPE = '|'.charCodeAt(0);
const C_EQ = '='.charCodeAt(0);
const C_QUEST = '?'.charCodeAt(0);
const C_PAREN_OPEN = '('.charCodeAt(0);
const C_PAREN_CLOSE = ')'.charCodeAt(0);
const C_SQUARE_OPEN = '['.charCodeAt(0);
const C_SQUARE_CLOSE = ']'.charCodeAt(0);
const C_BRACE_OPEN = '{'.charCodeAt(0);
const C_BRACE_CLOSE = '}'.charCodeAt(0);
const C_LT = '<'.charCodeAt(0);
const C_GT = '>'.charCodeAt(0);

const NUMBER_ALLOC_CHAR_LEN = Math.max((Number.MIN_SAFE_INTEGER+'').length, (Number.MAX_SAFE_INTEGER+'').length, (Number.MAX_VALUE+'').length, (Number.MIN_VALUE+'').length);
const BIGINT_ALLOC_CHAR_LEN = Math.max((0x8000_0000_0000_0000n+'').length, (0x7FFF_FFFF_FFFF_FFFFn+'').length);
const DATE_ALLOC_CHAR_LEN = '2000-01-01 00:00:00.000'.length;

const DEFAULT_SQL_POLICY = new SqlPolicy;

const encoder = new TextEncoder;
const decoder = new TextDecoder;
const decoder_latin1 = new TextDecoder('latin1');

const BUFFER_FOR_DATE = new Uint8Array(23);

const LIT_NULL = encoder.encode('NULL');
const LIT_FALSE = encoder.encode('FALSE');
const LIT_TRUE = encoder.encode('TRUE');
const DELIM_COMMA_BACKTICK = encoder.encode(', `');
const DELIM_AND_BACKTICK = encoder.encode(' AND `');
const DELIM_OR_BACKTICK = encoder.encode(' OR `');
const DELIM_PAREN_CLOSE_VALUES = encoder.encode(') VALUES\n');

const MYSQL_MAX_PLACEHOLDERS = 2**16 - 1;

const enum Want
{	NOTHING,
	REMOVE_APOS_OR_BRACE_CLOSE,
	REMOVE_A_CHAR_AND_BRACE_CLOSE,
	CONVERT_QUOT_TO_BACKTICK,
	CONVERT_CLOSE_TO_PAREN_CLOSE,
	CONVERT_A_CHAR_AND_BRACE_CLOSE_TO_PAREN_CLOSE,
}

const enum State
{	SQL,
	APOS,
	QUOT,
	BACKTICK,
}

const enum Change
{	DOUBLE_BACKSLASH,
	DOUBLE_BACKTICK,
	INSERT_PARENT_NAME,
	QUOTE_COLUMN_NAME,
	QUOTE_IDENT,
}

export class Sql
{	sqlPolicy: SqlPolicy | undefined;
	estimatedByteLength: number;

	constructor(private strings: TemplateStringsArray|string[], private params: any[])
	{	this.strings = strings;
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
			{	let prev_string = strings[i];
				let param_type_descriminator = prev_string.charCodeAt(prev_string.length-1);
				if (param_type_descriminator==C_APOS || param_type_descriminator==C_QUOT || param_type_descriminator==C_BACKTICK)
				{	param = JSON.stringify(param);
					len += param.length + 10; // if byte length of param is longer than param.length+10, will realloc later
					params[i] = param;
				}
				else
				{	len += 30; // just guess
				}
			}
		}
		this.estimatedByteLength = (len | 7) + 1;
	}

	concat(other: Sql)
	{	let strings = [...this.strings];
		strings[strings.length-1] += other.strings[0];
		for (let i=1, i_end=other.strings.length, j=strings.length; i<i_end; i++, j++)
		{	strings[j] = other.strings[i];
		}
		let sql = new Sql([], []);
		sql.strings = strings;
		sql.params = this.params.concat(other.params);
		sql.sqlPolicy = this.sqlPolicy ?? other.sqlPolicy;
		sql.estimatedByteLength = this.estimatedByteLength + other.estimatedByteLength - 10;
		debug_assert(sql.estimatedByteLength >= 10);
		return sql;
	}

	/**	If `useBuffer` is provided, and it has enough size, will encode to it, and return a `useBuffer.subarray(0, N)`.
		Else, will return a subarray of a new Uint8Array.
	 **/
	encode(no_backslash_escapes=false, put_params_to?: any[], use_buffer?: Uint8Array): Uint8Array
	{	let {strings, params} = this;
		// 1. Allocate the buffer
		let serializer = new Serializer(use_buffer && use_buffer.length>=this.estimatedByteLength ? use_buffer : new Uint8Array(this.estimatedByteLength), no_backslash_escapes, put_params_to, this.sqlPolicy);
		// 2. Append strings (except the last one) and params to the buffer
		let want = Want.NOTHING;
		let i_end = strings.length - 1;
		for (let i=0; i<i_end; i++)
		{	// Append part of string literal
			serializer.append_intermediate_sql_part(strings[i], want);
			let param = params[i];
			// What kind of quote is using
			let qt = serializer.get_char(-1);
			if (qt == C_APOS)
			{	if (strings[i+1].charCodeAt(0) != qt)
				{	throw new Error(`Inappropriately quoted parameter`);
				}
				want = serializer.append_sql_value(param);
			}
			else if (qt==C_BACKTICK || qt==C_QUOT)
			{	if (strings[i+1].charCodeAt(0) != qt)
				{	throw new Error(`Inappropriately quoted parameter`);
				}
				serializer.append_quoted_ident(param+'');
				want = Want.CONVERT_QUOT_TO_BACKTICK;
			}
			else if (qt == C_SQUARE_OPEN)
			{	if (strings[i+1].charCodeAt(0) != C_SQUARE_CLOSE)
				{	throw new Error(`Inappropriately enclosed parameter`);
				}
				if (param==null || typeof(param)!='object' || !(Symbol.iterator in param))
				{	throw new Error("In SQL fragment: parameter for [${...}] must be iterable");
				}
				serializer.set_char(-1, C_PAREN_OPEN); // [ -> (
				serializer.append_iterable(param);
				want = Want.CONVERT_CLOSE_TO_PAREN_CLOSE;
			}
			else if (qt == C_LT)
			{	if (strings[i+1].charCodeAt(0) != C_GT)
				{	throw new Error(`Inappropriately enclosed parameter`);
				}
				if (param==null || typeof(param)!='object' || !(Symbol.iterator in param))
				{	throw new Error("In SQL fragment: parameter for <${...}> must be iterable");
				}
				serializer.set_char(-1, C_PAREN_OPEN); // < -> (
				serializer.append_names_values(param);
				want = Want.CONVERT_CLOSE_TO_PAREN_CLOSE;
			}
			else
			{	// SQL fragment
				// Have parent_name?
				let parent_name: Uint8Array | undefined;
				if (qt == C_DOT)
				{	parent_name = serializer.read_parent_name_on_the_left();
					// I'm after '(' or '{'
					qt = serializer.get_char(-1);
				}
				if (qt == C_PAREN_OPEN)
				{	if (strings[i+1].charCodeAt(0) != C_PAREN_CLOSE)
					{	throw new Error(`Inappropriately enclosed parameter`);
					}
					serializer.append_safe_sql_fragment(param+'', parent_name);
					want = Want.NOTHING;
				}
				else if (qt == C_BRACE_OPEN)
				{	let param_type_descriminator = strings[i+1].charCodeAt(0);
					if (param_type_descriminator!=C_BRACE_CLOSE && param_type_descriminator!=C_COMMA && param_type_descriminator!=C_AMP && param_type_descriminator!=C_PIPE)
					{	throw new Error(`Inappropriately enclosed parameter`);
					}
					if (param==null || typeof(param)!='object')
					{	throw new Error("In SQL fragment: parameter for {${...}} must be object");
					}
					let delim = DELIM_COMMA_BACKTICK;
					if (param_type_descriminator==C_BRACE_CLOSE || param_type_descriminator==C_COMMA)
					{	serializer.backspace(); // backspace {
					}
					else
					{	serializer.set_char(-1, C_PAREN_OPEN); // { -> (
						delim = param_type_descriminator==C_AMP ? DELIM_AND_BACKTICK : DELIM_OR_BACKTICK;
					}
					let n_items_added = 0;
					for (let [k, v] of Object.entries(param))
					{	if (n_items_added++ != 0)
						{	serializer.append_raw_bytes(delim);
						}
						else
						{	serializer.append_raw_char(C_BACKTICK);
						}
						if (parent_name)
						{	serializer.append_raw_bytes(parent_name);
							serializer.append_raw_char(C_BACKTICK);
							serializer.append_raw_char(C_DOT);
							serializer.append_raw_char(C_BACKTICK);
						}
						serializer.append_quoted_ident(k);
						serializer.append_raw_char(C_BACKTICK);
						serializer.append_raw_char(C_EQ);
						serializer.append_raw_char(C_APOS);
						if (serializer.append_sql_value(v) != Want.REMOVE_APOS_OR_BRACE_CLOSE)
						{	serializer.append_raw_char(C_APOS);
						}
					}
					if (param_type_descriminator == C_COMMA)
					{	if (n_items_added != 0)
						{	serializer.append_raw_char(C_COMMA);
						}
						want = Want.REMOVE_A_CHAR_AND_BRACE_CLOSE;
					}
					else if (param_type_descriminator == C_BRACE_CLOSE)
					{	if (n_items_added == 0)
						{	throw new Error("In SQL fragment: 0 values for {${...}}");
						}
						want = Want.REMOVE_APOS_OR_BRACE_CLOSE;
					}
					else if (n_items_added == 0)
					{	serializer.backspace();
						serializer.append_raw_bytes(param_type_descriminator==C_AMP ? LIT_TRUE : LIT_FALSE);
						want = Want.REMOVE_A_CHAR_AND_BRACE_CLOSE;
					}
					else
					{	want = Want.CONVERT_A_CHAR_AND_BRACE_CLOSE_TO_PAREN_CLOSE;
					}
				}
				else
				{	throw new Error(`Inappropriately enclosed parameter`);
				}
			}
		}
		// 3. Append the last string
		serializer.append_intermediate_sql_part(strings[i_end], want);
		// 4. Done
		return serializer.get_result();
	}

	toString(no_backslash_escapes=false, put_params_to?: any[])
	{	return decoder.decode(this.encode(no_backslash_escapes, put_params_to));
	}

	static quote(param: any, no_backslash_escapes=false)
	{	if (param == null)
		{	return 'NULL';
		}
		if (param === false)
		{	return 'FALSE';
		}
		if (param === true)
		{	return 'TRUE';
		}
		if (typeof(param)=='number' || typeof(param)=='bigint')
		{	return param+'';
		}
		if (param instanceof Date)
		{	let len = date_encode_into(param, BUFFER_FOR_DATE);
			return decoder_latin1.decode(BUFFER_FOR_DATE.subarray(0, len));
		}
		if (param.buffer instanceof ArrayBuffer)
		{	let param_len = param.byteLength;
			let result = new Uint8Array(param_len*2 + 3);
			result[0] = C_X;
			result[1] = C_APOS;
			let pos = 2;
			for (let j=0; j<param_len; j++)
			{	let byte = param[j];
				let high = byte >> 4;
				let low = byte & 0xF;
				result[pos++] = high < 10 ? C_ZERO+high : high-10+C_A_CAP;
				result[pos++] = low < 10 ? C_ZERO+low : low-10+C_A_CAP;
			}
			result[pos] = C_APOS;
			return decoder_latin1.decode(result);
		}
		// Assume: param is string
		if (typeof(param) == 'object')
		{	param = JSON.stringify(param);
		}
		else
		{	param += '';
		}
		let n_add = 0;
		for (let j=0, j_end=param.length; j<j_end; j++)
		{	let c = param.charCodeAt(j);
			if (c==C_APOS || c==C_BACKSLASH && !no_backslash_escapes)
			{	n_add++;
			}
		}
		if (n_add == 0)
		{	return "'" + param + "'";
		}
		let result = new Uint8Array(2 + utf8_string_length(param) + n_add);
		let {read, written} = encoder.encodeInto(param, result.subarray(1));
		debug_assert(read == param.length);
		result[0] = C_APOS;
		for (let j=written, k=j+n_add; k!=j; k--, j--)
		{	let c = result[j];
			if (c==C_APOS || c==C_BACKSLASH && !no_backslash_escapes)
			{	result[k--] = c;
			}
			result[k] = c;
		}
		result[1 + written + n_add] = C_APOS;
		return decoder.decode(result);
	}
}

export function sql(strings: TemplateStringsArray, ...params: any[])
{	return new Sql(strings, params);
}

class Serializer
{	private pos = 0;
	private buffer_for_parent_name: Uint8Array | undefined;

	constructor(private result: Uint8Array, private no_backslash_escapes: boolean, private put_params_to: any[]|undefined, private sqlPolicy: SqlPolicy|undefined)
	{
	}

	private append_raw_string(s: string)
	{	while (true)
		{	let {read, written} = encoder.encodeInto(s, this.result.subarray(this.pos));
			this.pos += written;
			if (read == s.length)
			{	break;
			}
			s = s.slice(read);
			let tmp = new Uint8Array((Math.max(this.result.length*2, this.result.length+s.length+this.result.length/2) | 7) + 1);
			tmp.set(this.result.subarray(0, this.pos));
			this.result = tmp;
		}
	}

	private ensure_room(room: number)
	{	if (this.pos+room > this.result.length)
		{	let tmp = new Uint8Array((Math.max(this.result.length*2, this.result.length+Math.max(room, this.result.length/2)) | 7) + 1);
			tmp.set(this.result.subarray(0, this.pos));
			this.result = tmp;
		}
	}

	get_char(offset: number)
	{	return this.result[this.pos + offset];
	}

	set_char(offset: number, value: number)
	{	this.result[this.pos + offset] = value;
	}

	backspace()
	{	this.pos--;
	}

	append_raw_char(value: number)
	{	this.ensure_room(1);
		this.result[this.pos++] = value;
	}

	append_raw_bytes(bytes: Uint8Array)
	{	this.ensure_room(bytes.length);
		this.result.set(bytes, this.pos);
		this.pos += bytes.length;
	}

	/**	Append SQL between params.
	 **/
	append_intermediate_sql_part(s: string, want: Want)
	{	switch (want)
		{	case Want.REMOVE_APOS_OR_BRACE_CLOSE:
			{	let from = --this.pos;
				let c = this.result[from];
				this.append_raw_string(s);
				debug_assert(this.result[from]==C_APOS || this.result[from]==C_BRACE_CLOSE);
				this.result[from] = c;
				break;
			}
			case Want.REMOVE_A_CHAR_AND_BRACE_CLOSE:
			{	debug_assert(s.charAt(1) == "}");
				this.pos -= 2;
				let from = this.pos;
				let c0 = this.result[from];
				let c1 = this.result[from + 1];
				this.append_raw_string(s);
				debug_assert(this.result[from+1] == C_BRACE_CLOSE);
				this.result[from] = c0;
				this.result[from + 1] = c1;
				break;
			}
			case Want.CONVERT_QUOT_TO_BACKTICK:
			{	let from = this.pos;
				this.append_raw_string(s);
				debug_assert(this.result[from]==C_QUOT || this.result[from]==C_BACKTICK);
				this.result[from] = C_BACKTICK;
				break;
			}
			case Want.CONVERT_CLOSE_TO_PAREN_CLOSE:
			{	let from = this.pos;
				this.append_raw_string(s);
				debug_assert(this.result[from]==C_SQUARE_CLOSE || this.result[from]==C_BRACE_CLOSE || this.result[from]==C_GT);
				this.result[from] = C_PAREN_CLOSE;
				break;
			}
			case Want.CONVERT_A_CHAR_AND_BRACE_CLOSE_TO_PAREN_CLOSE:
			{	let from = --this.pos;
				let c = this.result[from];
				this.append_raw_string(s);
				debug_assert(this.result[from+1] == C_BRACE_CLOSE);
				this.result[from + 1] = C_PAREN_CLOSE;
				this.result[from] = c;
				break;
			}
			default:
			{	this.append_raw_string(s);
			}
		}
	}

	/**	Append a "${param}" or a `${param}`.
		I assume that i'm after opening '"' or '`' char.
	 **/
	append_quoted_ident(param: string)
	{	let from = this.pos;
		// Append param, as is
		this.append_raw_string(param);
		// Escape chars in param
		let {result, pos} = this;
		let n_add = 0;
		debug_assert(result[from-1]==C_QUOT || result[from-1]==C_BACKTICK);
		result[from - 1] = C_BACKTICK;
		for (let j=from; j<pos; j++)
		{	if (result[j] == C_BACKTICK)
			{	n_add++;
			}
		}
		if (n_add > 0)
		{	this.ensure_room(n_add);
			result = this.result;
			for (let j=pos-1, k=j+n_add; k!=j; k--, j--)
			{	let c = result[j];
				if (c == C_BACKTICK)
				{	result[k--] = C_BACKTICK;
				}
				result[k] = c;
			}
			this.pos = pos + n_add;
		}
	}

	/**	Append a '${param}'.
		I assume that i'm after opening "'" char.
	 **/
	append_sql_value(param: any)
	{	debug_assert(this.result[this.pos-1] == C_APOS);
		if (param == null)
		{	this.pos--; // backspace '
			this.append_raw_bytes(LIT_NULL);
			return Want.REMOVE_APOS_OR_BRACE_CLOSE;
		}
		if (param === false)
		{	this.pos--; // backspace '
			this.append_raw_bytes(LIT_FALSE);
			return Want.REMOVE_APOS_OR_BRACE_CLOSE;
		}
		if (param === true)
		{	this.pos--; // backspace '
			this.append_raw_bytes(LIT_TRUE);
			return Want.REMOVE_APOS_OR_BRACE_CLOSE;
		}
		if (typeof(param)=='number' || typeof(param)=='bigint')
		{	this.pos--; // backspace '
			this.append_raw_string(param+'');
			return Want.REMOVE_APOS_OR_BRACE_CLOSE;
		}
		if (param instanceof Date)
		{	this.ensure_room(DATE_ALLOC_CHAR_LEN);
			this.pos += date_encode_into(param, this.result.subarray(this.pos));
			return Want.NOTHING;
		}
		if (this.put_params_to && this.put_params_to.length<MYSQL_MAX_PLACEHOLDERS)
		{	this.result[this.pos - 1] = C_QUEST; // ' -> ?
			this.put_params_to.push(param);
			return Want.REMOVE_APOS_OR_BRACE_CLOSE;
		}
		if (param.buffer instanceof ArrayBuffer)
		{	this.pos--; // backspace '
			let param_len = param.byteLength;
			this.ensure_room(param_len*2 + 3); // like x'01020304'
			let {result} = this;
			result[this.pos++] = C_X;
			result[this.pos++] = C_APOS;
			for (let j=0; j<param_len; j++)
			{	let byte = param[j];
				let high = byte >> 4;
				let low = byte & 0xF;
				result[this.pos++] = high < 10 ? C_ZERO+high : high-10+C_A_CAP;
				result[this.pos++] = low < 10 ? C_ZERO+low : low-10+C_A_CAP;
			}
			result[this.pos++] = C_APOS;
			return Want.REMOVE_APOS_OR_BRACE_CLOSE;
		}
		// Assume: param is string
		param += '';
		// Append param, as is
		this.append_raw_string(param);
		// Escape chars in param
		let {result, pos} = this;
		let n_add = 0;
		for (let j=0, j_end=param.length; j<j_end; j++)
		{	let c = param.charCodeAt(j);
			if (c==C_APOS || c==C_BACKSLASH && !this.no_backslash_escapes)
			{	n_add++;
			}
		}
		if (n_add > 0)
		{	this.ensure_room(n_add);
			result = this.result;
			for (let j=pos-1, k=j+n_add; k!=j; k--, j--)
			{	let c = result[j];
				if (c==C_APOS || c==C_BACKSLASH && !this.no_backslash_escapes)
				{	result[k--] = c;
				}
				result[k] = c;
			}
			this.pos = pos + n_add;
		}
		return Want.NOTHING;
	}

	/**	Append a [${param}].
		I assume that i'm after opening '[' char, that was converted to '('.
	 **/
	append_iterable(param: Iterable<any>)
	{	let n_items_added = 0;
		for (let p of param)
		{	if (n_items_added++ != 0)
			{	this.append_raw_char(C_COMMA);
			}
			if (typeof(p)!='object' && typeof(p)!='function' || (p instanceof Date) || (p.buffer instanceof ArrayBuffer))
			{	this.append_raw_char(C_APOS);
				if (this.append_sql_value(p) != Want.REMOVE_APOS_OR_BRACE_CLOSE)
				{	this.append_raw_char(C_APOS);
				}
			}
			else if (Symbol.iterator in p)
			{	this.append_raw_char(C_PAREN_OPEN);
				this.append_iterable(p);
				this.append_raw_char(C_PAREN_CLOSE);
			}
			else
			{	this.append_raw_bytes(LIT_NULL);
			}
		}
		if (n_items_added == 0)
		{	this.append_raw_bytes(LIT_NULL);
		}
	}

	/**	Append a <${param}>.
		I assume that i'm after opening '<' char, that was converted to '('.
	 **/
	append_names_values(param: Iterable<any>)
	{	let names: string[] | undefined;
		for (let row of param)
		{	if (!names)
			{	names = Object.keys(row);
				if (names.length == 0)
				{	throw new Error("No fields for <${param}>");
				}
				this.append_raw_char(C_BACKTICK);
				this.append_quoted_ident(names[0]);
				this.append_raw_char(C_BACKTICK);
				for (let i=1, i_end=names.length; i<i_end; i++)
				{	this.append_raw_char(C_COMMA);
					this.append_raw_char(C_SPACE);
					this.append_raw_char(C_BACKTICK);
					this.append_quoted_ident(names[i]);
					this.append_raw_char(C_BACKTICK);
				}
				this.append_raw_bytes(DELIM_PAREN_CLOSE_VALUES);
			}
			else
			{	this.append_raw_char(C_PAREN_CLOSE);
				this.append_raw_char(C_COMMA);
				this.append_raw_char(C_LF);
			}
			let delim = C_PAREN_OPEN;
			for (let name of names)
			{	this.append_raw_char(delim);
				this.append_raw_char(C_APOS);
				if (this.append_sql_value(row[name]) != Want.REMOVE_APOS_OR_BRACE_CLOSE)
				{	this.append_raw_char(C_APOS);
				}
				delim = C_COMMA;
			}
		}
	}

	/**	Read the parent qualifier in (parent.${param}) or {parent.${param}}.
		I assume that i'm after '.' char.
	 **/
	read_parent_name_on_the_left()
	{	let {result, pos} = this;
		debug_assert(result[pos-1] == C_DOT);
		let from = --pos; // from '.'
		let c = result[--pos];
		while (c>=C_A && c<=C_Z || c>=C_A_CAP && c<=C_Z_CAP || c>=C_ZERO && c<=C_NINE || c==C_UNDERSCORE || c==C_DOLLAR || c>=0x80)
		{	c = result[--pos];
		}
		pos++; // to the first letter of the parent name
		this.pos = pos;
		let parent_name_len = from - pos;
		if (!this.buffer_for_parent_name || this.buffer_for_parent_name.length<parent_name_len)
		{	this.buffer_for_parent_name = new Uint8Array((parent_name_len|7) + 1);
		}
		this.buffer_for_parent_name.set(result.subarray(pos, from));
		return this.buffer_for_parent_name.subarray(0, parent_name_len);
	}

	/**	Append a (${param}).
		I assume that i'm after opening '(' char.
	 **/
	append_safe_sql_fragment(param: string, parent_name: Uint8Array|undefined)
	{	let from = this.pos;
		// Append param, as is
		this.append_raw_string(param);
		// Escape chars in param
		// 1. Find how many bytes to add
		let {result, pos} = this;
		let state = State.SQL;
		let paren_level = 0;
		let changes: {change: Change, change_from: number, change_to: number}[] = [];
		let j_from = -1;
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
							j_from = j;
							state = State.BACKTICK;
							break;
						case C_QUOT:
							j_from = j;
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
						case C_DOT:
							while (++j < pos)
							{	c = result[j];
								if (c!=C_SPACE && c!=C_TAB && c!=C_CR && c!=C_LF)
								{	// skip identifier that follows this dot
									while (c>=C_A && c<=C_Z || c>=C_A_CAP && c<=C_Z_CAP || c>=C_ZERO && c<=C_NINE || c==C_UNDERSCORE || c==C_DOLLAR || c>=0x80)
									{	c = result[++j] | 0;
									}
									break;
								}
							}
							j--; // will j++ on next iter
							break;
						default:
						{	let has_nondigit = c>=C_A && c<=C_Z || c>=C_A_CAP && c<=C_Z_CAP || c==C_UNDERSCORE || c==C_DOLLAR || c>=0x80;
							if (has_nondigit || c>=C_ZERO && c<=C_NINE)
							{	let change_from = j;
								while (j < pos)
								{	c = result[++j];
									if (c>=C_A && c<=C_Z || c>=C_A_CAP && c<=C_Z_CAP || c==C_UNDERSCORE || c==C_DOLLAR || c>=0x80)
									{	has_nondigit = true;
										continue;
									}
									if (c>=C_ZERO && c<=C_NINE)
									{	continue;
									}
									break;
								}
								if (has_nondigit)
								{	// skip space following this identifier
									let j_after_ident = j;
									while (c==C_SPACE || c==C_TAB || c==C_CR || c==C_LF)
									{	c = result[++j] | 0;
									}
									// is allowed?
									let name = result.subarray(change_from, j_after_ident);
									if (c == C_PAREN_OPEN) // if is function
									{	let sql_policy = this.sqlPolicy ?? DEFAULT_SQL_POLICY;
										if (!sql_policy.isFunctionAllowed(name))
										{	changes[changes.length] = {change: Change.QUOTE_IDENT, change_from, change_to: j_after_ident-1};
											n_add += 2; // ``
										}
										else if (j_after_ident < j)
										{	// put '(' right after function name
											debug_assert(result[j] == C_PAREN_OPEN);
											result[j] = result[j_after_ident];
											result[j_after_ident] = C_PAREN_OPEN;
											paren_level++;
										}
									}
									else if (c == C_DOT) // if is parent qualifier
									{	changes[changes.length] = {change: Change.QUOTE_IDENT, change_from, change_to: j_after_ident-1};
										n_add += 2; // ``
									}
									else
									{	let sql_policy = this.sqlPolicy ?? DEFAULT_SQL_POLICY;
										if (!sql_policy.isIdentAllowed(name))
										{	changes[changes.length] = {change: Change.QUOTE_COLUMN_NAME, change_from, change_to: j_after_ident-1};
											n_add += !parent_name ? 2 : parent_name.length+3; // !parent_name ? `` : ``.
										}
									}
								}
								j--; // will j++ on next iter
							}
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
							if (!this.no_backslash_escapes)
							{	changes[changes.length] = {change: Change.DOUBLE_BACKSLASH, change_from: j, change_to: j};
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
								if (parent_name)
								{	c = result[++j];
									while (c==C_SPACE || c==C_TAB || c==C_CR || c==C_LF)
									{	c = result[++j] | 0;
									}
									if (c != C_PAREN_OPEN)
									{	changes[changes.length] = {change: Change.INSERT_PARENT_NAME, change_from: j_from-1, change_to: j_from-1};
										n_add += parent_name.length + 3; // plus ``.
									}
									j--; // will j++ on next iter
								}
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
								if (parent_name)
								{	c = result[++j];
									while (c==C_SPACE || c==C_TAB || c==C_CR || c==C_LF)
									{	c = result[++j] | 0;
									}
									if (c != C_PAREN_OPEN)
									{	changes[changes.length] = {change: Change.INSERT_PARENT_NAME, change_from: j_from-1, change_to: j_from-1};
										n_add += parent_name.length + 3; // plus ``.
									}
									j--; // will j++ on next iter
								}
							}
							break;
						case C_BACKTICK:
							changes[changes.length] = {change: Change.DOUBLE_BACKTICK, change_from: j, change_to: j};
							n_add++;
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
		// 2. Add needed bytes
		if (n_add > 0)
		{	this.ensure_room(n_add);
			result = this.result;
			let n_change = changes.length;
			var {change, change_from, change_to} = changes[--n_change];
			for (let j=pos-1, k=j+n_add; true; k--, j--)
			{	let c = result[j];
				if (j == change_to)
				{	// take actions
					switch (change)
					{	case Change.DOUBLE_BACKSLASH:
							// backslash to double
							debug_assert(c == C_BACKSLASH);
							result[k--] = C_BACKSLASH;
							result[k] = C_BACKSLASH;
							break;
						case Change.DOUBLE_BACKTICK:
							// backtick to double
							debug_assert(c == C_BACKTICK);
							result[k--] = C_BACKTICK;
							result[k] = C_BACKTICK;
							break;
						case Change.INSERT_PARENT_NAME:
							result[k--] = C_DOT;
							result[k--] = C_BACKTICK;
							for (let p=parent_name!.length-1; p>=0; p--)
							{	result[k--] = parent_name![p];
							}
							result[k--] = C_BACKTICK;
							result[k] = c;
							break;
						case Change.QUOTE_COLUMN_NAME:
							// column name to quote
							if (!parent_name)
							{	result[k--] = C_BACKTICK;
								while (j >= change_from)
								{	result[k--] = result[j--];
								}
								result[k] = C_BACKTICK;
							}
							else
							{	while (j >= change_from)
								{	result[k--] = result[j--];
								}
								result[k--] = C_DOT;
								result[k--] = C_BACKTICK;
								for (let p=parent_name.length-1; p>=0; p--)
								{	result[k--] = parent_name[p];
								}
								result[k] = C_BACKTICK;
							}
							j++; // will k--, j-- on next iter
							break;
						case Change.QUOTE_IDENT:
							// some identifier to quote
							result[k--] = C_BACKTICK;
							while (j >= change_from)
							{	result[k--] = result[j--];
							}
							result[k] = C_BACKTICK;
							j++; // will k--, j-- on next iter
							break;
						default:
							debug_assert(false);
					}
					if (n_change <= 0)
					{	break;
					}
					var {change, change_from, change_to} = changes[--n_change];
				}
				else
				{	// copy char
					result[k] = c;
				}
			}
			this.pos = pos + n_add;
		}
	}

	/**	Done serializing. Get the produced result.
	 **/
	get_result()
	{	return this.result.subarray(0, this.pos);
	}
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
