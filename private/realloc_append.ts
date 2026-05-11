export function reallocAppend(arr: Uint8Array, data: Uint8Array, withCapacity=false)
{	const {byteOffset, length} = arr;
	const dataLen = data.length;
	const space = arr.buffer.byteLength - length - byteOffset;
	// can just append?
	if (space >= dataLen)
	{	const res = new Uint8Array(arr.buffer, byteOffset, length+dataLen);
		res.set(data, length);
		return res;
	}
	// can shift to the beginning and append?
	else if (space+byteOffset >= dataLen)
	{	const res = new Uint8Array(arr.buffer);
		// `copyWithin` below overwrites positions [0, length) of `arr.buffer`. If `data` aliases any of those bytes, snapshot it first so the original contents are preserved.
		if (data.buffer === arr.buffer && data.byteOffset < length)
		{	data = new Uint8Array(data);
		}
		res.copyWithin(0, byteOffset, byteOffset+length);
		res.set(data, length);
		return res.subarray(0, length+dataLen);
	}
	// no, so enlarge the buffer
	else
	{	const res = new Uint8Array(!withCapacity ? length+dataLen : Math.max(length+dataLen+(length >> 1), length*2));
		res.set(arr);
		res.set(data, length);
		return res.subarray(0, length+dataLen);
	}
}
