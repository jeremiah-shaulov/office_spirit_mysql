import {debugAssert} from './debug_assert.ts';
import {createDeflate, deflateSync, inflateSync, constants} from 'node:zlib';
import {Buffer} from 'node:buffer';

// deno-lint-ignore no-explicit-any
type Any = any;

/**	Undefined until the first {@link deflateInto()} call probes whether the private API of `node:zlib` behaves as expected.
	Set to false forever if it doesn't (also when it misbehaves later).
 **/
let usePrivateApi: boolean | undefined;

/**	Upper bound on the zlib-deflated size of `len` bytes of input: zlib's own `deflateBound()` formula for the default settings
	(from `deflate.c`; holds even for incompressible input, that deflate stores verbatim in its stream).
	{@link deflateInto()} requires `deflateBound(part.length) + 1` bytes of space in the destination.
 **/
export function deflateBound(len: number)
{	return len + (len >> 12) + (len >> 14) + (len >> 25) + 13;
}

/**	Deflate `part` to `out` starting at `offset`, and return the number of bytes written.
	The caller must provide at least `deflateBound(part.length) + 1` bytes of space after `offset` - then nothing but `out` receives
	the compressed bytes (the `+ 1` is because exactly filling the space makes zlib continue to an internally allocated buffer).
	Uses the private API of `node:zlib`: the same machinery that `deflateSync()` uses, but with the output buffer pointed at `out`,
	so the compressed bytes land at their final position, and no intermediate buffer is allocated and copied.
	The private API is probed on the first call, and if it's not functional (or misbehaves later), falls back
	to the public `deflateSync()` + copy, forever.
 **/
export function deflateInto(out: Uint8Array, offset: number, part: Uint8Array)
{	debugAssert(out.length-offset >= deflateBound(part.length)+1);
	if (usePrivateApi === undefined)
	{	usePrivateApi = probePrivateApi();
	}
	if (usePrivateApi)
	{	try
		{	return deflateIntoPrivate(out, offset, part);
		}
		catch
		{	usePrivateApi = false;
		}
	}
	const data = deflateSync(part);
	out.set(data, offset); // fits: `deflateSync()` output never exceeds `deflateBound()`
	return data.length;
}

/**	The private-API path: create the same engine that `deflateSync()` creates, point its output buffer at `out`, and process the whole input.
	`Deflate._processChunk()` with `Z_FINISH` and enough output space deflates to `_outBuffer` at `_outOffset`, and returns the written part
	as a `Buffer` view, so verifying that the result is a view into `out` at `offset` proves that no reallocation or copying took place.
 **/
function deflateIntoPrivate(out: Uint8Array, offset: number, part: Uint8Array)
{	const engine = createDeflate({chunkSize: 64}) as Any; // 64 == Z_MIN_CHUNK, so the engine's own output buffer (that i then substitute) is as small as possible
	engine._outBuffer = Buffer.from(out.buffer, out.byteOffset, out.byteLength);
	engine._outOffset = offset;
	engine._chunkSize = out.byteLength; // the available space is `_chunkSize - _outOffset`
	const data: Buffer = engine._processChunk(part, constants.Z_FINISH);
	if (data.buffer!==out.buffer || data.byteOffset!==out.byteOffset+offset)
	{	throw new Error('The private API of node:zlib behaved unexpectedly');
	}
	return data.length;
}

/**	Check that {@link deflateIntoPrivate()} produces a correct zlib stream at the requested position, without touching the bytes before it.
 **/
function probePrivateApi()
{	try
	{	const input = new Uint8Array(300);
		for (let i=0; i<input.length; i++)
		{	input[i] = i & 0x3F;
		}
		const out = new Uint8Array(7 + deflateBound(input.length) + 1).fill(0xEE);
		const len = deflateIntoPrivate(out, 7, input);
		const restored = inflateSync(out.subarray(7, 7+len));
		return len>0 && len<input.length && out.subarray(0, 7).every(b => b == 0xEE) && restored.equals(input);
	}
	catch
	{	return false;
	}
}
