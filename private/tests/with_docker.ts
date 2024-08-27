const decoder = new TextDecoder;

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

export async function withDocker(imageName: string, withPassword: boolean, withSchema: boolean, params: string[], cb: (dsnStr: string) => Promise<unknown>)
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
		}
	}
}
