export function utf8_string_length(str: string)
{	let len = str.length;
	for (let i=0, i_end=str.length; i<i_end; i++)
	{	let c = str.charCodeAt(i);
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
