import {SendWithDataError, SUSPECT_PACKET_ERROR_IF_PACKET_SIZE} from '../errors.ts';
import {assert, assertEquals} from "https://deno.land/std@0.192.0/testing/asserts.ts";

Deno.test
(	'Packet error message',
	() =>
	{	let e = new SendWithDataError('Hello', SUSPECT_PACKET_ERROR_IF_PACKET_SIZE-1);
		assertEquals(e.message, 'Hello');

		e = new SendWithDataError('Hello', SUSPECT_PACKET_ERROR_IF_PACKET_SIZE);
		assert(e.message.startsWith('Hello - '));
	}
);
