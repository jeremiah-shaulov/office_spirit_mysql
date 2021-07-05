const C_A_CAP = 'A'.charCodeAt(0);
const C_A = 'a'.charCodeAt(0);
const C_Z = 'z'.charCodeAt(0);

const RE_S = /\s+/;

const DEFAULT_IDENTS_POLICY = `NOT AND OR XOR BETWEEN SEPARATOR IS NULL DISTINCT LIKE CHAR MATCH AGAINST INTERVAL YEAR MONTH WEEK DAY HOUR MINUTE SECOND MICROSECOND CASE WHEN THEN ELSE END`;
const DEFAULT_FUNCTIONS_POLICY = `! SELECT VALUES`;

const encoder = new TextEncoder;

class SqlWordsList
{	def: string;

	private is_whitelist = true;
	private map: Map<number, Uint8Array[]> = new Map;

	constructor(init_def: string)
	{	init_def = init_def.trim();
		if (init_def.charAt(0) == '!')
		{	this.is_whitelist = false;
			init_def = init_def.slice(1).trimStart();
		}
		let init_idents_arr = init_def.split(RE_S);
		let idents = [];
		for (let id of init_idents_arr)
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
				idents.push(id);
			}
		}
		idents.sort();
		this.def = this.is_whitelist ? idents.join(' ') : '!'+idents.join(' ');
	}

	is_allowed(subj: Uint8Array)
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
				return this.is_whitelist;
			}
		}
		return !this.is_whitelist;
	}
}

export class SqlPolicy
{	private m_idents: SqlWordsList;
	private m_functions: SqlWordsList;

	constructor(idents?: string, functions?: string)
	{	this.m_idents = new SqlWordsList(idents ?? DEFAULT_IDENTS_POLICY);
		this.m_functions = new SqlWordsList(functions ?? DEFAULT_FUNCTIONS_POLICY);
	}

	get idents()
	{	return this.m_idents.def;
	}

	get functions()
	{	return this.m_functions.def;
	}

	isIdentAllowed(subj: Uint8Array)
	{	return this.m_idents.is_allowed(subj);
	}

	isFunctionAllowed(subj: Uint8Array)
	{	return this.m_functions.is_allowed(subj);
	}
}

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
