import {Resultsets} from "./resultsets.ts";
import {Logger} from "./my_protocol.ts";
import {Dsn} from "./dsn.ts";

export interface SqlLogger
{	/**	A new connection established.
	 **/
	connect?: (dsn: Dsn, connectionId: number) => Promise<unknown>;

	/**	Connection state reset (before returning this connection to it's pool).
	 **/
	resetConnection?: (dsn: Dsn, connectionId: number) => Promise<unknown>;

	/**	Disconnected.
	 **/
	disconnect?: (dsn: Dsn, connectionId: number) => Promise<unknown>;

	/**	Started to send a new query to the server.
		`isPrepare` means that this is query preparation operation, and following `queryEnd()` will receive `stmtId` that server returned.
		`previousResultNotRead` means that i'm sending queries batch without reading results. `queryEnd()` of previous query will be called later, but before the `queryEnd()` of this query.
		In other words, i can call the sequence of `queryNew()`, `querySql()`, `queryStart()` several times, and then call `queryEnd()` corresponding number of times.
	 **/
	queryNew?: (dsn: Dsn, connectionId: number, isPrepare: boolean, previousResultNotRead: boolean) => Promise<unknown>;

	/**	After `queryNew()` called, i can call `querySql()` one or several times (in case of error even 0 times).
		Each call to `querySql()` appends more bytes to current SQL query.
		`data` is SQL query serialized to bytes (you can use `TextDecoder` to restore the original SQL string).
		The query SQL always comes as bytes, no matter what you passed to `conn.query()` function (bytes, string, `Deno.Reader`, etc).
		Since `data` is a pointer to internal buffer (that is changing all the time), you need to use the `data` immediately (without await), or to copy it to another variable.
	 **/
	querySql?: (dsn: Dsn, connectionId: number, data: Uint8Array, noBackslashEscapes: boolean) => Promise<unknown>;

	/**	After `queryNew()` and one or more `querySql()` called, i call `queryStart()`.
		At this point the query is sent to the server.
	 **/
	queryStart?: (dsn: Dsn, connectionId: number) => Promise<unknown>;

	/**	Query completed (it's result status is read from the server, but rows, if any, are not yet read).
		The query can either complete with success or with error.
		If this was query preparation, the `stmtId` will be the numeric ID of this prepared statement.
	 **/
	queryEnd?: (dsn: Dsn, connectionId: number, result: Resultsets<unknown>|Error, stmtId?: number) => Promise<unknown>;

	/**	Started executing a prepared statement.
	 **/
	execNew?: (dsn: Dsn, connectionId: number, stmtId: number) => Promise<unknown>;

	/**	After `execNew()` called, i can call `execParam()` zero or more times to bind parameter values.
		I can call `execParam()` for the same parameter several times - each time appends data to the parameter.
		If i don't call `execParam()` for some parameter, this means that it's value is NULL.
		Strings and `Deno.Reader`s always come as `Uint8Array`.
		Since `data` is a pointer to internal buffer (that is changing all the time), you need to use the `data` immediately (without await), or to copy it to another variable.
	 **/
	execParam?: (dsn: Dsn, connectionId: number, nParam: number, data: Uint8Array|number|bigint|Date) => Promise<unknown>;

	/**	After `execNew()` and zero or more `execParam()` called, i call `execStart()`.
		At this point the query parameters are sent to the server.
	 **/
	execStart?: (dsn: Dsn, connectionId: number) => Promise<unknown>;

	/**	Query completed (it's result status is read from the server, but rows, if any, are not yet read).
		The query can either complete with success or with error.
		`result` can be undefined for internal queries.
	 **/
	execEnd?: (dsn: Dsn, connectionId: number, result: Resultsets<unknown>|Error|undefined) => Promise<unknown>;

	/**	Prepared query deallocated (unprepared).
	 **/
	deallocatePrepare?: (dsn: Dsn, connectionId: number, stmtId: number) => Promise<unknown>;

