import type {Logger} from './my_protocol.ts';

const guarded = new WeakMap<Promise<unknown>, Logger>;
let isListening = false;

/**	Protects the process from termination when a promise that this library returned is rejected
	after its consumer stopped awaiting it (or never awaited it at all).

	A query or connect promise can be abandoned legitimately: a `Promise.race()` with a timeout
	where this promise lost, a caller that failed on a sibling operation and bailed out, a value
	refreshed in background that nobody read yet. Such a promise can still reject long after -
	when `forceImmediateDisconnect()` closes the socket under a pending read (`Interrupted:
	operation canceled`), when a write lands on the closed connection (`BrokenPipe`), or when a
	wait for a free slot ends with "All the N free slots are occupied for this DSN". In Deno an
	unhandled rejection terminates the process, so on a loaded application every such coincidence
	killed the server together with all its in-flight requests (observed on production about twice
	a day).

	The guard doesn't change how errors are delivered: a rejection still reaches every awaiter that
	exists. Only when nobody is awaiting, instead of dying the application logs the error through
	the `logger` of the pool that issued the promise.
 **/
export function guardAbandoned<P extends Promise<unknown>>(promise: P, logger: Logger): P
{	if (!isListening)
	{	isListening = true;
		addEventListener
		(	'unhandledrejection',
			event =>
			{	const logger = guarded.get(event.promise);
				if (logger)
				{	event.preventDefault();
					logger.error('An abandoned promise (that nobody was awaiting) failed:', event.reason);
				}
			}
		);
	}
	guarded.set(promise, logger);
	return promise;
}
