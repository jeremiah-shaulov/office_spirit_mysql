import {utf8StringLength} from '../utf8_string_length.ts';
import {assertEquals} from "https://deno.land/std@0.192.0/testing/asserts.ts";

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

		for (const str of strs)
		{	assertEquals(utf8StringLength(str), encoder.encode(str).length);
		}
	}
);
