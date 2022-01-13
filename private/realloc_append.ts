export function reallocAppend(arr: Uint8Array, data: Uint8Array, withCapacity=false)
{	const offset = arr.byteOffset;
	const len = arr.length;
	const dataLen = data.length;
	// can just append?
	let space = arr.buffer.byteLength - len - offset;
	if (space >= dataLen)
	{	arr = new Uint8Array(arr.buffer, offset, len+dataLen);
		arr.set(data, len);
		return arr;
	}
	// can shift to the beginning and append?
	space += offset;
	if (space >= dataLen)
	{	const tmp = new Uint8Array(arr.buffer);
		tmp.copyWithin(0, offset, offset+len);
		return tmp.subarray(0, len);
	}
	// no, so enlarge the buffer
	const tmp = new Uint8Array(!withCapacity ? len+dataLen : Math.max(len+dataLen+(len >> 1), len*2));
	tmp.set(arr, 0);
	tmp.set(data, len);
	return tmp;
}
