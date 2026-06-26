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
		switch (errorCode)
		{	case ErrorCodes.ER_LOCK_WAIT_TIMEOUT:
			case ErrorCodes.ER_LOCK_DEADLOCK:
			case ErrorCodes.ER_XA_RBTIMEOUT:
			case ErrorCodes.ER_XA_RBDEADLOCK:
				// Lock wait timeout / deadlock (and their XA-branch equivalents). The server rolled back the statement or transaction and asks to restart it.
				this.canRetry = autocommit && !inTrx ? CanRetry.QUERY : CanRetry.TRX;
				break;
			case ErrorCodes.ER_SERVER_SHUTDOWN:
			case ErrorCodes.ER_TOO_MANY_USER_CONNECTIONS:
			case ErrorCodes.ER_CON_COUNT_ERROR:
			case ErrorCodes.ER_USER_LIMIT_REACHED:
			case ErrorCodes.ER_CANT_CREATE_THREAD:
				// Server is shutting down, or a connection/resource limit was hit, or the server couldn't spawn a thread for the connection. Reconnecting (possibly after backoff) can recover.
				this.canRetry = CanRetry.CONN;
				break;
			default:
				this.canRetry = CanRetry.NONE;
		}
	}

	override toString()
	{	return `SQLSTATE ${this.sqlState}, error code ${this.errorCode}: ${this.message}`;
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
