import {testWithDocker} from './test_with_docker.ts';
import {storeExamplesToTmpFiles} from 'https://deno.land/x/tsa@v0.0.55/doc_test/mod.ts';

const tests = new Array<(dsnStr: string) => Promise<void>>;
for (const {exampleName, filename} of await storeExamplesToTmpFiles(import.meta.url))
{	const func = async function(dsnStr: string)
	{	Deno.env.set('DSN', dsnStr);
		await import(filename);
	};
	Object.defineProperty(func, 'name', {value: exampleName, writable: false});
	tests.push(func);
}
testWithDocker(tests);
