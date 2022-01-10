import {Resultsets} from "./resultsets.ts";
import {Dsn} from "./dsn.ts";
import {SqlLogger} from "./sql_logger.ts";
import {SqlLogToWriterBase} from "./sql_log_to_writer_base.ts";
import {Colors} from './deps.ts';

const C_APOS = "'".charCodeAt(0);
const C_BACKSLASH = '\\'.charCodeAt(0);

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
	{	return this.write(dsn, connectionId, 'CONNECT\n\n');
	}

	resetConnection(dsn: Dsn, connectionId: number)
	{	return this.write(dsn, connectionId, 'RESET CONNECTION\n\n');
	}

	disconnect(dsn: Dsn, connectionId: number)
	{	return this.write(dsn, connectionId, 'DISCONNECT\n\n');
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
		{	return this.write(dsn, connectionId, 'PREPARE FROM: ');
		}
		return Promise.resolve();
	}

	querySql(dsn: Dsn, connectionId: number, data: Uint8Array)
	{	return this.write(dsn, connectionId, data);
	}

	queryStart(dsn: Dsn, connectionId: number)
	{	return this.write(dsn, connectionId, '\n');
	}

	queryEnd(dsn: Dsn, connectionId: number, result: Resultsets<unknown>|Error, stmtId?: number)
	{	return this.logResult(dsn, connectionId, result, stmtId);
	}

	execNew(dsn: Dsn, connectionId: number, stmtId: number)
	{	this.since = Date.now();
		this.nQuery = 1;
		this.nQueries = 1;
		this.prevNParam = -1;
		return this.write(dsn, connectionId, `EXECUTE ${stmtId}`);
	}

	async execParam(dsn: Dsn, connectionId: number, nParam: number, data: Uint8Array|number|bigint|Date)
	{	const str = `${this.prevNParam==nParam ? '' : '\n'}\tBIND param_${nParam}=`;
		this.prevNParam = nParam;
		if (data instanceof Uint8Array)
		{	await this.write(dsn, connectionId, str);
			await this.writeSqlString(dsn, connectionId, data);
		}
		else
		{	await this.write(dsn, connectionId, str + data);
		}
	}

	execStart(dsn: Dsn, connectionId: number)
	{	return this.write(dsn, connectionId, '\n');
	}

	execEnd(dsn: Dsn, connectionId: number, result: Resultsets<unknown>|Error|undefined)
	{	return this.logResult(dsn, connectionId, result);
	}

	deallocatePrepare(dsn: Dsn, connectionId: number, stmtId: number)
	{	return this.write(dsn, connectionId, `DEALLOCATE PREPARE: ${stmtId}`);
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
			return this.write(dsn, connectionId, str);
		}
		return Promise.resolve();
	}

	private async writeSqlString(dsn: Dsn, connectionId: number, data: Uint8Array)
	{	let i = 0;
		let esc = "'";
		while (true)
		{	for (; ; i++)
			{	if (i >= data.length)
				{	esc += "'";
					break;
				}
				const c = data[i];
				if (c == C_APOS)
				{	esc += "\\'";
				}
				else if (c == C_BACKSLASH)
				{	esc += "\\\\";
				}
				else if (c < 0x10)
				{	esc += '\\x0';
					esc += c.toString(16);
				}
				else if (c < 0x20)
				{	esc += '\\x';
					esc += c.toString(16);
				}
				else
				{	break;
				}
			}
			if (esc)
			{	await this.write(dsn, connectionId, esc);
				if (i >= data.length)
				{	break;
				}
				esc = '';
			}
			const from = i;
			for (; i<data.length; i++)
			{	const c = data[i];
				if (c<0x20 || c==C_APOS || c==C_BACKSLASH)
				{	break;
				}
			}
			if (i > from)
			{	await this.write(dsn, connectionId, data.subarray(from, i));
			}
		}
	}
}
