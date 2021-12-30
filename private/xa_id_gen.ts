const RE_XA_ID = /^([0-9a-z]{6})\.\d+@([0-9a-z]+)(?:>([0-9a-z]*))?-(\d*)$/;

export class XaIdGen
{	private lastTime = 0;
	private lastEnum = 0;
	private pid = Deno.pid;

	next(xaInfoTableHash?: number)
	{	const curTime = Math.floor(Date.now()/1000);
		let curEnum = 0;
		if (curTime == this.lastTime)
		{	curEnum = ++this.lastEnum;
		}
		else
		{	this.lastTime = curTime;
			this.lastEnum = 0;
		}
		let v = curTime.toString(36)+'.'+curEnum.toString(36)+'@'+this.pid.toString(36);
		if (xaInfoTableHash != undefined)
		{	v += '>'+xaInfoTableHash.toString(36);
		}
		return v+'-';
	}

	static decode(xaId: string)
	{	const m = xaId.match(RE_XA_ID);
		if (m)
		{	const [_, time36, pid36, hash36, connectionId10] = m;
			const time = parseInt(time36, 36);
			const pid = parseInt(pid36, 36);
			const hash = parseInt(hash36, 36);
			const connectionId = parseInt(connectionId10, 10);
			const xaId1 = xaId.slice(0, -connectionId10.length);
			return {time, pid, hash, connectionId, xaId1};
		}
	}
}
