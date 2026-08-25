import {SqlLogToWritable} from '../sql_log_to_writable.ts';
import {Dsn} from '../dsn.ts';
import {assert} from 'jsr:@std/assert@1.0.19/assert';

async function captureLog(maxLines: number, queryChunks: string[])
{	const chunks = new Array<Uint8Array>;
	const writable = new WritableStream<Uint8Array>
	(	{	write(chunk)
			{	chunks.push(chunk.slice());
			}
		}
	);
	const logger = new SqlLogToWritable(writable, false, 10_000, 3_000, maxLines);
	const dsn = new Dsn('mysql://root@localhost/db');
	const q = await logger.query(dsn, 1, false, false);
	assert(q);
	const enc = new TextEncoder;
	for (const chunk of queryChunks)
	{	await q.appendToQuery(enc.encode(chunk));
	}
	await q.start();
	await q.end(undefined, -1);
	await logger.dispose();
	let total = 0;
	for (const c of chunks)
	{	total += c.length;
	}
	const joined = new Uint8Array(total);
	let pos = 0;
	for (const c of chunks)
	{	joined.set(c, pos);
		pos += c.length;
	}
	return new TextDecoder().decode(joined);
}

Deno.test
(	'Line limit truncates chunks that arrive after the cut',
	async () =>
	{	// The first chunk crosses the line limit (maxLines=5), so the log is cut at the end of line 5.
		// The second chunk arrives when the limit is already reached: nothing of it may be written
		// (the buggy version skipped the line check for it, and passed it through under the byte limit,
		// so its lines leaked into the log glued to the cut point: "…L5L9\nL10\nL11\n"),
		// but its bytes must still be counted for the "…(N bytes)" marker.
		const out = await captureLog(5, ['L1\nL2\nL3\nL4\nL5\nL6\nL7\nL8\n', 'L9\nL10\nL11\n']);
		assert(out.includes('L5'), `expected L5 in: ${JSON.stringify(out)}`);
		assert(!out.includes('L6'), `L6 leaked into: ${JSON.stringify(out)}`);
		assert(!out.includes('L9'), `L9 leaked into: ${JSON.stringify(out)}`);
		// 24 bytes in the first chunk + 11 in the second
		assert(out.includes('…(35 bytes)'), `expected the byte count marker in: ${JSON.stringify(out)}`);
	}
);

Deno.test
(	'Query below the limits is logged in full',
	async () =>
	{	const out = await captureLog(5, ['L1\nL2\n', 'L3\nL4']);
		assert(out.includes('L1\nL2\nL3\nL4'), `expected the whole query in: ${JSON.stringify(out)}`);
		assert(!out.includes('bytes)'), `unexpected truncation marker in: ${JSON.stringify(out)}`);
	}
);
