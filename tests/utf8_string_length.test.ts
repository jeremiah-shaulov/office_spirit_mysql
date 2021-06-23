import {utf8_string_length} from '../utf8_string_length.ts';
import {assert, assertEquals} from "https://deno.land/std@0.97.0/testing/asserts.ts";

Deno.test
(	'Basic',
	() =>
	{	const encoder = new TextEncoder();

		const strs =
		[	'',
			'String',
			'Строка',
			'מחרוזת',
			'😁'
		];

		for (let str of strs)
		{	assertEquals(utf8_string_length(str), encoder.encode(str).length);
		}
	}
);
