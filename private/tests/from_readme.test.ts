const readmeUrl = new URL('../../README.md', import.meta.url);
const modUrl = new URL('../../mod.ts', import.meta.url);

await runTestsFromReadme(readmeUrl, modUrl);

async function runTestsFromReadme(readmeUrl: URL, modUrl: URL)
{	for (const [name, code] of await extractTestsFromReadme(readmeUrl, modUrl))
	{	const filename = await Deno.makeTempFile({suffix: `-${name}.ts`});
		try
		{	await Deno.writeTextFile(filename, code);
		}
		catch (e)
		{	await Deno.remove(filename);
			throw e;
		}
		Deno.test
		(	name,
			async () =>
			{	try
				{	await import(filename);
				}
				finally
				{	await Deno.remove(filename);
				}
			}
		);
	}
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
