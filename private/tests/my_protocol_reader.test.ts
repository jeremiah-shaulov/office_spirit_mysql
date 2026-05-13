import {MyProtocolReader} from '../my_protocol_reader.ts';
import {ServerDisconnectedError} from '../errors.ts';
import {assert} from 'jsr:@std/assert@1.0.19/assert';

// deno-lint-ignore no-explicit-any
type Any = any;

const MAX_ALLOWED_CALLS = 20;

/**	A duck-typed `ReadableStreamBYOBReader` that always fulfils a read with
	`{value: zero-length view, done: false}`. Spec-conformant byte sources should
	never do this, but mis-behaving wrappers can — and the protocol reader must
	not spin if they do.
 **/
class ZeroByteByobReader
{	calls = 0;

	read(view: Uint8Array<ArrayBufferLike>): Promise<{value: Uint8Array<ArrayBufferLike>, done: boolean}>
	{	this.calls++;
		if (this.calls > MAX_ALLOWED_CALLS)
		{	// Bail out before the test runner spends seconds spinning. If the
			// protocol reader is well-behaved it should have thrown long before
			// this point.
			throw new Error(`Reader was called ${this.calls} times without progress — protocol-reader loop is spinning`);
		}
		const empty = new Uint8Array(view.buffer, view.byteOffset, 0);
		return Promise.resolve({value: empty, done: false});
	}

	releaseLock() {}
}

class TestReader extends MyProtocolReader
{	async exposedReadPacketHeaderAsync()
	{	await this.readPacketHeaderAsync();
	}
}

Deno.test
(	'Zero-byte BYOB read throws instead of spinning the reader loop',
	async () =>
	{	const mock = new ZeroByteByobReader;
		const buf = new Uint8Array(8*1024);
		const reader = new TestReader(mock as Any, new TextDecoder, buf);

		let caught: unknown;
		try
		{	await reader.exposedReadPacketHeaderAsync();
		}
		catch (e)
		{	caught = e;
		}

		assert(caught instanceof ServerDisconnectedError, `expected ServerDisconnectedError, got ${caught?.constructor?.name}: ${(caught as Error)?.message}`);
	}
);
