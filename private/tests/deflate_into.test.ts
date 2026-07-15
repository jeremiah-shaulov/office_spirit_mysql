import {deflateBound, deflateInto, zstdCompressBound, zstdCompressInto, zstdDecompress, isZstdSupported, ZSTD_DEFAULT_LEVEL} from '../deflate_into.ts';
import {assert} from 'jsr:@std/assert@1.0.19/assert';
import {assertEquals} from 'jsr:@std/assert@1.0.19/equals';
import {createDeflate, deflateSync, inflateSync} from 'node:zlib';
import zlib from 'node:zlib';

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

// --- The zstd counterparts (only on runtimes whose `node:zlib` has zstd - Deno 2.7+, Node.js 23.8+) ---

Deno.test
(	'zstdCompressInto: compresses to the given offset, touching nothing before it',
	{ignore: !isZstdSupported()},
	() =>
	{	for (const size of [50, 300, 8*1024, 100_000])
		{	for (const offset of [0, 7, 13])
			{	const input = new Uint8Array(size);
				for (let i=0; i<size; i++)
				{	input[i] = 97 + (i % 26);
				}
				const out = new Uint8Array(offset + zstdCompressBound(size) + 1).fill(0xEE);
				const len = zstdCompressInto(out, offset, input, ZSTD_DEFAULT_LEVEL);
				assert(len>0 && len<size); // compressible
				assert(out.subarray(0, offset).every(b => b == 0xEE));
				assertEquals(new Uint8Array(zstdDecompress(out.subarray(offset, offset+len))), input);
			}
		}
	}
);

Deno.test
(	'zstdCompressInto: incompressible input stays within zstdCompressBound()',
	{ignore: !isZstdSupported()},
	() =>
	{	for (const size of [50, 1024, 100_000, 200_000]) // sizes below and above the 128 KiB threshold in the bound formula
		{	const input = getRandomBytes(size);
			const out = new Uint8Array(7 + zstdCompressBound(size) + 1);
			const len = zstdCompressInto(out, 7, input, ZSTD_DEFAULT_LEVEL);
			assert(len > input.length); // random data doesn't compress, zstd stores it with the frame overhead
			assert(len <= zstdCompressBound(size));
			assertEquals(new Uint8Array(zstdDecompress(out.subarray(7, 7+len))), input);
		}
	}
);

Deno.test
(	'zstdCompressInto: destination that is a subarray with nonzero byteOffset',
	{ignore: !isZstdSupported()},
	() =>
	{	const input = new Uint8Array(1000).fill('a'.charCodeAt(0));
		const backing = new Uint8Array(64 + 5 + zstdCompressBound(input.length) + 1).fill(0xEE);
		const out = backing.subarray(64);
		const len = zstdCompressInto(out, 5, input, ZSTD_DEFAULT_LEVEL);
		assert(backing.subarray(0, 64+5).every(b => b == 0xEE)); // nothing before `out[5]` is touched
		assertEquals(new Uint8Array(zstdDecompress(out.subarray(5, 5+len))), input);
	}
);

Deno.test
(	'zstdCompressInto: the compression level takes effect',
	{ignore: !isZstdSupported()},
	() =>
	{	// Deterministic text-like input, that leaves the level room to matter
		const parts = new Array<string>;
		let seed = 12345;
		for (let i=0; i<10000; i++)
		{	seed = (seed*1103515245 + 12345) & 0x7FFFFFFF;
			parts.push('value_'+(seed % 1000));
		}
		const input = new TextEncoder().encode(parts.join(' '));
		const lens = [1, 19].map
		(	level =>
			{	const out = new Uint8Array(zstdCompressBound(input.length) + 1);
				const len = zstdCompressInto(out, 0, input, level);
				assertEquals(new Uint8Array(zstdDecompress(out.subarray(0, len))), input);
				return len;
			}
		);
		assert(lens[1] < lens[0], `level 19 (${lens[1]} bytes) must compress better than level 1 (${lens[0]} bytes)`);
	}
);

Deno.test
(	'zstdCompressInto: falls back to the public API when the private API breaks',
	{ignore: !isZstdSupported()},
	() =>
	{	// Find the prototype that owns `_processChunk`, and break it, as if a future Deno version removed or changed it
		const engine = (zlib as Any).createZstdCompress() as Any;
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
		{	// This call hits the broken private API, and must transparently produce a correct result through `zstdCompressSync()`
			const input = new Uint8Array(1000).fill('b'.charCodeAt(0));
			const out = new Uint8Array(7 + zstdCompressBound(input.length) + 1).fill(0xEE);
			const len = zstdCompressInto(out, 7, input, ZSTD_DEFAULT_LEVEL);
			assert(out.subarray(0, 7).every(b => b == 0xEE));
			assertEquals(new Uint8Array(zstdDecompress(out.subarray(7, 7+len))), input);
			// And having tripped once, it must not try the private API again
			let calledAgain = false;
			proto._processChunk = () =>
			{	calledAgain = true;
				throw new Error('gone');
			};
			const len2 = zstdCompressInto(out, 7, input, ZSTD_DEFAULT_LEVEL);
			assertEquals(new Uint8Array(zstdDecompress(out.subarray(7, 7+len2))), input);
			assert(!calledAgain);
		}
		finally
		{	proto._processChunk = original;
			engine.close();
		}
	}
);
