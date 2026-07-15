import {deflateBound, deflateInto} from '../deflate_into.ts';
import {assert} from 'jsr:@std/assert@1.0.19/assert';
import {assertEquals} from 'jsr:@std/assert@1.0.19/equals';
import {createDeflate, deflateSync, inflateSync} from 'node:zlib';

// deno-lint-ignore no-explicit-any
type Any = any;

function getRandomBytes(len: number)
{	const data = new Uint8Array(len);
	for (let pos=0; pos<len; pos+=65536) // crypto.getRandomValues() refuses to generate more than 64 KiB at once
	{	crypto.getRandomValues(data.subarray(pos, pos+65536));
	}
	return data;
}

Deno.test
(	'deflateInto: deflates to the given offset, touching nothing before it',
	() =>
	{	for (const size of [50, 300, 8*1024, 100_000])
		{	for (const offset of [0, 7, 13])
			{	const input = new Uint8Array(size);
				for (let i=0; i<size; i++)
				{	input[i] = 97 + (i % 26);
				}
				const out = new Uint8Array(offset + deflateBound(size) + 1).fill(0xEE);
				const len = deflateInto(out, offset, input);
				assert(len>0 && len<size); // compressible
				assert(out.subarray(0, offset).every(b => b == 0xEE));
				assertEquals(new Uint8Array(inflateSync(out.subarray(offset, offset+len))), input);
				assertEquals(out.slice(offset, offset+len), new Uint8Array(deflateSync(input))); // same bytes as the public API produces
			}
		}
	}
);

Deno.test
(	'deflateInto: incompressible input stays within deflateBound()',
	() =>
	{	const input = getRandomBytes(100_000);
		const out = new Uint8Array(7 + deflateBound(input.length) + 1);
		const len = deflateInto(out, 7, input);
		assert(len > input.length); // random data doesn't compress, deflate stores it with the block overhead
		assert(len <= deflateBound(input.length));
		assertEquals(new Uint8Array(inflateSync(out.subarray(7, 7+len))), input);
	}
);

Deno.test
(	'deflateInto: destination that is a subarray with nonzero byteOffset',
	() =>
	{	const input = new Uint8Array(1000).fill('a'.charCodeAt(0));
		const backing = new Uint8Array(64 + 5 + deflateBound(input.length) + 1).fill(0xEE);
		const out = backing.subarray(64);
		const len = deflateInto(out, 5, input);
		assert(backing.subarray(0, 64+5).every(b => b == 0xEE)); // nothing before `out[5]` is touched
		assertEquals(new Uint8Array(inflateSync(out.subarray(5, 5+len))), input);
	}
);

Deno.test
(	'deflateInto: falls back to the public API when the private API breaks',
	() =>
	{	// Find the prototype that owns `_processChunk`, and break it, as if a future Deno version removed or changed it
		const engine = createDeflate() as Any;
		let proto = engine;
		while (proto && !Object.prototype.hasOwnProperty.call(proto, '_processChunk'))
		{	proto = Object.getPrototypeOf(proto);
		}
		assert(proto, 'no _processChunk found - if node:zlib no longer has it, this test (and the private path) can be removed');
		const original = proto._processChunk;
		proto._processChunk = () =>
		{	throw new Error('gone');
		};
		try
		{	// This call hits the broken private API, and must transparently produce a correct result through `deflateSync()`
			const input = new Uint8Array(1000).fill('b'.charCodeAt(0));
			const out = new Uint8Array(7 + deflateBound(input.length) + 1).fill(0xEE);
			const len = deflateInto(out, 7, input);
			assert(out.subarray(0, 7).every(b => b == 0xEE));
			assertEquals(new Uint8Array(inflateSync(out.subarray(7, 7+len))), input);
			// And having tripped once, it must not try the private API again
			let calledAgain = false;
			proto._processChunk = () =>
			{	calledAgain = true;
				throw new Error('gone');
			};
			const len2 = deflateInto(out, 7, input);
			assertEquals(new Uint8Array(inflateSync(out.subarray(7, 7+len2))), input);
			assert(!calledAgain);
		}
		finally
		{	proto._processChunk = original;
			engine.close();
		}
	}
);
