import {Resultsets} from "./resultsets.ts";
import {Logger} from "./my_protocol.ts";
import {Dsn} from "./dsn.ts";

export interface SqlLogger
{	/**	A new connection established.
	 **/
	connect?: (dsn: Dsn, connectionId: number) => unknown;

	/**	Connection state reset (before returning this connection to it's pool).
	 **/
	resetConnection?: (dsn: Dsn, connectionId: number) => unknown;

	/**	Disconnected.
	 **/
	disconnect?: (dsn: Dsn, connectionId: number) => unknown;

	/**	Started to send a new query to the server.
		`isPrepare` means that this is query preparation operation, and following `queryEnd()` will receive `stmtId` that server returned.
		`previousResultNotRead` means that i'm sending queries batch without reading results. `queryEnd()` of previous query will be called later, but before the `queryEnd()` of this query.
		In other words, i can call the sequence of `queryNew()`, `querySql()`, `queryStart()` several times, and then call `queryEnd()` corresponding number of times.
	 **/
	queryNew?: (dsn: Dsn, connectionId: number, isPrepare: boolean, previousResultNotRead: boolean) => unknown;

	/**	After `queryNew()` called, i can call `querySql()` one or several times (in case of error even 0 times).
		Each call to `querySql()` appends more bytes to current SQL query.
		`data` is SQL query serialized to bytes (you can use `TextDecoder` to restore the original SQL string).
		The query SQL always comes as bytes, no matter what you passed to `conn.query()` function (bytes, string, `Deno.Reader`, etc).
		Since `data` is a pointer to internal buffer (that is changing all the time), you need to use the `data` immediately (without await), or to copy it to another variable.
	 **/
	querySql?: (dsn: Dsn, connectionId: number, data: Uint8Array) => unknown;

	/**	After `queryNew()` and one or more `querySql()` called, i call `queryStart()`.
		At this point the query is sent to the server.
	 **/
	queryStart?: (dsn: Dsn, connectionId: number) => unknown;

	/**	Query completed (it's result status is read from the server, but rows, if any, are not yet read).
		The query can either complete with success or with error.
		If this was query preparation, the `stmtId` will be the numeric ID of this prepared statement.
	 **/
	queryEnd?: (dsn: Dsn, connectionId: number, result: Resultsets<unknown>|Error, stmtId?: number) => unknown;

	/**	Started executing a prepared statement.
	 **/
	execNew?: (dsn: Dsn, connectionId: number, stmtId: number) => unknown;

	/**	After `execNew()` called, i can call `execParam()` zero or more times to bind parameter values.
		I can call `execParam()` for the same parameter several times - each time appends data to the parameter.
		If i don't call `execParam()` for some parameter, this means that it's value is NULL.
		Strings and `Deno.Reader`s always come as `Uint8Array`.
		Since `data` is a pointer to internal buffer (that is changing all the time), you need to use the `data` immediately (without await), or to copy it to another variable.
	 **/
	execParam?: (dsn: Dsn, connectionId: number, nParam: number, data: Uint8Array|number|bigint|Date) => unknown;

	/**	After `execNew()` and zero or more `execParam()` called, i call `execStart()`.
		At this point the query parameters are sent to the server.
	 **/
	execStart?: (dsn: Dsn, connectionId: number) => unknown;

	/**	Query completed (it's result status is read from the server, but rows, if any, are not yet read).
		The query can either complete with success or with error.
		`result` can be undefined for internal queries.
	 **/
	execEnd?: (dsn: Dsn, connectionId: number, result: Resultsets<unknown>|Error|undefined) => unknown;

	/**	Prepared query deallocated (unprepared).
	 **/
	deallocatePrepare?: (dsn: Dsn, connectionId: number, stmtId: number) => unknown;

	/**	I'll call this function when `MyPool.shutdown()` is called.
	 **/
	shutdown?: () => Promise<void>;
}

export class SafeSqlLogger
{	constructor(private dsn: Dsn, private connectionId: number, private underlying: SqlLogger, private logger: Logger)
	{
	}

	connect()
	{	try
		{	this.underlying.connect?.(this.dsn, this.connectionId);
		}
		catch (e)
		{	this.logger.error(e);
		}
	}

	resetConnection()
	{	try
		{	this.underlying.resetConnection?.(this.dsn, this.connectionId);
		}
		catch (e)
		{	this.logger.error(e);
		}
	}

	disconnect()
	{	try
		{	this.underlying.disconnect?.(this.dsn, this.connectionId);
		}
		catch (e)
		{	this.logger.error(e);
		}
	}

	queryNew(isPrepare: boolean, previousResultNotRead: boolean)
	{	try
		{	this.underlying.queryNew?.(this.dsn, this.connectionId, isPrepare, previousResultNotRead);
		}
		catch (e)
		{	this.logger.error(e);
		}
	}

	querySql(data: Uint8Array)
	{	try
		{	this.underlying.querySql?.(this.dsn, this.connectionId, data);
		}
		catch (e)
		{	this.logger.error(e);
		}
	}

	queryStart()
	{	try
		{	this.underlying.queryStart?.(this.dsn, this.connectionId);
		}
		catch (e)
		{	this.logger.error(e);
		}
	}

	queryEnd(result: Resultsets<unknown>|Error, stmtId?: number)
	{	try
		{	this.underlying.queryEnd?.(this.dsn, this.connectionId, result, stmtId);
		}
		catch (e)
		{	this.logger.error(e);
		}
	}

	execNew(stmtId: number)
	{	try
		{	this.underlying.execNew?.(this.dsn, this.connectionId, stmtId);
		}
		catch (e)
		{	this.logger.error(e);
		}
	}

	execParam(nParam: number, data: Uint8Array|number|bigint|Date)
	{	try
		{	this.underlying.execParam?.(this.dsn, this.connectionId, nParam, data);
		}
		catch (e)
		{	this.logger.error(e);
		}
	}

	execStart()
	{	try
		{	this.underlying.execStart?.(this.dsn, this.connectionId);
		}
		catch (e)
		{	this.logger.error(e);
		}
	}

	execEnd(result: Resultsets<unknown>|Error|undefined)
	{	try
		{	this.underlying.execEnd?.(this.dsn, this.connectionId, result);
		}
		catch (e)
		{	this.logger.error(e);
		}
	}

	deallocatePrepare(stmtId: number)
	{	try
		{	this.underlying.deallocatePrepare?.(this.dsn, this.connectionId, stmtId);
		}
		catch (e)
		{	this.logger.error(e);
		}
	}
}
