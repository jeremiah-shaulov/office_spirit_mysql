import {reallocAppend} from '../realloc_append.ts';
import {assert} from 'jsr:@std/assert@1.0.7/assert';
import {assertEquals} from 'jsr:@std/assert@1.0.7/equals';

Deno.test
(	'reallocAppend',
	() =>
	{	const data: Uint8Array<ArrayBufferLike> = new Uint8Array([0, 1, 2, 0, 0, 0]);
		let arr = data.subarray(0, 3);

		arr = reallocAppend(arr, new Uint8Array([3, 4]));
		assert(arr.buffer === data.buffer);
		assertEquals(arr, new Uint8Array([0, 1, 2, 3, 4]));

		arr = reallocAppend(arr, new Uint8Array([5]));
		assert(arr.buffer === data.buffer);
		assertEquals(arr, new Uint8Array([0, 1, 2, 3, 4, 5]));

		arr = reallocAppend(arr, new Uint8Array([6]));
		assert(arr.buffer !== data.buffer);
		assertEquals(arr, new Uint8Array([0, 1, 2, 3, 4, 5, 6]));
	}
);

Deno.test
(	'reallocAppend with offset',
	() =>
	{	const data = new Uint8Array([0, 0, 1, 2, 0, 0]);
		let arr: Uint8Array<ArrayBufferLike> = data.subarray(1, 4);

		arr = reallocAppend(arr, new Uint8Array([3, 4]));
		assert(arr.buffer === data.buffer);
		assertEquals(arr, new Uint8Array([0, 1, 2, 3, 4]));

		arr = reallocAppend(arr, new Uint8Array([5]));
		assert(arr.buffer === data.buffer);
		assertEquals(arr, new Uint8Array([0, 1, 2, 3, 4, 5]));

		arr = reallocAppend(arr, new Uint8Array([6]));
		assert(arr.buffer !== data.buffer);
		assertEquals(arr, new Uint8Array([0, 1, 2, 3, 4, 5, 6]));
	}
);

Deno.test
(	'reallocAppend data shares buffer with arr',
	() =>
	{	// Reproduce the shift-and-append path with `data` aliasing the source range. The buffer is 20 bytes, `arr` sits at offset 15, and `data` lives at the start of the same buffer — exactly the bytes that `copyWithin` overwrites. The append must still see the original `data` bytes.
		const buf = new Uint8Array(20);
		for (let i=0; i<20; i++)
		{	buf[i] = i + 1;
		}
		const arr: Uint8Array<ArrayBufferLike> = buf.subarray(15, 18); // [16, 17, 18]
		const data = buf.subarray(0, 5); // [1, 2, 3, 4, 5]

		const out = reallocAppend(arr, data);
		assertEquals(out, new Uint8Array([16, 17, 18, 1, 2, 3, 4, 5]));
	}
);
