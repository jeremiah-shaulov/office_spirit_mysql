const formatters = new Map<string, Intl.DateTimeFormat>;

const RE_NUMERIC_TIMEZONE_OFFSET = /^([+-])(\d{1,2}):(\d{2})$/;

/**	Parses a numeric MySQL `time_zone` value, like '+05:30' or '-08:00', to the UTC offset in milliseconds.
	Returns undefined if the value is not of this form.
 **/
export function parseNumericTimezoneOffset(value: string)
{	const m = RE_NUMERIC_TIMEZONE_OFFSET.exec(value);
	if (!m)
	{	return undefined;
	}
	const offset = (Number(m[2])*60 + Number(m[3])) * 60000;
	return m[1]=='-' ? -offset : offset;
}

/**	UTC offset (milliseconds east of UTC) of the given IANA time zone at the given instant.
	Example: 'America/New_York' is -5 hours in January and -4 hours in July (DST), so the result depends on `atMsec`.
	Computed by formatting the instant in the target zone and comparing the wall-clock fields with UTC,
	so it's exact to the second (historical zones can have odd offsets, like Jerusalem LMT +2:20:54).
	Throws (RangeError) if the runtime doesn't know the zone.
 **/
export function timezoneMsecOffsetAt(timeZone: string, atMsec: number)
{	let fmt = formatters.get(timeZone);
	if (!fmt)
	{	fmt = new Intl.DateTimeFormat('en-US', {timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric'});
		formatters.set(timeZone, fmt);
	}
	let year = 0;
	let month = 1;
	let day = 1;
	let hour = 0;
	let minute = 0;
	let second = 0;
	for (const {type, value} of fmt.formatToParts(atMsec))
	{	switch (type)
		{	case 'year':
				year = Number(value);
				break;
			case 'month':
				month = Number(value);
				break;
			case 'day':
				day = Number(value);
				break;
			case 'hour':
				hour = Number(value);
				break;
			case 'minute':
				minute = Number(value);
				break;
			case 'second':
				second = Number(value);
				break;
		}
	}
	const wall = new Date(Date.UTC(year, month-1, day, hour, minute, second));
	if (year < 100)
	{	wall.setUTCFullYear(year); // `Date.UTC(year, ...)` maps years 0-99 to 1900-1999
	}
	return wall.getTime() - Math.floor(atMsec/1000)*1000;
}

/**	UTC offset (milliseconds east of UTC) of the system (Deno's) time zone at the given instant.
 **/
export function systemMsecOffsetAt(atMsec: number)
{	return -new Date(atMsec).getTimezoneOffset() * 60000;
}