	/**	I'll call this function when `MyPool.shutdown()` is called.
	 **/
	shutdown?: () => Promise<unknown>;
}

export class SafeSqlLogger
{	constructor(private dsn: Dsn, private connectionId: number, private underlying: SqlLogger, private logger: Logger)
	{
	}

	connect()
	{	try
		{	const {underlying} = this;
			if (underlying.connect)
			{	return underlying.connect(this.dsn, this.connectionId);
			}
		}
		catch (e)
		{	this.logger.error(e);
		}
		return Promise.resolve();
	}

	resetConnection()
	{	try
		{	const {underlying} = this;
			if (underlying.resetConnection)
			{	return underlying.resetConnection(this.dsn, this.connectionId);
			}
		}
		catch (e)
		{	this.logger.error(e);
		}
		return Promise.resolve();
	}

	disconnect()
	{	try
		{	const {underlying} = this;
			if (underlying.disconnect)
			{	return underlying.disconnect(this.dsn, this.connectionId);
			}
		}
		catch (e)
		{	this.logger.error(e);
		}
		return Promise.resolve();
	}

	queryNew(isPrepare: boolean, previousResultNotRead: boolean)
	{	try
		{	const {underlying} = this;
			if (underlying.queryNew)
			{	return underlying.queryNew(this.dsn, this.connectionId, isPrepare, previousResultNotRead);
			}
		}
		catch (e)
		{	this.logger.error(e);
		}
		return Promise.resolve();
	}

	querySql(data: Uint8Array, noBackslashEscapes: boolean)
	{	try
		{	const {underlying} = this;
			if (underlying.querySql)
			{	return underlying.querySql(this.dsn, this.connectionId, data, noBackslashEscapes);
			}
		}
		catch (e)
		{	this.logger.error(e);
		}
		return Promise.resolve();
	}

	queryStart()
	{	try
		{	const {underlying} = this;
			if (underlying.queryStart)
			{	return underlying.queryStart(this.dsn, this.connectionId);
			}
		}
		catch (e)
		{	this.logger.error(e);
		}
		return Promise.resolve();
	}

	queryEnd(result: Resultsets<unknown>|Error, stmtId?: number)
	{	try
		{	const {underlying} = this;
			if (underlying.queryEnd)
			{	return underlying.queryEnd(this.dsn, this.connectionId, result, stmtId);
			}
		}
		catch (e)
		{	this.logger.error(e);
		}
		return Promise.resolve();
	}

	execNew(stmtId: number)
	{	try
		{	const {underlying} = this;
			if (underlying.execNew)
			{	return underlying.execNew(this.dsn, this.connectionId, stmtId);
			}
		}
		catch (e)
		{	this.logger.error(e);
		}
		return Promise.resolve();
	}

	execParam(nParam: number, data: Uint8Array|number|bigint|Date)
	{	try
		{	const {underlying} = this;
			if (underlying.execParam)
			{	return underlying.execParam(this.dsn, this.connectionId, nParam, data);
			}
		}
		catch (e)
		{	this.logger.error(e);
		}
		return Promise.resolve();
	}

	execStart()
	{	try
		{	const {underlying} = this;
			if (underlying.execStart)
			{	return underlying.execStart(this.dsn, this.connectionId);
			}
		}
		catch (e)
		{	this.logger.error(e);
		}
		return Promise.resolve();
	}

	execEnd(result: Resultsets<unknown>|Error|undefined)
	{	try
		{	const {underlying} = this;
			if (underlying.execEnd)
			{	return underlying.execEnd(this.dsn, this.connectionId, result);
			}
		}
		catch (e)
		{	this.logger.error(e);
		}
		return Promise.resolve();
	}

	deallocatePrepare(stmtId: number)
	{	try
		{	const {underlying} = this;
			if (underlying.deallocatePrepare)
			{	return underlying.deallocatePrepare(this.dsn, this.connectionId, stmtId);
			}
		}
		catch (e)
		{	this.logger.error(e);
		}
		return Promise.resolve();
	}
}
