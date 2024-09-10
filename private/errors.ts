import {ErrorCodes} from "./constants.ts";

export const SUSPECT_PACKET_ERROR_IF_PACKET_SIZE = 1*1024*1024;

export const enum CanRetry
{	NONE,
	CONN,
	TRX,
	QUERY,
}

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

export class ServerDisconnectedError extends Error
{	constructor(message: string, public errorCode=0)
	{	super(message);
	}
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

/**	sendWithData() throws it if failed to send data to server.
 **/
export class SendWithDataError extends Error
{	constructor(message: string, public packetSize: number)
	{	super(packetSize<SUSPECT_PACKET_ERROR_IF_PACKET_SIZE ? message : `${message} - Please make sure that this server accepts packets of this size: ${packetSize} bytes. See "SHOW VARIABLES LIKE 'max_allowed_packet'"`);
	}
}
