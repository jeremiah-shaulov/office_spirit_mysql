import {parseNumericTimezoneOffset, systemMsecOffsetAt, timezoneMsecOffsetAt} from '../get_timezone_msec_offset_from_system.ts';
import {assert} from 'jsr:@std/assert@1.0.19/assert';
import {assertEquals} from 'jsr:@std/assert@1.0.19/equals';
import {assertThrows} from 'jsr:@std/assert@1.0.19/throws';

const HOUR = 3600000;

Deno.test
(	'parseNumericTimezoneOffset',
	() =>
	{	assertEquals(parseNumericTimezoneOffset('+05:30'), 5.5*HOUR);
		assertEquals(parseNumericTimezoneOffset('-08:00'), -8*HOUR);
		assertEquals(parseNumericTimezoneOffset('+0:00'), 0);
		assertEquals(parseNumericTimezoneOffset('-0:00'), 0);
		assertEquals(parseNumericTimezoneOffset('+10:45'), 10.75*HOUR);
		assertEquals(parseNumericTimezoneOffset('SYSTEM'), undefined);
		assertEquals(parseNumericTimezoneOffset('Europe/London'), undefined);
		assertEquals(parseNumericTimezoneOffset(''), undefined);
		assertEquals(parseNumericTimezoneOffset('+5'), undefined);
	}
);

Deno.test
(	'timezoneMsecOffsetAt depends on the value date (DST)',
	() =>
	{	// Absolute UTC offsets - machine-independent
		const january = Date.UTC(2024, 0, 15, 12, 0, 0);
		const july = Date.UTC(2024, 6, 15, 12, 0, 0);
		assertEquals(timezoneMsecOffsetAt('America/New_York', january), -5*HOUR); // EST
		assertEquals(timezoneMsecOffsetAt('America/New_York', july), -4*HOUR); // EDT - the whole point of computing per value date
		assertEquals(timezoneMsecOffsetAt('Europe/London', january), 0);
		assertEquals(timezoneMsecOffsetAt('Europe/London', july), 1*HOUR);
		assertEquals(timezoneMsecOffsetAt('Asia/Kolkata', january), 5.5*HOUR); // no DST
		assertEquals(timezoneMsecOffsetAt('Asia/Kolkata', july), 5.5*HOUR);
		assertEquals(timezoneMsecOffsetAt('UTC', january), 0);
		// Around a DST transition: America/New_York sprang forward on 2024-03-10 at 07:00 UTC
		assertEquals(timezoneMsecOffsetAt('America/New_York', Date.UTC(2024, 2, 10, 6, 59, 0)), -5*HOUR);
		assertEquals(timezoneMsecOffsetAt('America/New_York', Date.UTC(2024, 2, 10, 7, 1, 0)), -4*HOUR);
		// Unknown zone names throw
		assertThrows(() => timezoneMsecOffsetAt('No/Such_Zone', january), RangeError);
	}
);

Deno.test
(	'systemMsecOffsetAt matches the Date API sign convention',
	() =>
	{	// East of UTC is positive (getTimezoneOffset() returns minutes west, so the sign flips)
		const now = Date.now();
		assertEquals(systemMsecOffsetAt(now), -new Date(now).getTimezoneOffset()*60000);
		// If the system zone has DST, January and July offsets differ; either way each must match the Date API for its own instant
		const january = Date.UTC(2024, 0, 15);
		const july = Date.UTC(2024, 6, 15);
		assertEquals(systemMsecOffsetAt(january), -new Date(january).getTimezoneOffset()*60000);
		assertEquals(systemMsecOffsetAt(july), -new Date(july).getTimezoneOffset()*60000);
		assert(Number.isFinite(systemMsecOffsetAt(january)));
	}
);
