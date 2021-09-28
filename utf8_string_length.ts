export function utf8StringLength(str: string)
{	let len = str.length;
	for (let i=0, iEnd=str.length; i<iEnd; i++)
	{	const c = str.charCodeAt(i);
		if (c > 0x7F)
		{	len++;
			if (c > 0x7FF)
			{	len++;
				if (c>=0xD800 && c<=0xDBFF)
				{	i++; // surrogate pair
				}
			}
		}
	}
	return len;
}
