export const TRACK_HEALH_STATUS_FOR_PERIOD_SEC = 60;

export class HealthStatus
{	#data = new Uint32Array(TRACK_HEALH_STATUS_FOR_PERIOD_SEC);
	#i = 0; // last recorded index in `#data`
	#iSec = 0; // time in seconds when last recorded

	isEmpty(now=Date.now())
	{	const sec = Math.trunc(now/1000);
		const diff = sec - this.#iSec;
		return diff > TRACK_HEALH_STATUS_FOR_PERIOD_SEC;
	}

	log(ok: boolean, now=Date.now())
	{	const sec = Math.trunc(now/1000);
		const diff = sec - this.#iSec;
		if (diff >= 0)
		{	const data = this.#data;
			let i = this.#i;
			if (diff >= TRACK_HEALH_STATUS_FOR_PERIOD_SEC)
			{	data.fill(0);
			}
			else
			{	for (let iEnd=i+diff; i<iEnd;)
				{	if (++i == TRACK_HEALH_STATUS_FOR_PERIOD_SEC)
					{	i = 0;
						iEnd -= TRACK_HEALH_STATUS_FOR_PERIOD_SEC;
					}
					data[i] = 0;
				}
				this.#i = i;
			}
			this.#iSec = sec;
			const value = data[i];
			if ((ok ? value&0xFFFF : value>>16) < 0xFFFF)
			{	data[i] = value + (ok ? 1 : 0x10000);
			}
			else if ((ok ? value>>16 : value&0xFFFF) >= 0x10000/2)
			{	data[i] = value - (ok ? 0x10000 : 1);
			}
		}
	}

	getHealthStatusForPeriod(periodSec=TRACK_HEALH_STATUS_FOR_PERIOD_SEC, now=Date.now())
	{	const sec = Math.trunc(now/1000);
		const diff = sec - this.#iSec;
		if (periodSec > TRACK_HEALH_STATUS_FOR_PERIOD_SEC)
		{	periodSec = TRACK_HEALH_STATUS_FOR_PERIOD_SEC;
		}
		periodSec -= diff; // there were no logs in the last `diff` seconds
		if (periodSec <= 0)
		{	return NaN;
		}
		const data = this.#data;
		let i = this.#i;
		let nOk = 0;
		let nFail = 0;
		for (let iEnd=i-periodSec; i>iEnd; i--)
		{	if (i < 0)
			{	i += TRACK_HEALH_STATUS_FOR_PERIOD_SEC;
				iEnd += TRACK_HEALH_STATUS_FOR_PERIOD_SEC;
			}
			const value = data[i];
			nOk += value & 0xFFFF;
			nFail += value >> 16;
		}
		return nOk / (nOk + nFail);
	}
}
