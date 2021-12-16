export function reallocAppend(buffer: Uint8Array, data: Uint8Array, withCapacity=false)
{	const len = buffer.byteLength;
	const dataLen = data.byteLength;
	const space = buffer.buffer.byteLength - len - buffer.byteOffset;
	if (space >= dataLen)
	{	buffer = new Uint8Array(buffer.buffer, buffer.byteOffset, len+dataLen);
		buffer.set(data, len);
		return buffer;
	}
	const tmp = new Uint8Array(!withCapacity ? len+dataLen : Math.max(len+dataLen+len/2, len*2));
	tmp.set(buffer, 0);
	tmp.set(data, len);
	return tmp;
}
