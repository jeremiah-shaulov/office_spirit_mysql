import {MyPool} from '../../mod.ts';

const TESTS_DSN = Deno.env.get('TESTS_DSN') || 'mysql://root@127.0.0.1:13306/tests';

/**	Stress-mirror of the production tracker: a small pool with slot contention, XA transactions,
	internal query retries, and a watchdog that force-disconnects each session at a random moment -
	including while connecting, while a query is in flight, and while another conn of the same
	session waits for a free slot. On production this combination kills app-service about twice a
	day with `Uncaught (in promise) Interrupted: operation canceled`.
 **/
Deno.test
(	'forceImmediateDisconnect stress',
	async () =>
	{	const unhandled = new Array<unknown>;
		const onUnhandled = (e: PromiseRejectionEvent) =>
		{	unhandled.push(e.reason);
			e.preventDefault();
		};
		globalThis.addEventListener('unhandledrejection', onUnhandled);
		try
		{	await using pool = new MyPool(TESTS_DSN+(TESTS_DSN.includes('?') ? '&' : '?')+'maxConns=3&connectionTimeout=3000&retryQueryTimes=50&keepAliveTimeout=20000');
			let seed = 0x2545F491;
			const random = () => // deterministic, because Math.random() would vary between runs
			{	seed ^= seed << 13;
				seed ^= seed >>> 17;
				seed ^= seed << 5;
				seed >>>= 0;
				return seed / 0x100000000;
			};
			const oneRequest = async (i: number) =>
			{	using session = pool.getSession();
				const hTimeout = setTimeout(() => session.forceImmediateDisconnect(), Math.floor(random()*300));
				try
				{	const conn = session.conn();
					switch (i % 4)
					{	case 0:
						{	await conn.query(`SELECT Sleep(0.2)`).first();
							break;
						}
						case 1:
						{	// XA write like the tracker's
							await session.startTrx({xa: true});
							await conn.queryVoid(`CREATE TEMPORARY TABLE IF NOT EXISTS t_${i} (id integer PRIMARY KEY)`);
							await conn.query(`SELECT Sleep(0.2)`).first();
							await session.commit();
							break;
						}
						case 2:
						{	// row iteration with a mid-stream kill
							const resultset = await conn.query(`SELECT Repeat('a', 10000) AS c FROM information_schema.columns LIMIT 200`);
							for await (const _row of resultset)
							{	// spin
							}
							break;
						}
						case 3:
						{	// second conn of the same session competes for slots
							const conn2 = session.conn(undefined, true);
							await Promise.allSettled
							(	[	conn.query(`SELECT Sleep(0.2)`).first(),
									conn2.query(`SELECT Sleep(0.2)`).first(),
								]
							);
							break;
						}
					}
				}
				catch
				{	// expected: the watchdog usually wins
				}
				finally
				{	clearTimeout(hTimeout);
				}
			};
			// Waves of concurrent requests, so force-disconnects overlap with slot waits and handshakes
			for (let wave=0; wave<10; wave++)
			{	await Promise.all(Array.from({length: 12}, (_, i) => oneRequest(wave*12 + i)));
			}
			await new Promise(y => setTimeout(y, 2000));
		}
		finally
		{	globalThis.removeEventListener('unhandledrejection', onUnhandled);
		}
		if (unhandled.length)
		{	throw new Error(`${unhandled.length} unhandled rejection(s):\n${unhandled.slice(0, 3).map(v => v instanceof Error ? v.stack : v+'').join('\n---\n')}`);
		}
	}
);
