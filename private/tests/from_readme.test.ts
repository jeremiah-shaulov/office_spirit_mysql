import {testWithDocker} from './test_with_docker.ts';
import {storeExamplesToTmpFiles} from 'https://deno.land/x/tsa@v0.0.57/doc_test/mod.ts';

// The examples in `README.md` import this library from its public URL (the `--importUrl` that was given to `tsa`),
// but the tests must run against the working tree, not against the published package
// (during the publish workflow the version being published doesn't exist yet on JSR)
const readmeUrl = new URL('../../README.md', import.meta.url);
const importUrl = (await Deno.readTextFile(readmeUrl)).match(/--importUrl[= ](\S+)/)?.[1] ?? '';
const modUrl = new URL('../../mod.ts', import.meta.url).href;

const tests = new Array<(dsnStr: string) => Promise<void>>;
for (const {exampleName, filename} of await storeExamplesToTmpFiles(import.meta.url))
{	if (importUrl)
	{	const code = await Deno.readTextFile(filename);
		await Deno.writeTextFile(filename, code.replaceAll(`'${importUrl}'`, `'${modUrl}'`));
	}
	const func = async function(dsnStr: string)
	{	Deno.env.set('DSN', dsnStr);
		await import(filename);
	};
	Object.defineProperty(func, 'name', {value: exampleName, writable: false});
	tests.push(func);
}
testWithDocker(tests);
