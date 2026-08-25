import {MyPool} from '../my_pool.ts';
import type {Logger} from '../my_protocol.ts';
import {assert} from 'jsr:@std/assert@1.0.19/assert';
import {assertEquals} from 'jsr:@std/assert@1.0.19/equals';

const SILENT_LOGGER: Logger = {debug() {}, info() {}, log() {}, warn() {}, error() {}};

Deno.test
(	'MyPool.options() patches, and a partial call preserves onLoadFile, onBeforeCommit and logger',
	async () =>
	{	const onLoadFile = () => Promise.resolve(undefined);
		const onBeforeCommit = () => Promise.resolve();
		const pool = new MyPool({dsn: 'mysql://root@localhost/tests', onLoadFile, onBeforeCommit, logger: SILENT_LOGGER});
		try
		{	// Set in constructor
			let opts = pool.options();
			assertEquals(opts.onLoadFile, onLoadFile);
			assertEquals(opts.onBeforeCommit, onBeforeCommit);
			assertEquals(opts.logger, SILENT_LOGGER);
			// Partial patch must not wipe them
			opts = pool.options({maxConnsWaitQueue: 10});
			assertEquals(opts.maxConnsWaitQueue, 10);
			assertEquals(opts.onLoadFile, onLoadFile);
			assertEquals(opts.onBeforeCommit, onBeforeCommit);
			assertEquals(opts.logger, SILENT_LOGGER);
			// Patching through a DSN string must not wipe them either
			opts = pool.options('mysql://root@localhost/tests2');
			assertEquals(opts.dsn?.toString(), 'mysql://root@localhost/tests2');
			assertEquals(opts.onLoadFile, onLoadFile);
			assertEquals(opts.onBeforeCommit, onBeforeCommit);
			assertEquals(opts.logger, SILENT_LOGGER);
			// Explicitly provided `undefined` unsets the handlers, and resets the logger to `console`
			opts = pool.options({onLoadFile: undefined, onBeforeCommit: undefined, logger: undefined});
			assertEquals(opts.onLoadFile, undefined);
			assertEquals(opts.onBeforeCommit, undefined);
			assert(opts.logger === console);
		}
		finally
		{	await pool[Symbol.asyncDispose]();
		}
	}
);
