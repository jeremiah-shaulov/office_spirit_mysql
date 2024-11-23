import {testWithDocker} from './test_with_docker.ts';
import {storeExamplesToTmpFiles} from 'https://deno.land/x/tsa@v0.0.49/doc_test/mod.ts';

const tests = new Array<() => Promise<void>>;
for (const {exampleName, filename} of await storeExamplesToTmpFiles(import.meta.url))
{	const func = async function()
	{	await import(filename);
	};
	Object.defineProperty(func, 'name', {value: exampleName, writable: false});
	tests.push(func);
}
Deno.env.set('DSN', Deno.env.get('TESTS_DSN') ?? '');
testWithDocker(tests);
