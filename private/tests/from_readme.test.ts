import {testWithDocker} from "./test_with_docker.ts";

const readmeUrl = new URL('../../README.md', import.meta.url);
const modUrl = new URL('../../mod.ts', import.meta.url);

Deno.env.set('DSN', Deno.env.get('TESTS_DSN') ?? '');
testWithDocker(await getTestsFromReadme(readmeUrl, modUrl));

async function getTestsFromReadme(readmeUrl: URL, modUrl: URL)
{	const tests = [];
	for (const [name, code] of await extractTestsFromReadme(readmeUrl, modUrl))
	{	const filename = await Deno.makeTempFile({suffix: `-${name}.ts`});
		try
		{	await Deno.writeTextFile(filename, code);
		}
		catch (e)
		{	await Deno.remove(filename);
			throw e;
		}
		const func = async function()
		{	try
			{	await import(filename);
			}
			finally
			{	await Deno.remove(filename);
			}
		};
		Object.defineProperty(func, 'name', {value: name, writable: false});
		tests.push(func);
	}
	return tests;
}

async function extractTestsFromReadme(readmeUrl: URL, modUrl: URL)
{	const result = new Map<string, string>;

	const readme = await Deno.readTextFile(readmeUrl);
	const libName = readme.match(/\n\/\/ curl ['"]?https:\/\/raw.githubusercontent.com\/[^\/]+\/([^\/]+)\/[v\d\.]+\/README.md\b/)?.[1];

	if (!libName)
	{	throw new Error(`Couldn't parse library name from README.md`);
	}

	const reBegin = /\n```ts[\r\n]+\/\/ To download and run this example:[ \t]*[\r\n]+/sg;
	const reName = /\n\/\/ deno run [^\r\n]*?([^\/]+)\.ts[ \t]*[\r\n]/;
	const reImport = new RegExp(`(\\nimport\\s*\\{[^}]+\\}\\s*from\\s*)['"\`]https://deno.land/x/${libName}@[^/]+/mod.ts['"\`]`, 'g');

	while (reBegin.test(readme))
	{	const from = reBegin.lastIndex;
		const to = readme.indexOf('\n```', from);
		if (to == -1)
		{	throw new Error(`Couldn't parse README.md (error after ${from})`);
		}

		let code = readme.slice(from, to+1);
		code = code.replace(reImport, (_, m) => `${m}'${modUrl}'`);

		const name = code.match(reName)?.[1];

		if (name && code)
		{	result.set(name, code);
		}
	}

	return result;
}
