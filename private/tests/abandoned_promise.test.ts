import {MyPool} from '../../mod.ts';
import {assert} from 'jsr:@std/assert@1.0.19/assert';

const TESTS_DSN = Deno.env.get('TESTS_DSN') || 'mysql://root@127.0.0.1:13306/tests';

/**	A query or connect promise that its consumer abandoned (a timed-out `Promise.race()`, a caller
	that bailed out on a sibling failure, a background refresh nobody read) must not be able to
	kill the process when it later rejects. Before the guard in `guard_abandoned.ts` these
	scenarios terminated app-service on production about twice a day, with:

		Uncaught (in promise) Interrupted: operation canceled
		Uncaught (in promise) Error: All the 25 free slots are occupied for this DSN: ...

	If the guard is removed, these tests don't merely fail - the uncaught rejection brings down
	the test process. The tests also assert that the abandoned failure is reported through the
	pool's logger, not swallowed.
 **/
function loggerThatCollects(errors: unknown[][])
{	return {
		debug: () => {},
		info: () => {},
		log: () => {},
		warn: () => {},
		error: (...args: unknown[]) => {errors.push(args)},
	};
}

Deno.test
(	'Abandoned query promise + forceImmediateDisconnect',
	async () =>
	{	const errors = new Array<unknown[]>;
		{	await using pool = new MyPool({dsn: TESTS_DSN, logger: loggerThatCollects(errors)});
			using session = pool.getSession();
			const conn = session.conn();
			void conn.query('SELECT Sleep(5)'); // abandoned: nobody awaits (like a timed-out race loser)
			await new Promise(y => setTimeout(y, 300));
			session.forceImmediateDisconnect();
			await new Promise(y => setTimeout(y, 500));
		}
		await new Promise(y => setTimeout(y, 500));
		assert(errors.some(args => args.some(a => a instanceof Error)), `The abandoned rejection was expected to be logged; logged: ${JSON.stringify(errors)}`);
	}
);

Deno.test
(	'Abandoned query promise + pool slots exhausted',
	async () =>
	{	const errors = new Array<unknown[]>;
		{	await using pool = new MyPool({dsn: TESTS_DSN+(TESTS_DSN.includes('?') ? '&' : '?')+'maxConns=1&connectionTimeout=300', logger: loggerThatCollects(errors)});
			using session = pool.getSession();
			const conn = session.conn();
			const busy = conn.query('SELECT Sleep(1)').first(); // occupies the only slot
			await new Promise(y => setTimeout(y, 100));
			const conn2 = session.conn(undefined, true);
			void conn2.query('SELECT 2'); // abandoned; will fail with "All the 1 free slots are occupied"
			try
			{	await busy;
			}
			catch
			{	// ok
			}
			await new Promise(y => setTimeout(y, 1000));
		}
		await new Promise(y => setTimeout(y, 500));
		assert(errors.some(args => args.some(a => a instanceof Error && a.message.includes('free slots are occupied'))), `The abandoned rejection was expected to be logged; logged: ${JSON.stringify(errors)}`);
	}
);
