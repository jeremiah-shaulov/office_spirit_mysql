import {Logger} from "./my_protocol.ts";

const enum IntervalState
{	Terminated,
	Inactive,
	Active,
	Executing,
	ExecutingAndWantReexecute,
}

type DelayMsec = number | (() => number);

export class Interval
{	#hTimer: number|undefined;
	#state = IntervalState.Inactive;
	#onEnd: VoidFunction|undefined;

	get isActive()
	{	return this.#state >= IntervalState.Active;
	}

	constructor(private readonly callback: () => void|Promise<void>, public delayMsec: DelayMsec, private readonly logger: Logger=console)
	{
	}

	start(firstIterIsImmediate=false)
	{	if (this.#state == IntervalState.Inactive)
		{	this.#state = IntervalState.Active;
			this.#hTimer = setTimeout
			(	async () =>
				{	if (this.#state == IntervalState.Active)
					{	this.#state = IntervalState.Executing;
						do
						{	try
							{	await this.callback();
							}
							catch (e)
							{	this.logger.error(e);
							}
						} while (Number(this.#state) == IntervalState.ExecutingAndWantReexecute); // Number() is used to workaround typescript error: This comparison appears to be unintentional
					}
					if (this.#state == IntervalState.Terminated)
					{	this.#onEnd?.();
					}
					else if (this.#state != IntervalState.Inactive)
					{	this.#state = IntervalState.Inactive;
						this.start();
					}
				},
				firstIterIsImmediate ? 0 : typeof(this.delayMsec)=='number' ? this.delayMsec : this.delayMsec(),
			);
		}
		else if (firstIterIsImmediate)
		{	if (this.#state == IntervalState.Executing)
			{	this.#state = IntervalState.ExecutingAndWantReexecute;
			}
			else if (this.#state == IntervalState.Active)
			{	this.#state = IntervalState.Inactive;
				clearTimeout(this.#hTimer);
				this.start(true);
			}
		}
	}

	stop()
	{	if (this.#state != IntervalState.Terminated)
		{	this.#state = IntervalState.Inactive;
			clearTimeout(this.#hTimer);
		}
	}

	[Symbol.asyncDispose]()
	{	const state = this.#state;
		this.#state = IntervalState.Terminated;
		clearTimeout(this.#hTimer);
		if (state == IntervalState.Executing)
		{	return new Promise<void>(y => {this.#onEnd = y});
		}
	}
}
