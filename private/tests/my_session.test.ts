import {MyPool} from '../my_pool.ts';
import {Dsn} from '../dsn.ts';
import {assert} from 'jsr:@std/assert@1.0.19/assert';
import {assertEquals} from 'jsr:@std/assert@1.0.19/equals';
import {assertRejects} from 'jsr:@std/assert@1.0.19/rejects';

// These tests use lazy operations only (no queries), so they don't need a running server.

Deno.test
(	'MySession.conn() distinguishes DSNs that differ only in password',
	async () =>
	{	const dsnA = new Dsn('mysql://root:pass1@localhost/tests');
		const dsnB = new Dsn('mysql://root:pass2@localhost/tests');
		assertEquals(dsnA.name, dsnB.name); // the name redacts the password
		const pool = new MyPool;
		try
		{	using session = pool.getSession();
			const conn1 = session.conn(dsnA);
			const conn2 = session.conn(dsnB);
			const conn3 = session.conn(new Dsn('mysql://root:pass1@localhost/tests'));
			assert(conn1 !== conn2); // same name, different password - must be different connections
			assert(conn1 === conn3); // fully identical DSN - must be the same connection
		}
		finally
		{	await pool[Symbol.asyncDispose]();
		}
	}
);

Deno.test
(	'Lazy rollback to a conn savepoint set before a session savepoint (and vice versa)',
	async () =>
	{	const pool = new MyPool('mysql://root@localhost/tests');
		try
		{	{	using session = pool.getSession();
				await session.startTrx();
				const conn = session.conn();
				const p = conn.savepoint(); // pending 'SAVEPOINT p1'
				const s = session.savepoint(); // pending 'SAVEPOINT s1' on top
				await conn.rollback(p); // must lazily cancel 'SAVEPOINT p1', not throw 'No such SAVEPOINT'
				assert(conn.inTrx); // 'START TRANSACTION' is still pending
				// 'SAVEPOINT s1' was set after the point i rolled back to, so it must be gone now (like on the server)
				await assertRejects(() => conn.rollback(s), Error, 'No such SAVEPOINT');
			}
			{	using session = pool.getSession();
				await session.startTrx();
				const conn = session.conn();
				const s = session.savepoint(); // pending 'SAVEPOINT s1'
				conn.savepoint(); // pending 'SAVEPOINT p1' on top
				await conn.rollback(s); // must lazily cancel 'SAVEPOINT s1' behind the conn savepoint
				assert(conn.inTrx);
			}
		}
		finally
		{	await pool[Symbol.asyncDispose]();
		}
	}
);
