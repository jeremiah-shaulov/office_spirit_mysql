export function realloc_append(buffer: Uint8Array, data: Uint8Array)
{	let len = buffer.byteLength;
	let data_len = data.byteLength;
	let space = buffer.buffer.byteLength - len - buffer.byteOffset;
	if (space >= data_len)
	{	buffer = new Uint8Array(buffer.buffer, buffer.byteOffset, len+data_len);
		buffer.set(data, len);
		return buffer;
	}
	let tmp = new Uint8Array(len + data_len);
	tmp.set(buffer, 0);
	tmp.set(data, len);
	return tmp;
}
