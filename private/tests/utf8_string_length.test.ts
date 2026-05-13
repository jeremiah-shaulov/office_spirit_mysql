import {utf8StringLength} from '../utf8_string_length.ts';
import {assertEquals} from 'jsr:@std/assert@1.0.19/equals';

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

Deno.test
(	'Unpaired surrogates',
	() =>
	{	const encoder = new TextEncoder;

		const strs =
		[	'\uD800',           // lone high surrogate
			'\uDC00',           // lone low surrogate
			'\uD800a',          // lone high surrogate + ASCII
			'\uD800Ы',          // lone high surrogate + 2-byte char
			'\uD800א',     // lone high surrogate + 2-byte char (Hebrew aleph)
			'\uD800\uD800',     // two lone high surrogates
			'\uD800😁', // lone high surrogate + valid pair (emoji)
			'a\uD800b',         // ASCII + lone high surrogate + ASCII
			'😁\uD800', // valid pair + trailing lone high surrogate
		];

		for (const str of strs)
		{	assertEquals(utf8StringLength(str), encoder.encode(str).length, `Failed for ${JSON.stringify(str)}`);
		}
	}
);
