import {convColumnValue} from '../conv_column_value.ts';
import {MysqlType, Charset} from '../constants.ts';
import {assert} from 'jsr:@std/assert@1.0.19/assert';
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

Deno.test
(	'DATE with year below 100, and zero dates',
	() =>
	{	// `new Date(year, ...)` maps years 0-99 to 1900-1999, so '0050-01-01' came back as 1950-01-01
		const d = convColumnValue(encoder.encode('0050-01-01'), MysqlType.MYSQL_TYPE_DATE, Charset.BINARY, decoder, false, false, false, tz);
		assert(d instanceof Date);
		assertEquals(d.getFullYear(), 50);
		assertEquals(d.getMonth(), 0);
		assertEquals(d.getDate(), 1);
		// Zero dates must return the same sentinel that the binary protocol returns: `new Date(0)`
		const zeroDate = convColumnValue(encoder.encode('0000-00-00'), MysqlType.MYSQL_TYPE_DATE, Charset.BINARY, decoder, false, false, false, tz);
		assert(zeroDate instanceof Date);
		assertEquals(zeroDate.getTime(), 0);
		const zeroDatetime = convColumnValue(encoder.encode('0000-00-00 00:00:00'), MysqlType.MYSQL_TYPE_DATETIME, Charset.BINARY, decoder, false, false, false, tz);
		assert(zeroDatetime instanceof Date);
		assertEquals(zeroDatetime.getTime(), 0);
		// A full datetime with fraction, in year 1
		const dt = convColumnValue(encoder.encode('0001-02-03 04:05:06.5'), MysqlType.MYSQL_TYPE_DATETIME, Charset.BINARY, decoder, false, false, false, tz);
		assert(dt instanceof Date);
		assertEquals(dt.getFullYear(), 1);
		assertEquals(dt.getMonth(), 1);
		assertEquals(dt.getDate(), 3);
		assertEquals(dt.getHours(), 4);
		assertEquals(dt.getMinutes(), 5);
		assertEquals(dt.getSeconds(), 6);
		assertEquals(dt.getMilliseconds(), 500);
	}
);
