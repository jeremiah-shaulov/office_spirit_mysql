import {MyPool, sql} from '../mod.ts';
import {assert, assertEquals} from "https://deno.land/std@0.97.0/testing/asserts.ts";

const {DSN} = Deno.env.toObject();

Deno.test
(	'Basic',
	async () =>
	{	let pool = new MyPool(DSN);

		assertEquals(sql`'${''}'` + '', `''`);
		assertEquals(sql`'${'A\nB'}'` + '', `'A\nB'`);
		assertEquals(sql`'${'A\\B'}'` + '', `'A\\\\B'`);
		assertEquals(sql`'${"A'B"}'` + '', `'A''B'`);

		assertEquals(sql`'${123.4}'` + '', `123.4`);

		assertEquals(sql`'${-1234n}'` + '', `-1234`);

		assertEquals(sql`'${null}'` + '', `NULL`);
		assertEquals(sql`'${undefined}'` + '', `NULL`);
		assertEquals(sql`'${() => {}}'` + '', `NULL`);
		assertEquals(sql`'${Symbol.asyncIterator}'` + '', `NULL`);

		assertEquals(sql`'${true}'` + '', `TRUE`);
		assertEquals(sql`'${false}'` + '', `FALSE`);

		assertEquals(sql`'${new Uint8Array([1, 2, 3, 4])}'` + '', `x'01020304'`);

		assertEquals(sql`'${new Date(2000, 0, 3)}'` + '', `'2000-01-03'`);
		assertEquals(sql`'${new Date(2000, 0, 3, 0, 12, 45)}'` + '', `'2000-01-03 00:12:45'`);
		assertEquals(sql`'${new Date(2000, 0, 3, 0, 12, 45, 7)}'` + '', `'2000-01-03 00:12:45.007'`);

		// json
		try
		{	pool.forConn
			(	async (conn) =>
				{	const value = {a: 1, b: 'the b'};
					assertEquals(JSON.parse(await conn.queryCol(sql`SELECT '${value}' AS v`).first()), value);
				}
			);
		}
		finally
		{	await pool.onEnd();
			pool.closeIdle();
		}

		let error;
		try
		{	sql`'${2n ** 64n}'`.toString();
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, `Cannot represent such bigint: ${2n ** 64n}`);

		error = undefined;
		try
		{	sql`'${{read() {}}}'`.toString();
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, `Cannot stringify Deno.Reader`);
	}
);
