const C_A_CAP = 'A'.charCodeAt(0);
const C_A = 'a'.charCodeAt(0);
const C_Z = 'z'.charCodeAt(0);

const encoder = new TextEncoder;

const DEFAULT_IDENTS =
[	'not', 'and', 'or', 'xor', 'between', 'as', 'separator', 'is', 'null', 'distinct',
	'asc', 'desc', 'like', 'char', 'match', 'against', 'in',
	'interval', 'year', 'month', 'week', 'day', 'hour', 'minute', 'second', 'microsecond',
	'case', 'when', 'then', 'else', 'end',

	'concat', 'concat_ws', 'locate', 'left', 'right', 'mid', 'unix_timestamp', 'from_unixtime', 'now', 'date', 'weekday', 'quote', 'trim',
	'sec_to_time', 'if', 'elt', 'field', 'length', 'char_length', 'substr', 'inet_aton', 'inet_ntoa', 'count',
	'sum', 'min', 'max', 'avg', 'bit_and', 'bit_or',
	'group_concat', 'ifnull', 'coalesce', 'crc32', 'truncate', 'round', 'floor', 'ceil', 'hex', 'unhex',
	'lpad', 'find_in_set', 'host', 'lower', 'upper', 'time', 'bin', 'oct', 'hex', 'regexp_replace', 'replace',
	'md5', 'sha1', 'get_lock', 'release_lock',
	'least', 'greatest',
	'json_arrayagg', 'json_objectagg', 'json_unquote', 'json_extract',
	'point', 'st_x', 'st_y', 'st_distance', 'st_distance_sphere', 'mbrcontains', 'st_buffer', 'st_buffer_strategy',
];

export class AllowedSqlIdents
{	idents: string[] = [];

	private map: Map<number, Uint8Array[]> = new Map;

	constructor(init_idents?: string[])
	{	this.allow(init_idents ?? DEFAULT_IDENTS);
	}

	allow(init_idents: string[])
	{	for (let id of init_idents)
		{	id = id.toUpperCase();
			let word = encoder.encode(id);
			let key = word[0] | (word[1] << 8) | (word[word.length-1] << 16) | (word.length << 24);
			let list = this.map.get(key);
			if (!list)
			{	list = [];
				this.map.set(key, list);
			}
			if (list.findIndex(v => uint8array_cmp(v, word)==0) == -1)
			{	list.push(word);
				this.idents.push(id);
			}
		}
		this.idents.sort();
	}

	disallow(init_idents: string[])
	{	let {idents} = this;
		this.idents = [];
		this.map.clear();
		for (let id of init_idents)
		{	id = id.toUpperCase();
			let pos = idents.indexOf(id);
			if (pos != -1)
			{	idents.splice(pos, 1);
			}
		}
		this.allow(idents);
	}

	isAllowed(subj: Uint8Array)
	{	let len = subj.length;
		let c0 = subj[0] | 0;
		let c1 = subj[1] | 0;
		let cN = subj[len-1] | 0;
		if (c0>=C_A && c0<=C_Z)
		{	c0 += C_A_CAP - C_A; // to upper case
		}
		if (c1>=C_A && c1<=C_Z)
		{	c1 += C_A_CAP - C_A; // to upper case
		}
		if (cN>=C_A && cN<=C_Z)
		{	cN += C_A_CAP - C_A; // to upper case
		}
		let key = c0 | (c1 << 8) | (cN << 16) | (len << 24);
		let list = this.map.get(key);
		if (list)
		{	len--; // no need to compare the last char, as it's part of key
			// is subj in list?
L:			for (let word of list)
			{	for (let i=2; i<len; i++) // no need to compare the first 2 chars, as they're part of key
				{	let c = subj[i];
					if (c>=C_A && c<=C_Z)
					{	c += C_A_CAP - C_A; // to upper case
					}
					if (word[i] != c)
					{	continue L;
					}
				}
				return true;
			}
		}
		return false;
	}
}

export const DEFAULT_ALLOWED_SQL_IDENTS = new AllowedSqlIdents;

function uint8array_cmp(a: Uint8Array, b: Uint8Array)
{	let len = Math.min(a.length, b.length);
	for (let i=0; i<len; i++)
	{	if (a[i] < b[i])
		{	return -1;
		}
		if (a[i] > b[i])
		{	return +1;
		}
	}
	if (a.length < b.length)
	{	return -1;
	}
	if (a.length > b.length)
	{	return +1;
	}
	return 0;
}
