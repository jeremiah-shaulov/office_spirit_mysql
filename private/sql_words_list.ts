const C_A_CAP = 'A'.charCodeAt(0);
const C_A = 'a'.charCodeAt(0);
const C_Z = 'z'.charCodeAt(0);

const RE_S = /\s+/;

const encoder = new TextEncoder;

export class SqlWordsList
{	#map: Map<number, Uint8Array[]> = new Map;

	constructor(initDef: string)
	{	initDef = initDef.trim();
		const initIdentsArr = initDef.split(RE_S);
		const idents = new Array<string>;
		for (let id of initIdentsArr)
		{	id = id.toUpperCase();
			const word = encoder.encode(id);
			const key = word[0] | (word[1] << 8) | (word[word.length-1] << 16) | (word.length << 24);
			let list = this.#map.get(key);
			if (!list)
			{	list = [];
				this.#map.set(key, list);
			}
			if (list.findIndex(v => uint8arrayCmp(v, word)==0) == -1)
			{	list.push(word);
				idents.push(id);
			}
		}
		idents.sort();
	}

	contains(subj: Uint8Array)
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
		const key = c0 | (c1 << 8) | (cN << 16) | (len << 24);
		const list = this.#map.get(key);
		if (list)
		{	len--; // no need to compare the last char, as it's part of key
			// is subj in list?
L:			for (const word of list)
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

function uint8arrayCmp(a: Uint8Array, b: Uint8Array)
{	const len = Math.min(a.length, b.length);
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
