import {assertEquals} from 'https://deno.land/std@0.224.0/assert/assert_equals.ts';

/*	Option 1. Run tests using already existing and running database server:
		DSN='mysql://root:hello@localhost/tests' deno test --fail-fast --allow-all --coverage=.vscode/coverage/profile private/tests

	Option 2. Use docker to download and run various database servers during testing:
		rm -r .vscode/coverage/profile; WITH_DOCKER=1 deno test --fail-fast --allow-all --coverage=.vscode/coverage/profile private/tests
 */

const {TESTS_DSN, WITH_DOCKER} = Deno.env.toObject();

const decoder = new TextDecoder;

export function testWithDocker(tests: Array<(dsnStr: string) => Promise<void>>)
{	function doRunTests(dsnStr: string)
	{	return runTests(dsnStr, tests);
	}

	if (TESTS_DSN)
	{	console.log('%cEnvironment variable TESTS_DSN is set, so using DSN %s for tests', 'color:blue', TESTS_DSN);
		for (const t of tests)
		{	Deno.test(t.name, () => t(TESTS_DSN));
		}
	}
	else if (WITH_DOCKER === 'latest')
	{	console.log("%cEnvironment variable WITH_DOCKER is set to 'latest', so i'll download and run mysql:latest Docker image", 'color:blue');

		Deno.test
		(	'All',
			async () =>
			{	await withDocker('mysql:latest', true, true, ['--innodb-idle-flush-pct=0', '--local-infile'], doRunTests);
				await withDocker('mariadb:latest', false, true, ['--innodb-idle-flush-pct=0', '--max-allowed-packet=67108864'], doRunTests);
			}
		);
	}
	else if (WITH_DOCKER === 'all')
	{	console.log("%cEnvironment variable WITH_DOCKER is set, so i'll download and run Docker images", 'color:blue');

		Deno.test
		(	'All',
			async () =>
			{	await withDocker('mysql:latest', false, true, ['--innodb-idle-flush-pct=0'], doRunTests);
				await withDocker('mysql:latest', true, false, ['--innodb-idle-flush-pct=0', '--local-infile', '--default-authentication-plugin=caching_sha2_password'], doRunTests);
				await withDocker('mysql:8.0', true, true, ['--innodb-idle-flush-pct=0', '--default-authentication-plugin=mysql_native_password'], doRunTests);
				await withDocker('mysql:5.7', true, false, ['--max-allowed-packet=67108864', '--local-infile'], doRunTests);
				await withDocker('mysql:5.6', true, true, ['--max-allowed-packet=67108864', '--local-infile', '--innodb-log-file-size=50331648'], doRunTests);

				await withDocker('mariadb:latest', false, true, ['--innodb-idle-flush-pct=0', '--max-allowed-packet=67108864'], doRunTests);
				await withDocker('mariadb:latest', true, false, ['--innodb-idle-flush-pct=0', '--max-allowed-packet=67108864', '--local-infile', '--default-authentication-plugin=caching_sha2_password'], doRunTests);
				await withDocker('mariadb:10.7', true, true, ['--innodb-idle-flush-pct=0', '--max-allowed-packet=67108864', '--default-authentication-plugin=mysql_native_password'], doRunTests);
				await withDocker('mariadb:10.5', true, false, ['--innodb-idle-flush-pct=0', '--max-allowed-packet=67108864', '--local-infile'], doRunTests);
				await withDocker('mariadb:10.2', true, true, ['--innodb-idle-flush-pct=0', '--max-allowed-packet=67108864', '--local-infile'], doRunTests);
				await withDocker('cytopia/mariadb-10.0', true, false, ['--innodb-idle-flush-pct=0', '--max-allowed-packet=67108864', '--local-infile'], doRunTests);
				await withDocker('cytopia/mariadb-5.5', true, false, ['--max-allowed-packet=67108864', '--local-infile', '--innodb-log-file-size=50331648'], doRunTests);
			}
		);
	}
	else if (WITH_DOCKER)
	{	console.log("%cEnvironment variable WITH_DOCKER is set to %c%s%c, so i'll download and run this Docker image", 'color:blue', 'color:blue; font-weight:bold', WITH_DOCKER, 'color:blue');

		Deno.test
		(	'All',
			async () =>
			{	await withDocker(WITH_DOCKER, true, true, ['--innodb-idle-flush-pct=0', '--local-infile'], doRunTests);
			}
		);
	}
	else
	{	console.log('%cPlease, set one of environment variables: TESTS_DSN or WITH_DOCKER.', 'color:blue');
		console.log('TESTS_DSN="mysql://..." deno test ...');
		console.log('Or (to test on all known docker images)');
		console.log('WITH_DOCKER=all deno test ...');
		console.log('Or (to test on latest MySQL and latest MariaDB)');
		console.log('WITH_DOCKER=latest deno test ...');
		console.log('Or (to test on specific docker image)');
		console.log('WITH_DOCKER=mysql:9.0 deno test ...');
	}
}

