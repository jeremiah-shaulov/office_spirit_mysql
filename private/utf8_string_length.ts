export function utf8StringLength(str: string)
{	let len = str.length;
	for (let i=0, iEnd=str.length; i<iEnd; i++)
	{	const c = str.charCodeAt(i);
		if (c > 0x7F)
		{	len++;
			if (c > 0x7FF)
			{	len++;
				if (c>=0xD800 && c<=0xDBFF && i+1<iEnd)
				{	const c2 = str.charCodeAt(i+1);
					if (c2>=0xDC00 && c2<=0xDFFF)
					{	i++; // surrogate pair
					}
				}
			}
		}
	}
	return len;
}
