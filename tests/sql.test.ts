import {MyPool, sql, Sql} from '../mod.ts';
import {SqlPolicy} from '../sql_policy.ts';
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

		let s = sql`фффффффффффффффффффффффффффффффффффффф "${'``'}"`;
		assertEquals(s+'', "фффффффффффффффффффффффффффффффффффффф ``````");

		// json
		try
		{	pool.forConn
			(	async (conn) =>
				{	const value = {a: 1, b: 'the b'};
					const got_value = await conn.queryCol(sql`SELECT '${value}' AS v`).first();
					assertEquals(typeof(got_value)=='string' ? JSON.parse(got_value) : undefined, value);
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
(	'SQL (${param})',
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

		expr = `name AND \`Count\`(*) OR Sum(a=1)>10`;
		s = sql`SELECT (ta.${expr})`;
		assertEquals(s+'', "SELECT (`ta`.name AND `Count`(*) OR Sum(`ta`.a=1)>10)");

		expr = `"name" AND "Count"(*) OR Sum(\`a\` = 1)>10`;
		s = sql`SELECT (ta.${expr})`;
		assertEquals(s+'', "SELECT (`ta`.`name` AND `Count`(*) OR Sum(`ta`.`a` = 1)>10)");

		let error;
		try
		{	'' + sql`SELECT (${`A ' B`})`;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, `Unterminated string literal in SQL fragment: A ' B`);

		error = undefined;
		try
		{	'' + sql`SELECT (${"A ` B"})`;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, "Unterminated quoted identifier in SQL fragment: A ` B");

		error = undefined;
		try
		{	'' + sql`SELECT (${`'abc'"def`})`;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, `Unterminated quoted identifier in SQL fragment: 'abc'"def`);

		error = undefined;
		try
		{	'' + sql`SELECT (${`"abc"(def`})`;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, `Unbalanced parenthesis in SQL fragment: "abc"(def`);

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

		error = undefined;
		try
		{	'' + sql`SELECT "${null})`;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, `Inappropriately quoted parameter`);

		error = undefined;
		try
		{	'' + sql`SELECT \`${null})`;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, `Inappropriately quoted parameter`);

		error = undefined;
		try
		{	'' + sql`SELECT [${null})`;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, `Inappropriately enclosed parameter`);

		error = undefined;
		try
		{	'' + sql`SELECT [${null}]`;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'In SQL fragment: parameter for [${...}] must be iterable');

		error = undefined;
		try
		{	'' + sql`SELECT <${null})`;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, `Inappropriately enclosed parameter`);

		error = undefined;
		try
		{	'' + sql`SELECT <${null}>`;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'In SQL fragment: parameter for <${...}> must be iterable');

		error = undefined;
		try
		{	'' + sql`SELECT {${null})`;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, `Inappropriately enclosed parameter`);

		error = undefined;
		try
		{	'' + sql`SELECT {${null}}`;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'In SQL fragment: parameter for {${...}} must be object');

		error = undefined;
		try
		{	'' + sql`SELECT (${`name, Count(*)`}`;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, `Inappropriately enclosed parameter`);

		assertEquals('' + sql`SELECT (${`Count(name, "value")`})`, `SELECT (Count(\`name\`, \`value\`))`);

		expr = `a.and and b. or or c .col_1_ф`;
		s = sql`SELECT (${expr})`;
		assertEquals(s+'', "SELECT (`a`.and and `b`. or or `c` .col_1_ф)");

		expr = `select(col)`;
		s = sql`SELECT (al.${expr})`;
		assertEquals(s+'', "SELECT (`select`(`al`.col))");

		expr = `"a\`b"`;
		s = sql`SELECT (al.${expr})`;
		assertEquals(s+'', "SELECT (`al`.`a``b`)");

		expr = `"a\`b"`;
		let alias = 'the_alias';
		s = sql`SELECT (${alias}.${expr})`;
		assertEquals(s+'', "SELECT (`the_alias`.`a``b`)");

		expr = `"a\`b"`;
		alias = '';
		s = sql`SELECT (${alias}.${expr})`;
		assertEquals(s+'', "SELECT (`a``b`)");
	}
);

Deno.test
(	'SQL ${param}',
	async () =>
	{	let expr = `The string: 'It''s string \\'`;
		let s = sql`A-${expr}-B`;
		assertEquals(s+'', `A-\`The\` \`string\`: 'It''s string \\\\'-B`);
		assertEquals(s.toString(true), `A-\`The\` \`string\`: 'It''s string \\'-B`);

		expr = "col1, `col2`, 3.0";
		s = sql`A-${expr}-B`;
		assertEquals(s+'', "A-`col1`, `col2`, 3.0-B");

		expr = "col1, `col2`, 3.0";
		s = sql`A-tab.${expr}-B`;
		assertEquals(s+'', "A-`tab`.col1, `tab`.`col2`, 3.0-B");

		expr = "col1, `col2`, 3.0, fn()";
		let alias = 'the_alias';
		let alias_2 = 'the_alias 2!';
		s = sql`A-${alias}.${expr}-${alias_2}.${expr}-B`;
		assertEquals(s+'', "A-`the_alias`.col1, `the_alias`.`col2`, 3.0, fn()-`the_alias 2!`.col1, `the_alias 2!`.`col2`, 3.0, fn()-B");

		expr = "col1, `col2`, 3.0, fn()";
		alias = '';
		s = sql`A-${alias}.${expr}-B`;
		assertEquals(s+'', "A-`col1`, `col2`, 3.0, fn()-B");

		let error;
		try
		{	'' + sql`A-${null}.${expr}-B`;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, "Alias must be string");
	}
);

Deno.test
(	'SQL [${param}]',
	async () =>
	{	let list = [12.5, 'ABC\'D\'EF', new Date(2000, 0, 1)];
		let s = sql`A[${list}]B`;
		assertEquals(s+'', `A(12.5,'ABC''D''EF','2000-01-01')B`);

		let list_2 = [[12.5, 13], ['ABC\'D\'EF'], new Date(2000, 0, 1)];
		s = sql`A[${list_2}]B`;
		assertEquals(s+'', `A((12.5,13),('ABC''D''EF'),'2000-01-01')B`);

		s = sql`A[${[]}]B`;
		assertEquals(s+'', `A(NULL)B`);

		let list_3 = [[1, {}, () => {}]];
		s = sql`A[${list_3}]B`;
		assertEquals(s+'', `A((1,NULL,NULL))B`);
	}
);

Deno.test
(	'SQL put_params_to',
	async () =>
	{	let value = "Message 1";
		let s = sql`A'${value}'B`;
		let put_params_to: any[] = [];
		assertEquals(s.toString(false, put_params_to), `A?B`);
		assertEquals(put_params_to, [value]);
	}
);

Deno.test
(	'Sql.concat()',
	async () =>
	{	let s = sql`A, '${'B'}', C`;
		s = s.concat(sql`, '${'D'}'`).concat(sql`.`).concat(sql``);
		assertEquals(s+'', `A, 'B', C, 'D'.`);
	}
);

Deno.test
(	'SQL <${param}>',
	async () =>
	{	let rows =
		[	{value: 10, name: 'text 1'},
			{value: 11, name: 'text 2', junk: 'j'},
		];
		let s = sql`INSERT INTO t_log <${rows}>`;
		assertEquals(s+'', "INSERT INTO t_log (`value`, `name`) VALUES\n(10,'text 1'),\n(11,'text 2')");

		let error;
		try
		{	'' + sql`INSERT INTO t_log <${[{}]}>`;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, "No fields for <${param}>");
	}
);

Deno.test
(	'SQL {${param}}',
	async () =>
	{	let row = {a: 10, val: 'text 1'};
		let s = sql`SET {${row}}`;
		assertEquals(s+'', "SET `a`=10, `val`='text 1'");

		row = {a: 10, val: 'text 1'};
		s = sql`SET {ta.${row}}`;
		assertEquals(s+'', "SET `ta`.`a`=10, `ta`.`val`='text 1'");

		row = {a: 10, val: 'text 1'};
		s = sql`SET {${row},}`;
		assertEquals(s+'', "SET `a`=10, `val`='text 1',");

		row = {a: 10, val: 'text 1'};
		s = sql`SET {ta.${row},}`;
		assertEquals(s+'', "SET `ta`.`a`=10, `ta`.`val`='text 1',");

		let error;
		try
		{	'' + sql`SET {${{}}}`;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, "In SQL fragment: 0 values for {${...}}");

		let row_2 = {};
		s = sql`SET {ta.${row_2},}`;
		assertEquals(s+'', "SET ");

		row = {a: 10, val: 'text 1'};
		s = sql`SET {ta.${row}&}`;
		assertEquals(s+'', "SET (`ta`.`a`=10 AND `ta`.`val`='text 1')");

		row = {a: 10, val: 'text 1'};
		s = sql`SET {ta.${row}|}`;
		assertEquals(s+'', "SET (`ta`.`a`=10 OR `ta`.`val`='text 1')");

		row = {a: 10, val: 'text 1'};
		s = sql`SET {ta.${row}|} SET {tab.${row}|}`;
		assertEquals(s+'', "SET (`ta`.`a`=10 OR `ta`.`val`='text 1') SET (`tab`.`a`=10 OR `tab`.`val`='text 1')");

		row_2 = {};
		s = sql`SET {ta.${row_2}&}`;
		assertEquals(s+'', "SET TRUE");

		row_2 = {};
		s = sql`SET {ta.${row_2}|}`;
		assertEquals(s+'', "SET FALSE");
	}
);

Deno.test
(	'SQL Sql.quote()',
	async () =>
	{	assertEquals(Sql.quote(null), "NULL");
		assertEquals(Sql.quote(false), "FALSE");
		assertEquals(Sql.quote(true), "TRUE");
		assertEquals(Sql.quote(0.0), "0");
		assertEquals(Sql.quote(12.5), "12.5");
		assertEquals(Sql.quote(-13n), "-13");
		assertEquals(Sql.quote("Message 'One'"), "'Message ''One'''");
		assertEquals(Sql.quote("This char \\ is backslash"), "'This char \\\\ is backslash'");
		assertEquals(Sql.quote(new Date(2000, 0, 1)), "2000-01-01");
		assertEquals(Sql.quote(new Date(2000, 0, 1, 2)), "2000-01-01 02:00:00");
		assertEquals(Sql.quote(new Date(2000, 0, 1, 2, 3, 4, 567)), "2000-01-01 02:03:04.567");
		assertEquals(Sql.quote(new Uint8Array([1, 2, 254, 255])), "x'0102FEFF'");
		assertEquals(Sql.quote([{id: 10, value: 'Val 10'}]), `'[{"id":10,"value":"Val 10"}]'`);

		let error;
		try
		{	Sql.quote({async read() {}});
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, "Cannot stringify Deno.Reader");
	}
);

Deno.test
(	'SQL Sql.tables',
	async () =>
	{	let s = Sql.tables['Hello `All`!'].where("id=1").select("col1*2, Count(*)");
		assertEquals(s+'', "SELECT `col1`*2, Count(*) FROM `Hello ``All``!` WHERE (`id`=1)");

		s = Sql.tables['Hello `All`!'].where("").select("col1*2, Count(*)");
		assertEquals(s+'', "SELECT `col1`*2, Count(*) FROM `Hello ``All``!`");

		let error;
		try
		{	Sql.tables['Hello `All`!'].select("col1*2, Count(*)");
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, "Please, call where() first");

		error = undefined;
		try
		{	Sql.tables[Symbol.iterator as any];
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, "Table name must be a string");

		let table = Sql.tables.t_log.where('id IN (1, 2)');

		s = table.where("name <> ''").select("col1*2, Count(*)");
		assertEquals(s+'', "SELECT `col1`*2, Count(*) FROM `t_log` WHERE (`id` IN( 1, 2)) AND (`name` <> '')");

		error = undefined;
		try
		{	table.join('hello');
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, "join() can be called before where()");

		error = undefined;
		try
		{	Sql.tables.t_log.join('_base_table');
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, `Alias "_base_table" is reserved`);

		error = undefined;
		try
		{	Sql.tables.t_log.left_join('a', 'aa', '');
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, `No condition in LEFT JOIN`);

		s = Sql.tables.t_log.join('meta', 'm', 'meta_id = m.id').where("").select("col1*2, Count(*)");
		assertEquals(s+'', "SELECT `t`.col1*2, Count(*) FROM `t_log` AS `t` INNER JOIN `meta` AS `m` ON (`t`.meta_id = `m`.id)");

		s = Sql.tables.t_log.join('meta', '', 'meta_id = meta.id').where("").select("col1*2, Count(*)");
		assertEquals(s+'', "SELECT `t`.col1*2, Count(*) FROM `t_log` AS `t` INNER JOIN `meta` ON (`t`.meta_id = `meta`.id)");

		s = Sql.tables.t_log.left_join('meta', 'm', 'meta_id = m.id').where("").select("col1*2, Count(*)");
		assertEquals(s+'', "SELECT `t`.col1*2, Count(*) FROM `t_log` AS `t` LEFT JOIN `meta` AS `m` ON (`t`.meta_id = `m`.id)");

		s = Sql.tables.t_log.left_join('meta', '', 'meta_id = meta.id').where("").select("col1*2, Count(*)");
		assertEquals(s+'', "SELECT `t`.col1*2, Count(*) FROM `t_log` AS `t` LEFT JOIN `meta` ON (`t`.meta_id = `meta`.id)");

		s = Sql.tables.t_log.left_join('meta', 't', 'meta_id = t.id').where("").select("col1*2, Count(*)");
		assertEquals(s+'', "SELECT `base`.col1*2, Count(*) FROM `t_log` AS `base` LEFT JOIN `meta` AS `t` ON (`base`.meta_id = `t`.id)");

		s = Sql.tables.t_log.join('t').join('base').where("").select();
		assertEquals(s+'', "SELECT * FROM `t_log` AS `base_table` CROSS JOIN `t` CROSS JOIN `base`");

		s = Sql.tables.t_log.join('t').join('base').join('hello', 'base_table').where("").select();
		assertEquals(s+'', "SELECT * FROM `t_log` AS `_base_table` CROSS JOIN `t` CROSS JOIN `base` CROSS JOIN `hello` AS `base_table`");

		s = Sql.tables.t_log.where("").select("col1*2, Count(*)", "position_major DESC, position_minor");
		assertEquals(s+'', "SELECT `col1`*2, Count(*) FROM `t_log` ORDER BY `position_major` DESC, `position_minor`");
	}
);
