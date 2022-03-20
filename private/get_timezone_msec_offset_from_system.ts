/**	Example:
	```
	const myDate = new Date(new Date(jerusalemYear, jerusalemMonth, jerusalemDay, jerusalemHour, jerusalemMinute).getTime() - getTimezoneMsecOffsetFromSystem('Asia/Jerusalem'));
	const jerusalemHours = new Date(myDate.getTime() + getTimezoneMsecOffsetFromSystem('Asia/Jerusalem')).getHours();
	```
 **/
export function getTimezoneMsecOffsetFromSystem(timeZone='UTC')
{	const sysDate = new Date();
	const sysDay = sysDate.getDate();
	const sysHour = sysDate.getHours();
	const sysMinute = sysDate.getMinutes();

	const refParts = new Intl.DateTimeFormat('ISO', {timeZone, day: 'numeric', hour: 'numeric', minute: 'numeric'}).formatToParts(sysDate);
	const refDay = Number(refParts.find(p => p.type == 'day')?.value) || 0;
	const refHour = Number(refParts.find(p => p.type == 'hour')?.value) || 0;
	const refMinute = Number(refParts.find(p => p.type == 'minute')?.value) || 0;

	const ref = refMinute + refHour*60;
	const sys = sysMinute + sysHour*60;

	if (refDay < sysDay)
	{	if (refDay==1 && sysDay>20)
		{	return ((ref + 24*60) - sys) * 60000; // msec
		}
		else
		{	return (ref - (sys + 24*60)) * 60000; // msec
		}
	}
	else if (refDay > sysDay)
	{	if (sysDay==1 && refDay>20)
		{	return (ref - (sys + 24*60)) * 60000; // msec
		}
		else
		{	return ((ref + 24*60) - sys) * 60000; // msec
		}
	}
	else
	{	return (ref - sys) * 60000; // msec
	}
}
