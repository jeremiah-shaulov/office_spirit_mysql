import {Interval} from '../interval.ts';
import {Logger} from '../my_protocol.ts';
import {assertEquals} from 'https://deno.land/std@0.224.0/assert/assert_equals.ts';

const SILENT_LOGGER: Logger = {debug() {}, info() {}, log() {}, warn() {}, error() {}};

function delay(msec: number)
{	return new Promise<void>(y => setTimeout(y, msec));
}

// If this test leaves a timer scheduled, Deno's op sanitizer fails it with
// "A timer was started in this test, but never completed".
Deno.test
(	'Interval: callback stops itself, then external start() during trailing await does not leak a timer',
	async () =>
	{	let runs = 0;
		let firedAfterDispose = false;
		let disposed = false;
		let release = () => {};
		const trailing = new Promise<void>(y => {release = y});

		const interval: Interval = new Interval
		(	async () =>
			{	runs++;
				if (disposed)
				{	firedAfterDispose = true;
				}
				if (runs == 1)
				{	// The callback stops its own interval (like `MyPool.#commonTask` does), ...
					interval.stop();
					// ... and then keeps awaiting.
					await trailing;
				}
			},
			1_000_000, // A long delay, so that a leaked (rescheduled) timer stays clearly pending.
			SILENT_LOGGER,
		);

		interval.start(true); // Fire the first iteration immediately.
		await delay(10); // Let the timer fire and enter the callback (which calls `stop()`, then awaits `trailing`).

		interval.start(); // An external `start()` arrives while the callback is in its trailing await.

		release(); // End the trailing await. The buggy code rescheduled a second timer right here.
		await delay(10);

		disposed = true;
		await interval[Symbol.asyncDispose](); // Clears the single tracked handle.

		await delay(10); // Give a leaked timer a chance to be observed.

		assertEquals(interval.isActive, false);
		assertEquals(firedAfterDispose, false);
	}
);

// Sanity check: the normal path still reschedules after each completion.
Deno.test
(	'Interval: reschedules after each normal completion',
	async () =>
	{	let runs = 0;
		const interval = new Interval
		(	() =>
			{	runs++;
			},
			10,
			SILENT_LOGGER,
		);

		interval.start(true);
		await delay(55);
		await interval[Symbol.asyncDispose]();

		// First iteration is immediate, then one per ~10ms: expect several runs, proving it re-armed.
		if (runs < 3)
		{	throw new Error(`Expected the interval to reschedule and run several times, but it ran ${runs} time(s)`);
		}
	}
);
