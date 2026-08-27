import {MyPool} from '../../mod.ts';

const TESTS_DSN = Deno.env.get('TESTS_DSN') || 'mysql://root@127.0.0.1:13306/tests';

/**	Each scenario arms an `unhandledrejection` listener, provokes the teardown path in question,
	waits for the microtask queue and timers to drain, and fails if any rejection was left floating.
	On production (app-service) such a floating rejection is fatal: Deno terminates the process.
 **/
async function withUnhandledWatch(cb: () => Promise<void>)
{	const unhandled = new Array<unknown>;
	const onUnhandled = (e: PromiseRejectionEvent) =>
	{	unhandled.push(e.reason);
		e.preventDefault();
	};
	globalThis.addEventListener('unhandledrejection', onUnhandled);
	try
	{	await cb();
		await new Promise(y => setTimeout(y, 1000));
	}
	finally
	{	globalThis.removeEventListener('unhandledrejection', onUnhandled);
	}
	if (unhandled.length)
	{	throw new Error(`${unhandled.length} unhandled rejection(s): ${unhandled.map(v => v instanceof Error ? v.stack : v+'').join('\n---\n')}`);
	}
}

Deno.test
(	'forceImmediateDisconnect during query',
	async () =>
	{	await withUnhandledWatch
		(	async () =>
			{	await using pool = new MyPool(TESTS_DSN);
				using session = pool.getSession();
				const conn = session.conn();
				const promise = conn.query('SELECT Sleep(5)').first();
				await new Promise(y => setTimeout(y, 300));
				session.forceImmediateDisconnect();
				try
				{	await promise;
					throw new Error('Expected the query to fail');
				}
				catch
				{	// expected
				}
			}
		);
	}
);

Deno.test
(	'forceImmediateDisconnect while iterating rows',
	async () =>
	{	await withUnhandledWatch
		(	async () =>
			{	await using pool = new MyPool(TESTS_DSN);
				using session = pool.getSession();
				const conn = session.conn();
				// A resultset larger than one network buffer, so reads stay pending mid-iteration
				const resultset = await conn.query("SELECT Repeat('a', 100000) AS c FROM information_schema.columns LIMIT 100");
				let nRows = 0;
				try
				{	for await (const _row of resultset)
					{	if (++nRows == 2)
						{	session.forceImmediateDisconnect();
						}
					}
					throw new Error('Expected the iteration to fail');
				}
				catch
				{	// expected
				}
			}
		);
	}
);

Deno.test
(	'forceImmediateDisconnect while a second conn awaits a free slot',
	async () =>
	{	await withUnhandledWatch
		(	async () =>
			{	await using pool = new MyPool(TESTS_DSN+(TESTS_DSN.includes('?') ? '&' : '?')+'maxConns=1&connectionTimeout=2000');
				using session = pool.getSession();
				const conn = session.conn();
				const promise = conn.query('SELECT Sleep(5)').first();
				await new Promise(y => setTimeout(y, 300));
				// The second conn cannot get a slot while the first sleeps
				const conn2 = session.conn(undefined, true);
				const promise2 = conn2.query('SELECT 2').first();
				await new Promise(y => setTimeout(y, 300));
				session.forceImmediateDisconnect();
				for (const p of [promise, promise2])
				{	try
					{	await p;
					}
					catch
					{	// expected
					}
				}
			}
		);
	}
);

Deno.test
(	'forceImmediateDisconnect during connect',
	async () =>
	{	await withUnhandledWatch
		(	async () =>
			{	await using pool = new MyPool(TESTS_DSN);
				using session = pool.getSession();
				const conn = session.conn();
				const promise = conn.connect();
				session.forceImmediateDisconnect();
				try
				{	await promise;
				}
				catch
				{	// expected
				}
			}
		);
	}
);
