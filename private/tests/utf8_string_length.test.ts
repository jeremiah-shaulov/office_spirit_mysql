import {utf8StringLength} from '../utf8_string_length.ts';
import {assertEquals} from 'jsr:@std/assert@1.0.7/equals';

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
