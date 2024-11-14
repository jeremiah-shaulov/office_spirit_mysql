import {reallocAppend} from '../realloc_append.ts';
import {assert} from 'jsr:@std/assert@1.0.7/assert';
import {assertEquals} from 'jsr:@std/assert@1.0.7/equals';

Deno.test
(	'reallocAppend',
	() =>
	{	const data = new Uint8Array([0, 1, 2, 0, 0, 0]);
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
		let arr = data.subarray(1, 4);

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
