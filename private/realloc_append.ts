export function reallocAppend(buffer: Uint8Array, data: Uint8Array, withCapacity=false)
{	const offset = buffer.byteOffset;
	const len = buffer.length;
	const dataLen = data.length;
	// can just append?
	let space = buffer.buffer.byteLength - len - offset;
	if (space >= dataLen)
	{	buffer = new Uint8Array(buffer.buffer, offset, len+dataLen);
		buffer.set(data, len);
		return buffer;
	}
	// can shift to the beginning and append?
	space += offset;
	if (space >= dataLen)
	{	const tmp = new Uint8Array(buffer.buffer, 0, buffer.buffer.byteLength);
		tmp.copyWithin(0, offset, offset+len);
		return tmp.subarray(0, len);
	}
	// no, so enlarge the buffer
	const tmp = new Uint8Array(!withCapacity ? len+dataLen : Math.max(len+dataLen+(len >> 1), len*2));
	tmp.set(buffer, 0);
	tmp.set(data, len);
	return tmp;
}
