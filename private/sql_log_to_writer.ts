import {debugAssert} from "./debug_assert.ts";
import {Resultsets} from "./resultsets.ts";
import {Dsn} from "./dsn.ts";
import {SqlLogger} from "./sql_logger.ts";
import {SqlLogToWriterBase} from "./sql_log_to_writer_base.ts";
import {SqlWordsList} from "./sql_words_list.ts";
import {Colors} from './deps.ts';

const C_APOS = "'".charCodeAt(0);
const C_QUOT = '"'.charCodeAt(0);
const C_BACKTICK = '`'.charCodeAt(0);
const C_BACKSLASH = '\\'.charCodeAt(0);
const C_SLASH = '/'.charCodeAt(0);
const C_TIMES = '*'.charCodeAt(0);
const C_MINUS = '-'.charCodeAt(0);
const C_A_CAP = 'A'.charCodeAt(0);
const C_Z_CAP = 'Z'.charCodeAt(0);
const C_A = 'a'.charCodeAt(0);
const C_Z = 'z'.charCodeAt(0);
const C_UNDERSCORE = '_'.charCodeAt(0);
const C_ZERO = '0'.charCodeAt(0);
const C_NINE = '9'.charCodeAt(0);
const C_DOLLAR = '$'.charCodeAt(0);
const C_HASH = '#'.charCodeAt(0);
const C_CR = '\r'.charCodeAt(0);
const C_LF = '\n'.charCodeAt(0);
const C_SPACE = ' '.charCodeAt(0);
const C_TAB = '\t'.charCodeAt(0);

const COLOR_SQL_KEYWORD = Colors.rgb8('', 21).slice(0, Colors.rgb8('', 21).indexOf('m')+1);
const COLOR_SQL_STRING = Colors.rgb8('', 201).slice(0, Colors.rgb8('', 201).indexOf('m')+1);
const COLOR_SQL_QUOTED_IDENT = Colors.rgb8('', 52).slice(0, Colors.rgb8('', 52).indexOf('m')+1);
const COLOR_SQL_COMMENT = Colors.rgb8('', 244).slice(0, Colors.rgb8('', 244).indexOf('m')+1);
const RESET_COLOR = '\x1B[0m';

const keywords = new SqlWordsList('USE SELECT DISTINCT AS FROM INNER LEFT RIGHT CROSS JOIN ON WHERE GROUP BY HAVING ORDER ASC DESC LIMIT OFFSET UNION INSERT INTO VALUES ON DUPLICATE KEY UPDATE SET DELETE REPLACE CREATE TABLE IF EXISTS DROP ALTER INDEX AUTO_INCREMENT PRIMARY FOREIGN REFERENCES CASCADE DEFAULT ADD CHANGE COLUMN SCHEMA DATABASE TRIGGER BEFORE AFTER PROCEDURE FUNCTION BEGIN START TRANSACTION COMMIT ROLLBACK SAVEPOINT XA PREPARE FOR EACH ROW NOT AND OR XOR BETWEEN SEPARATOR IS NULL IN FALSE TRUE LIKE CHAR MATCH AGAINST INTERVAL YEAR MONTH WEEK DAY HOUR MINUTE SECOND MICROSECOND CASE WHEN THEN ELSE END BINARY COLLATE CHARSET');

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
		return this.withColor ? COLOR_SQL_COMMENT+msg+RESET_COLOR : msg;
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

	querySql(dsn: Dsn, connectionId: number, data: Uint8Array, noBackslashEscapes: boolean)
	{	if (this.withColor)
		{	return this.writeColoredSql(dsn, connectionId, data, noBackslashEscapes);
		}
		else
		{	return this.write(dsn, connectionId, data);
		}
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
		return this.write(dsn, connectionId, `EXECUTE stmt_id=${stmtId}`);
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
	{	return this.write(dsn, connectionId, `DEALLOCATE PREPARE stmt_id=${stmtId}`);
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
		let esc = this.withColor ? COLOR_SQL_STRING+"'" : "'";
		while (true)
		{	for (; ; i++)
			{	if (i >= data.length)
				{	esc += this.withColor ? "'"+RESET_COLOR : "'";
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

	private async writeColoredSql(dsn: Dsn, connectionId: number, data: Uint8Array, noBackslashEscapes: boolean)
	{	let i = 0;
		const enum Type {DEFAULT, KEYWORD, STRING, QUOTED_IDENT, COMMENT}
		const COLORS = [RESET_COLOR, COLOR_SQL_KEYWORD, COLOR_SQL_STRING, COLOR_SQL_QUOTED_IDENT, COLOR_SQL_COMMENT];
		function nextToken()
		{	let c = data[i];
			if ((c>=C_A_CAP && c<=C_Z_CAP || c>=C_A && c<=C_Z || c==C_UNDERSCORE || c==C_DOLLAR || c>=0x80) && (i==0 || data[i-1]<C_ZERO || data[i-1]>C_NINE))
			{	// word
				const from = i;
				c = data[++i];
				while (c>=C_A_CAP && c<=C_Z_CAP || c>=C_A && c<=C_Z || c==C_UNDERSCORE || c==C_DOLLAR || c>=0x80 || c>=C_ZERO && c<=C_NINE)
				{	c = data[++i];
				}
				return keywords.contains(data.subarray(from, i)) ? Type.KEYWORD : Type.DEFAULT;
			}
			else if (c==C_APOS || c==C_QUOT || c==C_BACKTICK)
			{	const qt = c;
				while (++i < data.length)
				{	c = data[i];
					if (c==C_BACKSLASH && !noBackslashEscapes && qt!=C_BACKTICK)
					{	i++;
					}
					else if (c == qt)
					{	i++;
						break;
					}
				}
				return qt==C_BACKTICK ? Type.QUOTED_IDENT : Type.STRING;
			}
			else if (c==C_HASH || c==C_MINUS && data[i+1]==C_MINUS && (data[i+2]==C_SPACE || data[i+2]==C_TAB))
			{	while (++i < data.length)
				{	c = data[i];
					if (c==C_CR || c==C_LF)
					{	break;
					}
				}
				return Type.COMMENT;
			}
			else if (c==C_SLASH && data[i+1]==C_TIMES)
			{	i++;
				while (++i < data.length)
				{	if (data[i]==C_TIMES || data[i+1]==C_SLASH)
					{	i += 2;
						break;
					}
				}
				return Type.COMMENT;
			}
			i++;
			return Type.DEFAULT;
		}
		let from = 0;
		let type = Type.DEFAULT;
		let esc = RESET_COLOR;
		while (true)
		{	const prevType: Type = type;
			let newFrom;
			while ((newFrom = i)<data.length && (type = nextToken())==prevType);
			if (newFrom > from)
			{	await this.write(dsn, connectionId, data.subarray(from, newFrom));
			}
			if (type == prevType)
			{	debugAssert(i >= data.length);
				break;
			}
			esc = COLORS[type];
			await this.write(dsn, connectionId, esc);
			from = newFrom;
		}
		if (esc != RESET_COLOR)
		{	await this.write(dsn, connectionId, RESET_COLOR);
		}
	}
}
