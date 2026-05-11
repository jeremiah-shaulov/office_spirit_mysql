import {SqlLogToWritable} from '../sql_log_to_writable.ts';
import {Dsn} from '../dsn.ts';
import {assert} from 'jsr:@std/assert@1.0.7/assert';

// Capture only the colourised query text (the logger prepends a per-connection
// banner like `/* hostname #id */`; we want what `appendToQuery` itself emitted).
async function captureQuery(sql: string)
{	const chunks: Uint8Array[] = [];
	const writable = new WritableStream<Uint8Array>
	(	{	write(chunk)
			{	chunks.push(chunk.slice());
			}
		}
	);
	const logger = new SqlLogToWritable(writable, true);
	const dsn = new Dsn('mysql://root@localhost/test');
	const q = await logger.query(dsn, 1, false, false);
	assert(q && q.appendToQuery);

	// Snapshot how many chunks the banner produced, then drive the parser.
	const bannerChunks = chunks.length;
	await q.appendToQuery(new TextEncoder().encode(sql));
	const queryChunks = chunks.slice(bannerChunks);

	await logger.dispose();

	let total = 0;
	for (const c of queryChunks) total += c.length;
	const out = new Uint8Array(total);
	let pos = 0;
	for (const c of queryChunks) {out.set(c, pos); pos += c.length;}
	return new TextDecoder().decode(out);
}

Deno.test
(	'Multi-line comment with internal "*" stays one comment token',
	async () =>
	{	// The parser should treat `/* a*b */` as a single comment. The
		// buggy version terminated the comment at the inner `*`, leaving the
		// real closing `*/` to be rendered as plain text — observable as a
		// colour-reset escape appearing BETWEEN the inner `*` and the closing
		// `*/`.
		const out = await captureQuery('SELECT 1 /* a*b */ FROM dual');

		// Find the comment open belonging to the SQL itself (skipping the
		// connection banner the logger prepends, which is also a `/* … */`
		// comment).
		const first = out.indexOf('/*');
		assert(first >= 0, `comment open not found in: ${JSON.stringify(out)}`);
		const start = out.indexOf('/*', first + 2);
		assert(start > first, `expected a second '/*' in: ${JSON.stringify(out)}`);

		const reset = out.indexOf('\x1B[0m', start);
		assert(reset > start, 'comment reset not found');
		const commentRegion = out.slice(start, reset);

		assert(commentRegion.includes('*/'), `expected '*/' inside the coloured comment region, got: ${JSON.stringify(commentRegion)}`);
	}
);
