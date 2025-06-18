export async function promiseAllSettledThrow(promises: Promise<unknown>[])
{	for (const result of await Promise.allSettled(promises))
	{	if (result.status == 'rejected')
		{	throw result.reason;
		}
	}
}
