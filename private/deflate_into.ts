import {debugAssert} from './debug_assert.ts';
import {createDeflate, deflateSync, inflateSync, constants} from 'node:zlib';
import zlib from 'node:zlib';
import {Buffer} from 'node:buffer';

// deno-lint-ignore no-explicit-any
type Any = any;

/**	The zstd API of `node:zlib`, appeared in Node.js 23.8+ and Deno 2.7+.
	Taken from the module object (not imported by name), so this module still loads on runtimes that don't have it -
	then {@link isZstdSupported()} returns false, and the zstd functions here are never called.
 **/
const {zstdCompressSync, zstdDecompressSync, createZstdCompress} = zlib as Any;
const ZSTD_C_COMPRESSION_LEVEL = (constants as Any).ZSTD_c_compressionLevel;
const ZSTD_E_END = (constants as Any).ZSTD_e_end;

/**	The default zstd compression level, like MySQL's default for `--zstd-compression-level`.
 **/
export const ZSTD_DEFAULT_LEVEL = 3;

/**	Undefined until the first {@link deflateInto()} call probes whether the private API of `node:zlib` behaves as expected.
	Set to false forever if it doesn't (also when it misbehaves later).
 **/
let usePrivateApi: boolean | undefined;

/**	The same for {@link zstdCompressInto()}: the zstd engine is a different class, so it's probed separately.
 **/
let useZstdPrivateApi: boolean | undefined;

/**	Undefined until {@link isZstdSupported()} probes whether the runtime has a working zstd
	(on Deno 2.5 - 2.6 `node:zlib` exports the zstd functions, but calling them throws).
 **/
let zstdSupported: boolean | undefined;

/**	True if `node:zlib` of this runtime has a working zstd implementation (Node.js 23.8+, Deno 2.7+).
	Probed with an actual compress + decompress roundtrip on the first call.
 **/
export function isZstdSupported()
{	if (zstdSupported === undefined)
	{	try
		{	const input = Uint8Array.of(1, 2, 3);
			const restored: Buffer = zstdDecompressSync(zstdCompressSync(input));
			zstdSupported = restored.length==input.length && restored.every((b, i) => b == input[i]);
		}
		catch
		{	zstdSupported = false;
		}
	}
	return zstdSupported;
}

/**	Decompress a zstd frame (the counterpart of `inflateSync()` for the compressed protocol reader).
 **/
export function zstdDecompress(data: Uint8Array): Uint8Array
{	return zstdDecompressSync(data);
}

/**	Upper bound on the zlib-deflated size of `len` bytes of input: zlib's own `deflateBound()` formula for the default settings
	(from `deflate.c`; holds even for incompressible input, that deflate stores verbatim in its stream).
	{@link deflateInto()} requires `deflateBound(part.length) + 1` bytes of space in the destination.
 **/
export function deflateBound(len: number)
{	return len + (len >> 12) + (len >> 14) + (len >> 25) + 13;
}

/**	Upper bound on the zstd-compressed size of `len` bytes of input: `ZSTD_COMPRESSBOUND()` from `zstd.h`
	(holds for any compression level, even for incompressible input, that zstd stores verbatim in its frame).
	{@link zstdCompressInto()} requires `zstdCompressBound(part.length) + 1` bytes of space in the destination.
 **/
export function zstdCompressBound(len: number)
{	return len + (len >> 8) + (len < (128 << 10) ? ((128 << 10) - len) >> 11 : 0);
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
		{	return compressIntoPrivate(createDeflate({chunkSize: 64}), constants.Z_FINISH, out, offset, part);
		}
		catch
		{	usePrivateApi = false;
		}
	}
	const data = deflateSync(part);
	out.set(data, offset); // fits: `deflateSync()` output never exceeds `deflateBound()`
	return data.length;
}

/**	The zstd counterpart of {@link deflateInto()}: compress `part` to `out` starting at `offset` with the given zstd level,
	and return the number of bytes written. The caller must provide at least `zstdCompressBound(part.length) + 1` bytes of space
	after `offset`. Only call when {@link isZstdSupported()}.
 **/
export function zstdCompressInto(out: Uint8Array, offset: number, part: Uint8Array, level: number)
{	debugAssert(out.length-offset >= zstdCompressBound(part.length)+1);
	const options = {chunkSize: 64, params: {[ZSTD_C_COMPRESSION_LEVEL]: level}};
	if (useZstdPrivateApi === undefined)
	{	useZstdPrivateApi = probeZstdPrivateApi();
	}
	if (useZstdPrivateApi)
	{	try
		{	return compressIntoPrivate(createZstdCompress(options), ZSTD_E_END, out, offset, part);
		}
		catch
		{	useZstdPrivateApi = false;
		}
	}
	const data: Buffer = zstdCompressSync(part, options);
	out.set(data, offset); // fits: `zstdCompressSync()` output never exceeds `zstdCompressBound()`
	return data.length;
}

/**	The private-API path: create the same engine that `deflateSync()` (or `zstdCompressSync()`) creates, point its output buffer at `out`,
	and process the whole input (`chunkSize: 64` == Z_MIN_CHUNK, so the engine's own output buffer, that i then substitute, is as small as possible).
	`_processChunk()` with the "finish" flush flag and enough output space compresses to `_outBuffer` at `_outOffset`, and returns the written part
	as a `Buffer` view, so verifying that the result is a view into `out` at `offset` proves that no reallocation or copying took place.
 **/
function compressIntoPrivate(engine: Any, finishFlushFlag: number, out: Uint8Array, offset: number, part: Uint8Array)
{	engine._outBuffer = Buffer.from(out.buffer, out.byteOffset, out.byteLength);
	engine._outOffset = offset;
	engine._chunkSize = out.byteLength; // the available space is `_chunkSize - _outOffset`
	const data: Buffer = engine._processChunk(part, finishFlushFlag);
	if (data.buffer!==out.buffer || data.byteOffset!==out.byteOffset+offset)
	{	throw new Error('The private API of node:zlib behaved unexpectedly');
	}
	return data.length;
}

/**	Check that the private-API path produces a correct compressed stream at the requested position, without touching the bytes before it.
 **/
function probeWith(compress: (out: Uint8Array, offset: number, input: Uint8Array) => number, decompress: (data: Uint8Array) => Uint8Array, bound: (len: number) => number)
{	try
	{	const input = new Uint8Array(300);
		for (let i=0; i<input.length; i++)
		{	input[i] = i & 0x3F;
		}
		const out = new Uint8Array(7 + bound(input.length) + 1).fill(0xEE);
		const len = compress(out, 7, input);
		const restored = decompress(out.subarray(7, 7+len));
		return len>0 && len<input.length && out.subarray(0, 7).every(b => b == 0xEE) && restored.length==input.length && restored.every((b, i) => b == input[i]);
	}
	catch
	{	return false;
	}
}

function probePrivateApi()
{	return probeWith
	(	(out, offset, input) => compressIntoPrivate(createDeflate({chunkSize: 64}), constants.Z_FINISH, out, offset, input),
		data => inflateSync(data),
		deflateBound
	);
}

function probeZstdPrivateApi()
{	return probeWith
	(	(out, offset, input) => compressIntoPrivate(createZstdCompress({chunkSize: 64, params: {[ZSTD_C_COMPRESSION_LEVEL]: ZSTD_DEFAULT_LEVEL}}), ZSTD_E_END, out, offset, input),
		data => zstdDecompressSync(data),
		zstdCompressBound
	);
}
