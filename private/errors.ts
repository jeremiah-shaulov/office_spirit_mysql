import {ErrorCodes} from "./constants.ts";

export const SUSPECT_PACKET_ERROR_IF_PACKET_SIZE = 1*1024*1024;

/**	How fatal is the SQL error. Maybe just the same query can be retried second time, and there's chance that it'll succeed.
	Maybe the current transaction can be retried with the same sequence of queries, and it can succeed.
	Maybe disconnecting and reconnecting can solve the error.
	Or nothing of the above.
	@category Errors
 **/
export const enum CanRetry
{	NONE,
	CONN,
	TRX,
	QUERY,
}

/**	Query was sent to the server, and this error is reported by the server (not a connection error or such).
	@category Errors
 **/
export class SqlError extends Error
{	readonly canRetry;

	constructor(message: string, readonly errorCode=0, public sqlState='', autocommit=false, inTrx=false)
	{	super(message);
		if (errorCode == ErrorCodes.ER_LOCK_WAIT_TIMEOUT)
		{	this.canRetry = CanRetry.QUERY;
		}
		else if (errorCode == ErrorCodes.ER_LOCK_DEADLOCK)
		{	this.canRetry = autocommit && !inTrx ? CanRetry.QUERY : CanRetry.TRX;
		}
		else if (errorCode == ErrorCodes.ER_SERVER_SHUTDOWN)
		{	this.canRetry = CanRetry.CONN;
		}
		else
		{	this.canRetry = CanRetry.NONE;
		}
	}
}

/**	Server didn't respond properly.
	@category Errors
 **/
export class ServerDisconnectedError extends Error
{	constructor(message: string, public errorCode=0)
	{	super(message);
	}
}

/**	Making a query while previous resultset was not read to the end.
	@category Errors
 **/
export class BusyError extends Error
{
}

/**	end() called during operation.
	@category Errors
 **/
export class CanceledError extends Error
{
}

/**	sendWithData() throws it if failed to send data to server.
	@category Errors
 **/
export class SendWithDataError extends Error
{	constructor(message: string, public packetSize: number)
	{	super(packetSize<SUSPECT_PACKET_ERROR_IF_PACKET_SIZE ? message : `${message} - Please make sure that this server accepts packets of this size: ${packetSize} bytes. See "SHOW VARIABLES LIKE 'max_allowed_packet'"`);
	}
}
