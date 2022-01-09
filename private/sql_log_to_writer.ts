import {Resultsets} from "./resultsets.ts";
import {Dsn} from "./dsn.ts";
import {SqlLogger} from "./sql_logger.ts";
import {SqlLogToWriterBase} from "./sql_log_to_writer_base.ts";
import {Colors} from './deps.ts';

export class SqlLogToWriter extends SqlLogToWriterBase implements SqlLogger
{	private since = 0;
	private nQuery = 0;
	private nQueries = 0;
	private prevNParam = -1;

	private msgOk = 'OK';
	private msgError = 'ERROR:';

	constructor(protected writer: Deno.Writer, protected withColor=false)
	{	super(writer);
		if (withColor)
		{	this.msgOk = Colors.green('OK');
			this.msgError = Colors.red('ERROR:');
		}
	}

	protected nextConnBanner(dsn: Dsn, connectionId: number): Uint8Array|string|undefined
	{	const msg = `/* ${dsn.hostname} #${connectionId} */\n\n`;
		return this.withColor ? Colors.rgb8(msg, 36) : msg;
	}

	connect(dsn: Dsn, connectionId: number)
	{	this.write(dsn, connectionId, 'CONNECT\n\n');
	}

	resetConnection(dsn: Dsn, connectionId: number)
	{	this.write(dsn, connectionId, 'RESET CONNECTION\n\n');
	}

	disconnect(dsn: Dsn, connectionId: number)
	{	this.write(dsn, connectionId, 'DISCONNECT\n\n');
	}

	queryNew(dsn: Dsn, connectionId: number, isPrepare: boolean, previousResultNotRead: boolean)
	{	if (!previousResultNotRead)
		{	this.since = Date.now();
			this.nQuery = 1;
			this.nQueries = 1;
		}
		else
		{	this.nQuery++;
			this.nQueries = Math.max(this.nQuery, this.nQueries);
		}
		if (isPrepare)
		{	this.write(dsn, connectionId, 'PREPARE FROM: ');
		}
	}

	querySql(dsn: Dsn, connectionId: number, data: Uint8Array)
	{	this.write(dsn, connectionId, data);
	}

	queryStart(dsn: Dsn, connectionId: number)
	{	this.write(dsn, connectionId, '\n');
	}

	queryEnd(dsn: Dsn, connectionId: number, result: Resultsets<unknown>|Error, stmtId?: number)
	{	this.logResult(dsn, connectionId, result, stmtId);
	}

	execNew(dsn: Dsn, connectionId: number, stmtId: number)
	{	this.since = Date.now();
		this.nQuery = 1;
		this.nQueries = 1;
		this.prevNParam = -1;
		this.write(dsn, connectionId, `EXECUTE ${stmtId}`);
	}

	execParam(dsn: Dsn, connectionId: number, nParam: number, data: Uint8Array|number|bigint|Date)
	{	if (data instanceof Uint8Array)
		{	this.write(dsn, connectionId, `${this.prevNParam==nParam ? '' : '\n'}\tBIND param_${nParam}=`);
			this.write(dsn, connectionId, data);
		}
		else
		{	this.write(dsn, connectionId, `${this.prevNParam==nParam ? '' : '\n'}\tBIND param_${nParam}=${data}`);
		}
		this.prevNParam = nParam;
	}

	execStart(dsn: Dsn, connectionId: number)
	{	this.write(dsn, connectionId, '\n');
	}

	execEnd(dsn: Dsn, connectionId: number, result: Resultsets<unknown>|Error|undefined)
	{	this.logResult(dsn, connectionId, result);
	}

	deallocatePrepare(dsn: Dsn, connectionId: number, stmtId: number)
	{	this.write(dsn, connectionId, `DEALLOCATE PREPARE: ${stmtId}`);
	}

	private logResult(dsn: Dsn, connectionId: number, result: Resultsets<unknown>|Error|undefined, stmtId?: number)
	{	if (--this.nQuery == 0)
		{	let str = `\t${(Date.now()-this.since) / 1000} sec`;
			if (this.nQueries != 1)
			{	str += ` (${this.nQueries} queries)`;
			}
			if (!result)
			{	str += ` - ${this.msgOk}\n\n`;
			}
			else if (!(result instanceof Resultsets))
			{	str += ` - ${this.msgError} ${result.message}\n\n`;
			}
			else if (result.columns.length != 0)
			{	str += ` - ${this.msgOk} (${!stmtId ? '' : 'stmt_id='+stmtId+', '}${result.columns.length} columns)\n\n`;
			}
			else
			{	str += ` - ${this.msgOk} (${!stmtId ? '' : 'stmt_id='+stmtId+', '}${result.affectedRows} affected, ${result.foundRows} found, last_id ${result.lastInsertId})\n\n`;
			}
			this.write(dsn, connectionId, str);
		}
	}
}
