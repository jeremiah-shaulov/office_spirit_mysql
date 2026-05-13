import {convColumnValue} from '../conv_column_value.ts';
import {MysqlType, Charset} from '../constants.ts';
import {assertEquals} from 'jsr:@std/assert@1.0.19/equals';

const decoder = new TextDecoder;
const tz = {getTimezoneMsecOffsetFromSystem: () => 0};

Deno.test
(	'BIT type with single-byte value',
	() =>
	{	// BIT(1..8): values stored in 1 byte
		assertEquals(convColumnValue(new Uint8Array([0]), MysqlType.MYSQL_TYPE_BIT, Charset.BINARY, decoder, false, false, false, tz), false);
		assertEquals(convColumnValue(new Uint8Array([1]), MysqlType.MYSQL_TYPE_BIT, Charset.BINARY, decoder, false, false, false, tz), true);
		assertEquals(convColumnValue(new Uint8Array([0xFF]), MysqlType.MYSQL_TYPE_BIT, Charset.BINARY, decoder, false, false, false, tz), true);
	}
);

Deno.test
(	'BIT type with multi-byte value',
	() =>
	{	// BIT(9..16): values stored in 2 bytes (big-endian).
		// All-zero → false
		assertEquals(convColumnValue(new Uint8Array([0, 0]), MysqlType.MYSQL_TYPE_BIT, Charset.BINARY, decoder, false, false, false, tz), false);
		// Value 1 → bytes [0x00, 0x01] → must be true
		assertEquals(convColumnValue(new Uint8Array([0, 1]), MysqlType.MYSQL_TYPE_BIT, Charset.BINARY, decoder, false, false, false, tz), true);
		// Value 256 → bytes [0x01, 0x00] → must be true
		assertEquals(convColumnValue(new Uint8Array([1, 0]), MysqlType.MYSQL_TYPE_BIT, Charset.BINARY, decoder, false, false, false, tz), true);
		// 4-byte BIT(32) with low bit set → must be true
		assertEquals(convColumnValue(new Uint8Array([0, 0, 0, 1]), MysqlType.MYSQL_TYPE_BIT, Charset.BINARY, decoder, false, false, false, tz), true);
		// 4-byte BIT(32) all zero → false
		assertEquals(convColumnValue(new Uint8Array([0, 0, 0, 0]), MysqlType.MYSQL_TYPE_BIT, Charset.BINARY, decoder, false, false, false, tz), false);
	}
);
