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
		`isPrepare` means that this is query preparation operation (the query is not executed, but stored on the server).
		This function can return object that implements `SqlLoggerQuery` for further logging the query process.
		Query SQL (if any) will be handed to the methods of `SqlLoggerQuery`.
	 **/
	query?: (dsn: Dsn, connectionId: number, isPrepare: boolean, noBackslashEscapes: boolean) => Promise<SqlLoggerQuery | undefined>;

	/**	Prepared query deallocated (unprepared).
	 **/
	deallocatePrepare?: (dsn: Dsn, connectionId: number, stmtId: number) => Promise<unknown>;

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

export class SafeSqlLogger
{	#dsn;
	#underlying;
	#logger;

	constructor(dsn: Dsn, underlying: SqlLogger, logger: Logger)
	{	this.#dsn = dsn;
		this.#underlying = underlying;
		this.#logger = logger;
	}

	connect(connectionId: number)
	{	try
		{	return this.#underlying.connect?.(this.#dsn, connectionId) || Promise.resolve();
		}
		catch (e)
		{	this.#logger.error(e);
		}
		return Promise.resolve();
	}

	resetConnection(connectionId: number)
	{	try
		{	return this.#underlying.resetConnection?.(this.#dsn, connectionId) || Promise.resolve();
		}
		catch (e)
		{	this.#logger.error(e);
		}
		return Promise.resolve();
	}

	disconnect(connectionId: number)
	{	try
		{	return this.#underlying.disconnect?.(this.#dsn, connectionId) || Promise.resolve();
		}
		catch (e)
		{	this.#logger.error(e);
		}
		return Promise.resolve();
	}

	async query(connectionId: number, isPrepare: boolean, noBackslashEscapes: boolean): Promise<SafeSqlLoggerQuery| undefined>
	{	try
		{	const underlyingQuery = await this.#underlying.query?.(this.#dsn, connectionId, isPrepare, noBackslashEscapes);
			if (underlyingQuery)
			{	const logger = this.#logger;
				let curNParam = -1;
				const query =
				{	appendToQuery(data: Uint8Array)
					{	try
						{	return underlyingQuery.appendToQuery?.(data) ?? Promise.resolve();
						}
						catch (e)
						{	logger.error(e);
						}
						return Promise.resolve();
					},

					setStmtId(stmtId: number)
					{	try
						{	return underlyingQuery.setStmtId?.(stmtId) ?? Promise.resolve();
						}
						catch (e)
						{	logger.error(e);
						}
						return Promise.resolve();
					},

					paramStart(nParam: number)
					{	curNParam = nParam;
					},

					appendToParam(data: Uint8Array|number|bigint)
					{	try
						{	return underlyingQuery.appendToParam?.(curNParam, data) ?? Promise.resolve();
						}
						catch (e)
						{	logger.error(e);
						}
						return Promise.resolve();
					},

					paramEnd()
					{	try
						{	return underlyingQuery.paramEnd?.(curNParam) ?? Promise.resolve();
						}
						catch (e)
						{	logger.error(e);
						}
						return Promise.resolve();
					},

					nextQuery()
					{	try
						{	return underlyingQuery.nextQuery?.() ?? Promise.resolve();
						}
						catch (e)
						{	logger.error(e);
						}
						return Promise.resolve();
					},

					start()
					{	try
						{	return underlyingQuery.start?.() ?? Promise.resolve();
						}
						catch (e)
						{	logger.error(e);
						}
						return Promise.resolve();
					},

					end(result: Resultsets<unknown>|Error|undefined, stmtId: number)
					{	try
						{	return underlyingQuery.end?.(result, stmtId) ?? Promise.resolve();
						}
						catch (e)
						{	logger.error(e);
						}
						return Promise.resolve();
					}
				};
				return query;
			}
		}
		catch (e)
		{	this.#logger.error(e);
		}
	}

	deallocatePrepare(connectionId: number, stmtId: number)
	{	try
		{	return this.#underlying.deallocatePrepare?.(this.#dsn, connectionId, stmtId) || Promise.resolve();
		}
		catch (e)
		{	this.#logger.error(e);
		}
		return Promise.resolve();
	}

	dispose()
	{	try
		{	return this.#underlying.dispose?.() || Promise.resolve();
		}
		catch (e)
		{	this.#logger.error(e);
		}
		return Promise.resolve();
	}
}