async function runTests(dsnStr: string, tests: Array<(dsnStr: string) => Promise<void>>)
{	for (const t of tests)
	{	console.log(`test ${t.name} ...`);
		const since = Date.now();
		let error;
		try
		{	const before = Object.assign({}, Deno.resources());
			await t(dsnStr);
			const after = Object.assign({}, Deno.resources());
			assertEquals(before, after);
		}
		catch (e)
		{	error = e;
		}
		const elapsed = Date.now() - since;
		const elapsedStr = elapsed<60000 ? (elapsed/1000)+'s' : Math.floor(elapsed/60000)+'m'+(Math.floor(elapsed/1000)%60)+'s';
		if (!error)
		{	console.log('\t%cok %c(%s)', 'color:green', 'color:gray', elapsedStr);
		}
		else
		{	console.log('\t%cFAILED %c(%s)', 'color:red', 'color:gray', elapsedStr);
			throw error;
		}
	}
}

async function system(cmd: string, args: string[], stderr: 'inherit'|'null'='inherit')
{	const output = await new Deno.Command(cmd, {args, stdout: 'piped', stderr}).output();
	if (!output.success)
	{	throw new Error(`Command failed: ${cmd} ${JSON.stringify(args)}`);
	}
	return decoder.decode(output.stdout);
}

async function stopLeftRunning()
{	const res = await system('docker', ['container', 'ls', '--filter', 'name=^office_spirit_mysql_']);
	const lines = res.split(/[\r\n]+/);
	lines.shift(); // remove header line
	for (const line of lines)
	{	const containerName = line.match(/(\S*)\s*$/)![0];
		if (containerName)
		{	try
			{	console.log(`%cStopping container ${containerName}`, 'color:blue');
				await system('docker', ['stop', containerName]);
			}
			catch (e)
			{	console.error(e);
			}
		}
	}
}

async function withDocker(imageName: string, withPassword: boolean, withSchema: boolean, params: string[], cb: (dsnStr: string) => Promise<unknown>)
{	await stopLeftRunning();
	const containerName = `office_spirit_mysql_${Math.floor(Math.random() * 256)}`;
	// Format command line
	const args = ['run', '--rm', '-p', '3306'];
	let password = '';
	let schema = '';
	args.push('-e');
	if (withPassword)
	{	password = '@אя';
		args.push(`MYSQL_ROOT_PASSWORD=${password}`);
	}
	else
	{	args.push(`MYSQL_ALLOW_EMPTY_PASSWORD=1`);
	}
	if (withSchema)
	{	schema = 'tests';
		args.push('-e');
		args.push(`MYSQL_DATABASE=${schema}`);
	}
	args.push('--name');
	args.push(containerName);
	args.push(imageName);
	for (const p of params)
	{	args.push(p);
	}
	// Run
	console.log(`%cStarting ${imageName} %cpassword: ${withPassword ? 'yes' : 'no'}, ${params.join(' ')}`, 'color:blue', 'color:gray');
	const hDb = new Deno.Command('docker', {args}).spawn();
	// Work with it, and finally drop
	try
	{	// Find out port number
		let port = '';
		let error;
		for (let i=0; i<15*60; i++)
		{	await new Promise(y => setTimeout(y, 1000));
			try
			{	const portDesc = await system('docker', ['port', containerName], 'null');
				const m = portDesc.match(/:(\d+)[\r\n]/);
				if (m)
				{	port = m[1];
					break;
				}
			}
			catch (e)
			{	error = e;
			}
		}
		if (!port)
		{	throw error ?? new Error(`Cannot find out docker port`);
		}
		// Call the cb
		console.log(`%cWorking with ${imageName} on port ${port}`, 'color:blue');
		await cb(`mysql://root:${password}@127.0.0.1:${port}/${schema}?connectionTimeout=${15*60*1000}`);
	}
	finally
	{	// Drop the container
		try
		{	await system('docker', ['stop', containerName]);
		}
		finally
		{	console.log(`%cDone ${imageName}`, 'color:blue');
			try
			{	hDb.kill();
			}
			catch
			{	// ok
			}
			try
			{	await hDb.status;
			}
			catch
			{	// ok
			}
		}
	}
}
