const decoder = new TextDecoder;

async function system(cmd: string[])
{	const h = Deno.run({cmd, stdout: 'piped'});
	try
	{	return decoder.decode(await h.output());
	}
	finally
	{	h.close();
	}
}

async function stopLeftRunning()
{	const res = await system(['docker', 'container', 'ls', '--filter', 'name=^office_spirit_mysql_']);
	const lines = res.split(/[\r\n]+/);
	lines.shift(); // remove header line
	for (const line of lines)
	{	const containerName = line.match(/(\S*)\s*$/)![0];
		if (containerName)
		{	try
			{	console.log(`%cStopping container ${containerName}`, 'color:blue');
				await system(['docker', 'stop', containerName]);
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
	const cmd = ['docker', 'run', '--rm', '-p', '3306'];
	let password = '';
	let schema = '';
	cmd.push('-e');
	if (withPassword)
	{	password = '@אя';
		cmd.push(`MYSQL_ROOT_PASSWORD=${password}`);
	}
	else
	{	cmd.push(`MYSQL_ALLOW_EMPTY_PASSWORD=1`);
	}
	if (withSchema)
	{	schema = 'tests';
		cmd.push('-e');
		cmd.push(`MYSQL_DATABASE=${schema}`);
	}
	cmd.push('--name');
	cmd.push(containerName);
	cmd.push(imageName);
	for (const p of params)
	{	cmd.push(p);
	}
	// Run
	console.log(`%cStarting ${imageName} %cpassword: ${withPassword ? 'yes' : 'no'}, ${params.join(' ')}`, 'color:blue', 'color:gray');
	const hDb = Deno.run({cmd});
	// Work with it, and finally drop
	try
	{	// Find out port number
		let port = '';
		let error;
		for (let i=0; i<15*60; i++)
		{	await new Promise(y => setTimeout(y, 1000));
			try
			{	const portDesc = await system(['docker', 'port', containerName]);
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
		{	await system(['docker', 'stop', containerName]);
		}
		finally
		{	console.log(`%cDone ${imageName}`, 'color:blue');
			hDb.close();
		}
	}
}
