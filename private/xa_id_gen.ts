const RE_XA_ID = /^([0-9a-z]{6})\.[0-9a-z]+@([0-9a-z]+)-(\d*)$/;

export class XaIdGen
{	#lastTime = 0;
	#lastEnum = 0;
	#pid = Deno.pid;

	next()
	{	const curTime = Math.floor(Date.now()/1000);
		let curEnum = 0;
		if (curTime == this.#lastTime)
		{	curEnum = ++this.#lastEnum;
		}
		else
		{	this.#lastTime = curTime;
			this.#lastEnum = 0;
		}
		return curTime.toString(36)+'.'+curEnum.toString(36)+'@'+this.#pid.toString(36)+'-';
	}

	static decode(xaId: string)
	{	const m = xaId.match(RE_XA_ID);
		if (m)
		{	const [_, time36, pid36, connectionId10] = m;
			const time = parseInt(time36, 36);
			const pid = parseInt(pid36, 36);
			const connectionId = parseInt(connectionId10, 10);
			if (!isNaN(time) && !isNaN(pid) && !isNaN(connectionId))
			{	return {time, pid, connectionId};
			}
		}
	}
}
