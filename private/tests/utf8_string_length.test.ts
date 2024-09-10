import {utf8StringLength} from '../utf8_string_length.ts';
import {assertEquals} from 'https://deno.land/std@0.224.0/assert/assert_equals.ts';

Deno.test
(	'Basic',
	() =>
	{	const encoder = new TextEncoder;

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
