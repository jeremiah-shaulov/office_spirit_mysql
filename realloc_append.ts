export function realloc_append(buffer: Uint8Array, data: Uint8Array, with_capacity=false)
{	let len = buffer.byteLength;
	let data_len = data.byteLength;
	let space = buffer.buffer.byteLength - len - buffer.byteOffset;
	if (space >= data_len)
	{	buffer = new Uint8Array(buffer.buffer, buffer.byteOffset, len+data_len);
		buffer.set(data, len);
		return buffer;
	}
	let tmp = new Uint8Array(!with_capacity ? len+data_len : Math.max(len+data_len+len/2, len*2));
	tmp.set(buffer, 0);
	tmp.set(data, len);
	return tmp;
}
