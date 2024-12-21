import {Resultsets} from "./resultsets.ts";
import {Logger} from "./my_protocol.ts";
import {Dsn} from "./dsn.ts";

/**	@category SQL Logging
 **/
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
		`isPrepare` means that this is query preparation operation (the query is not executed, but stored on the server).
		This function can return object that implements `SqlLoggerQuery` for further logging the query process.
		Query SQL (if any) will be handed to the methods of `SqlLoggerQuery`.
	 **/
	query?: (dsn: Dsn, connectionId: number, isPrepare: boolean, noBackslashEscapes: boolean) => Promise<SqlLoggerQuery | undefined>;

	/**	Deallocated prepared query or multiple queries indentified by their `stmtIds`.
	 **/
	deallocatePrepare?: (dsn: Dsn, connectionId: number, stmtIds: number[]) => Promise<unknown>;

	/**	This callback is called when current `MyConn` object is disposed of. This happens at the end of `MyPool.forConn()`, or at the end of a block with `using conn = ...`.
	 **/
	dispose?: () => Promise<unknown>;
}

/**	1. First one of `appendToQuery()` or `setStmtId()` is called.
	To start writing a regular query, `appendToQuery()` is called one or multiple times.
	To write a prepared query, `setStmtId()` is called (once).
	2. Then, in case of prepared query, a sequence of `appendToParam()` (one or multiple times) and `paramEnd()` can be called.
	3. Then, if writing queries batch, `nextQuery()` is called, and the process repeats from the beginning.
	4. Then, after all the queries in batch are written, `start()` is called. At this point queries are sent to the database server.
	5. Then, when the server responds, `end()` is called.
	@category SQL Logging
 **/
export interface SqlLoggerQuery
{	appendToQuery?: (data: Uint8Array) => Promise<unknown>;

	setStmtId?: (stmtId: number) => Promise<unknown>;

	appendToParam?: (nParam: number, data: Uint8Array|number|bigint) => Promise<unknown>;

	paramEnd?: (nParam: number) => Promise<unknown>;

	nextQuery?: () => Promise<unknown>;

	start?: () => Promise<unknown>;

	/**	If this was query preparation (`SqlLogger.query(_, _, true)`), `stmtId` will be the statement ID that the server returned.
		Else `stmtId` will be `-1`.
	 **/
	end?: (result: Resultsets<unknown>|Error|undefined, stmtId: number) => Promise<unknown>;
}

/**	Like {@link SqlLoggerQuery}, but all functions are non-optional, and uses `paramStart()` instead of `nParam` argument in `appendToParam()` and `paramEnd()`.
	@category SQL Logging
 **/
export interface SafeSqlLoggerQuery
{	appendToQuery: (data: Uint8Array) => Promise<unknown>;
	setStmtId: (stmtId: number) => Promise<unknown>;
	paramStart: (nParam: number) => void;
	appendToParam: (data: Uint8Array|number|bigint) => Promise<unknown>;
	paramEnd: () => Promise<unknown>;
	nextQuery: () => Promise<unknown>;
	start: () => Promise<unknown>;
	end: (result: Resultsets<unknown>|Error|undefined, stmtId: number) => Promise<unknown>;
}

/**	@category SQL Logging
 **/
export class SafeSqlLogger
{	#dsn;
	#underlying;
	#logger;

	constructor(dsn: Dsn, underlying: SqlLogger, logger: Logger)
	{	this.#dsn = dsn;
		this.#underlying = underlying;
		this.#logger = logger;
	}

	async connect(connectionId: number)
	{	try
		{	return await this.#underlying.connect?.(this.#dsn, connectionId) ;
		}
		catch (e)
		{	this.#logger.error(e);
		}
	}

	async resetConnection(connectionId: number)
	{	try
		{	return await this.#underlying.resetConnection?.(this.#dsn, connectionId);
		}
		catch (e)
		{	this.#logger.error(e);
		}
	}

	async disconnect(connectionId: number)
	{	try
		{	return await this.#underlying.disconnect?.(this.#dsn, connectionId);
		}
		catch (e)
		{	this.#logger.error(e);
		}
	}

	async query(connectionId: number, isPrepare: boolean, noBackslashEscapes: boolean): Promise<SafeSqlLoggerQuery| undefined>
	{	try
		{	const underlyingQuery = await this.#underlying.query?.(this.#dsn, connectionId, isPrepare, noBackslashEscapes);
			if (underlyingQuery)
			{	const logger = this.#logger;
				let curNParam = -1;
				const query =
				{	async appendToQuery(data: Uint8Array)
					{	try
						{	return await underlyingQuery.appendToQuery?.(data);
						}
						catch (e)
						{	logger.error(e);
						}
					},

					async setStmtId(stmtId: number)
					{	try
						{	return await underlyingQuery.setStmtId?.(stmtId);
						}
						catch (e)
						{	logger.error(e);
						}
					},

					paramStart(nParam: number)
					{	curNParam = nParam;
					},

					async appendToParam(data: Uint8Array|number|bigint)
					{	try
						{	return await underlyingQuery.appendToParam?.(curNParam, data);
						}
						catch (e)
						{	logger.error(e);
						}
					},

					async paramEnd()
					{	try
						{	return await underlyingQuery.paramEnd?.(curNParam);
						}
						catch (e)
						{	logger.error(e);
						}
					},

					async nextQuery()
					{	try
						{	return await underlyingQuery.nextQuery?.();
						}
						catch (e)
						{	logger.error(e);
						}
					},

					async start()
					{	try
						{	return await underlyingQuery.start?.();
						}
						catch (e)
						{	logger.error(e);
						}
					},

					async end(result: Resultsets<unknown>|Error|undefined, stmtId: number)
					{	try
						{	return await underlyingQuery.end?.(result, stmtId);
						}
						catch (e)
						{	logger.error(e);
						}
					}
				};
				return query;
			}
		}
		catch (e)
		{	this.#logger.error(e);
		}
	}

	async deallocatePrepare(connectionId: number, stmtIds: number[])
	{	try
		{	return await this.#underlying.deallocatePrepare?.(this.#dsn, connectionId, stmtIds);
		}
		catch (e)
		{	this.#logger.error(e);
		}
	}

	async dispose()
	{	try
		{	return await this.#underlying.dispose?.();
		}
		catch (e)
		{	this.#logger.error(e);
		}
	}
}
