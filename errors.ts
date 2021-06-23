export class SqlError extends Error
{	constructor(message: string, public errorCode=0, public sqlState='')
	{	super(message);
	}
}

export class ServerDisconnectedError extends Error
{
}

/**	Making a query while previous resultset was not read to the end.
 **/
export class BusyError extends Error
{
}

/**	end() called during operation.
 **/
export class CanceledError extends Error
{
}
