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

/**	send_with_data() throws it if failed to send data to server.
 **/
export class SendWithDataError extends Error
{	constructor(message: string, public packetSize: number)
	{	super(packetSize<1*1024*1024 ? message : `${message} - Please make sure that this server accepts packets of this size: ${packetSize} bytes. See "SHOW VARIABLES LIKE 'max_allowed_packet'"`);
	}
}
