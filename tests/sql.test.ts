import {MyPool, sql} from '../mod.ts';
import {assert, assertEquals} from "https://deno.land/std@0.97.0/testing/asserts.ts";
import {SqlPolicy} from '../sql_policy.ts';

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

		assertEquals(sql`'${-1234n}' * '${-0.1}'` + '', `-1234 * -0.1`);

		assertEquals(sql`'${null}'` + '', `NULL`);
		assertEquals(sql`'${undefined}'` + '', `NULL`);
		assertEquals(sql`'${() => {}}'` + '', `NULL`);
		assertEquals(sql`'${Symbol.asyncIterator}'` + '', `NULL`);

		assertEquals(sql`'${true}'` + '', `TRUE`);
		assertEquals(sql`'${false}'` + '', `FALSE`);

		assertEquals(sql`'${new Uint8Array([1, 2, 3, 4])}'` + '', `x'01020304'`);

		assertEquals(sql`'${new Date(2000, 0, 3)}'` + '', `'2000-01-03'`);
		assertEquals(sql`'${new Date(2000, 0, 13, 0, 0, 0, 10)}'` + '', `'2000-01-13 00:00:00.010'`);
		assertEquals(sql`'${new Date(2000, 11, 20, 0, 12, 45)}'` + '', `'2000-12-20 00:12:45'`);
		assertEquals(sql`'${new Date(1970, 0, 31, 11, 2, 5, 7)}'` + '', `'1970-01-31 11:02:05.007'`);
		assertEquals(sql`'${new Date(2000, 0, 31, 22, 2, 5, 100)}'` + '', `'2000-01-31 22:02:05.100'`);

		assertEquals(sql`'${new Uint8Array([1, 2, 10, 254])}'` + '', `x'01020AFE'`);

		assertEquals(sql`"${null}"` + '', '`null`');
		assertEquals(sql`"${'One"Two"'}"` + '', '`One"Two"`');
		assertEquals(sql`"${'One`Two`'}"` + '', '`One``Two```');

		assertEquals(sql`"${'ф'.repeat(100)}"` + '', '`'+'ф'.repeat(100)+'`'); // many 2-byte chars cause buffer of guessed size to realloc

		let s = sql`фффффффффффффффффффффффффффффф "${'``'}"`;
		assertEquals(s+'', "фффффффффффффффффффффффффффффф ``````");

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

		error = undefined;
		try
		{	sql`'${1}"`.toString();
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, `Inappropriately quoted parameter`);
	}
);

