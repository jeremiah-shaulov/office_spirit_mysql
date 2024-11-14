import {SendWithDataError, SUSPECT_PACKET_ERROR_IF_PACKET_SIZE} from '../errors.ts';
import {assert} from 'jsr:@std/assert@1.0.7/assert';
import {assertEquals} from 'jsr:@std/assert@1.0.7/equals';

Deno.test
(	'Packet error message',
	() =>
	{	let e = new SendWithDataError('Hello', SUSPECT_PACKET_ERROR_IF_PACKET_SIZE-1);
		assertEquals(e.message, 'Hello');

		e = new SendWithDataError('Hello', SUSPECT_PACKET_ERROR_IF_PACKET_SIZE);
		assert(e.message.startsWith('Hello - '));
	}
);
