import {convColumnValue} from '../conv_column_value.ts';
import {MysqlType, Charset} from '../constants.ts';
import {assertEquals} from 'jsr:@std/assert@1.0.19/equals';

const decoder = new TextDecoder;
const encoder = new TextEncoder;
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

Deno.test
(	'DOUBLE and FLOAT text values parse with correct rounding',
	() =>
	{	// Manual digit accumulation was not correctly rounded (~35% of doubles came back 1+ ULP off, e.g. '6.52e0' → 6.5200000000000005),
		// and underflowed to 0 for exponents ≤ -323.
		assertEquals(convColumnValue(encoder.encode('6.52e0'), MysqlType.MYSQL_TYPE_DOUBLE, Charset.BINARY, decoder, false, false, false, tz), 6.52);
		assertEquals(convColumnValue(encoder.encode('6.52'), MysqlType.MYSQL_TYPE_DOUBLE, Charset.BINARY, decoder, false, false, false, tz), 6.52);
		assertEquals(convColumnValue(encoder.encode('-6.52'), MysqlType.MYSQL_TYPE_DOUBLE, Charset.BINARY, decoder, false, false, false, tz), -6.52);
		assertEquals(convColumnValue(encoder.encode('2.2250738585072014e-308'), MysqlType.MYSQL_TYPE_DOUBLE, Charset.BINARY, decoder, false, false, false, tz), 2.2250738585072014e-308); // DBL_MIN must not underflow to 0
		assertEquals(convColumnValue(encoder.encode('5e-324'), MysqlType.MYSQL_TYPE_DOUBLE, Charset.BINARY, decoder, false, false, false, tz), 5e-324); // the smallest subnormal
		assertEquals(convColumnValue(encoder.encode('1.7976931348623157e308'), MysqlType.MYSQL_TYPE_DOUBLE, Charset.BINARY, decoder, false, false, false, tz), 1.7976931348623157e308); // DBL_MAX
		assertEquals(convColumnValue(encoder.encode('-1.25E-2'), MysqlType.MYSQL_TYPE_DOUBLE, Charset.BINARY, decoder, false, false, false, tz), -0.0125);
		assertEquals(convColumnValue(encoder.encode('314.159'), MysqlType.MYSQL_TYPE_FLOAT, Charset.BINARY, decoder, false, false, false, tz), 314.159);
		assertEquals(convColumnValue(encoder.encode('0'), MysqlType.MYSQL_TYPE_DOUBLE, Charset.BINARY, decoder, false, false, false, tz), 0);
	}
);