Deno.test
(	'SQL exprs',
	async () =>
	{	let expr = `The string: 'It''s string \\'`;
		let s = sql`A.(${expr}).B`;
		assertEquals(s+'', `A.(\`The\` \`string\`: 'It''s string \\\\').B`);
		assertEquals(s.toString(true), `A.(\`The\` \`string\`: 'It''s string \\').B`);

		expr = `EXISTS(SELECT 1)`;
		s = sql`SELECT (${expr})`;
		assertEquals(s+'', `SELECT (EXISTS(\`SELECT\` 1))`);
		assertEquals(s.toString(true), `SELECT (EXISTS(\`SELECT\` 1))`);

		s.sqlPolicy = new SqlPolicy(undefined, '!EXISTS');
		assertEquals(s+'', `SELECT (\`EXISTS\`(\`SELECT\` 1))`);
		s.sqlPolicy = new SqlPolicy('on select', '!EXISTS');
		assertEquals(s+'', `SELECT (\`EXISTS\`(SELECT 1))`);

		expr = `EXISTS(SELECT (1))`;
		s = sql`SELECT (${expr})`;
		assertEquals(s+'', `SELECT (EXISTS(\`SELECT\` (1)))`);
		s.sqlPolicy = new SqlPolicy(undefined, '!HELLO');
		assertEquals(s+'', `SELECT (EXISTS(SELECT( 1)))`);

		expr = `Count (*)`;
		s = sql`SELECT (${expr})`;
		assertEquals(s+'', `SELECT (Count( *))`);
		s.sqlPolicy = new SqlPolicy(undefined, '!Count');
		assertEquals(s+'', `SELECT (\`Count\` (*))`);

		expr = "id=10 AND value IS NOT NULL";
		s = sql`SELECT '${null}' (${expr})`;
		assertEquals(s+'', `SELECT NULL (\`id\`=10 AND \`value\` IS NOT NULL)`);

		expr = `name AND Count(*)`;
		s = sql`SELECT (${expr})`;
		s.sqlPolicy = new SqlPolicy('and');
		assertEquals(s+'', `SELECT (\`name\` AND Count(*))`);
		s.sqlPolicy = new SqlPolicy('', 'count');
		assertEquals(s+'', `SELECT (\`name\` \`AND\` Count(*))`);
		s.sqlPolicy = new SqlPolicy('name', 'count');
		assertEquals(s+'', `SELECT (name \`AND\` Count(*))`);
		s.sqlPolicy = new SqlPolicy('name', '');
		assertEquals(s+'', `SELECT (name \`AND\` \`Count\`(*))`);
		s.sqlPolicy = new SqlPolicy('!name');
		assertEquals(s+'', `SELECT (\`name\` AND Count(*))`);

		expr = `name AND \`Count\`(*)`;
		s = sql`SELECT (${expr})`;
		assertEquals(s+'', `SELECT (\`name\` AND \`Count\`(*))`);

		expr = `name AND "Count"(*)`;
		s = sql`SELECT (${expr})`;
		assertEquals(s+'', `SELECT (\`name\` AND \`Count\`(*))`);

		expr = `name AND \`Count(\`\`*\`\`)\`(*)`;
		s = sql`SELECT (${expr})`;
		assertEquals(s+'', `SELECT (\`name\` AND \`Count(\`\`*\`\`)\`(*))`);

		expr = `name AND "Count(""*"")"(*)`;
		s = sql`SELECT (${expr})`;
		assertEquals(s+'', `SELECT (\`name\` AND \`Count("*")\`(*))`);

		s = sql`SELECT (${'"The `90s"'})`;
		assertEquals(s+'', "SELECT (`The ``90s`)");

		let error;
		try
		{	'' + sql`SELECT (${`A ' B`})`;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, `Invalid SQL fragment: A ' B`);

		error = undefined;
		try
		{	'' + sql`SELECT (${`A -- B`})`;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, `Comment in SQL fragment: A -- B`);

		error = undefined;
		try
		{	'' + sql`SELECT (${`A # B`})`;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, `Comment in SQL fragment: A # B`);

		error = undefined;
		try
		{	'' + sql`SELECT (${`A /* B`})`;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, `Comment in SQL fragment: A /* B`);

		error = undefined;
		try
		{	'' + sql`SELECT (${`Char_length(@var)`})`;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, `Invalid character in SQL fragment: Char_length(@var)`);

		error = undefined;
		try
		{	'' + sql`SELECT (${`10/3; DROP ALL`})`;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, `Invalid character in SQL fragment: 10/3; DROP ALL`);

		error = undefined;
		try
		{	'' + sql`SELECT (${`name[0`})`;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, `Invalid character in SQL fragment: name[0`);

		error = undefined;
		try
		{	'' + sql`SELECT (${`0]`})`;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, `Invalid character in SQL fragment: 0]`);

		error = undefined;
		try
		{	'' + sql`SELECT (${`name{0`})`;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, `Invalid character in SQL fragment: name{0`);

		error = undefined;
		try
		{	'' + sql`SELECT (${`0}`})`;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, `Invalid character in SQL fragment: 0}`);

		error = undefined;
		try
		{	'' + sql`SELECT (${`Count(* + 1`})`;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, `Unbalanced parenthesis in SQL fragment: Count(* + 1`);

		error = undefined;
		try
		{	'' + sql`SELECT (${`Count(*) - 1)`})`;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, `Unbalanced parenthesis in SQL fragment: Count(*) - 1)`);

		error = undefined;
		try
		{	'' + sql`SELECT (${`name, Count(*)`})`;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, `Comma in SQL fragment: name, Count(*)`);

		assertEquals('' + sql`SELECT (${`Count(name, "value")`})`, `SELECT (Count(\`name\`, \`value\`))`);
	}
);

