import {debugAssert} from "./debug_assert.ts";
import {Resultsets} from "./resultsets.ts";
import {Dsn} from "./dsn.ts";
import {SqlLogger} from "./sql_logger.ts";
import {SqlLogToWritableBase} from "./sql_log_to_writer_base.ts";
import {SqlWordsList} from "./sql_words_list.ts";
import {Colors} from './deps.ts';
import {Writer} from "./deno_ifaces.ts";
import {Logger} from "./my_protocol.ts";

const DEFAULT_QUERY_MAX_BYTES = 10_000;
const DEFAULT_PARAM_MAX_BYTES = 3_000;
const DEFAULT_MAX_LINES = 100;

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

const keywords = new SqlWordsList('USE SELECT DISTINCT AS FROM INNER LEFT RIGHT CROSS JOIN ON WHERE GROUP BY HAVING ORDER ASC DESC LIMIT OFFSET UNION INSERT INTO VALUES ON DUPLICATE KEY UPDATE SET DELETE REPLACE CREATE TABLE IF EXISTS DROP ALTER INDEX AUTO_INCREMENT PRIMARY FOREIGN REFERENCES CASCADE DEFAULT ADD CHANGE COLUMN SCHEMA DATABASE TRIGGER BEFORE AFTER EVENT CALL PROCEDURE FUNCTION BEGIN START TRANSACTION COMMIT ROLLBACK SAVEPOINT XA PREPARE FOR EACH ROW NOT AND OR XOR BETWEEN SEPARATOR IS NULL IN FALSE TRUE LIKE CHAR MATCH AGAINST INTERVAL YEAR MONTH WEEK DAY HOUR MINUTE SECOND MICROSECOND CASE WHEN THEN ELSE END BINARY COLLATE CHARSET');

export class SqlLogToWritable extends SqlLogToWritableBase implements SqlLogger
{	#msgOk = 'OK';
	#msgError = 'ERROR:';

	constructor
	(	writer: Writer|WritableStream<Uint8Array>,
		protected withColor = false,
		protected queryMaxBytes = DEFAULT_QUERY_MAX_BYTES,
		protected paramMaxBytes = DEFAULT_PARAM_MAX_BYTES,
		protected maxLines = DEFAULT_MAX_LINES,
		logger: Logger = console,
	)
	{	super(writer, logger);
		if (withColor)
		{	this.#msgOk = Colors.green('OK');
			this.#msgError = Colors.red('ERROR:');
		}
	}

	protected nextConnBanner(dsn: Dsn, connectionId: number): Uint8Array|string|undefined
	{	const msg = `\n/* ${dsn.hostname} #${connectionId} */\n\n`;
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

	query(dsn: Dsn, connectionId: number, isPrepare: boolean, noBackslashEscapes: boolean)
	{	// deno-lint-ignore no-this-alias
		const that = this;
		const {queryMaxBytes, paramMaxBytes, maxLines, withColor} = this;
		const msgOk = this.#msgOk;
		const msgError = this.#msgError;
		const since = Date.now();
		let curNParam = -1;
		let curDataLen = 0;
		let curNFullLines = 0;
		let limit = queryMaxBytes;
		let nQueries = 1;

		function countExceeding(data: Uint8Array)
		{	// 1. Cut white space at the beginning
			if (curDataLen == 0)
			{	let nSpaces = 0;
				for (const iEnd=data.length; nSpaces<iEnd; nSpaces++)
				{	const c = data[nSpaces];
					if (c!=C_SPACE && c!=C_TAB && c!=C_CR && c!=C_LF)
					{	break;
					}
				}
				if (nSpaces > 0)
				{	data = data.subarray(nSpaces);
				}
			}
			// 2. Count bytes
			curDataLen += data.length;
			// 3. Count lines
			if (curNFullLines < maxLines)
			{	for (let i=0, iEnd=data.length; i<iEnd; i++)
				{	const c = data[i];
					if (c==C_CR || c==C_LF)
					{	if (++curNFullLines >= maxLines)
						{	return data.subarray(0, i);
						}
						if (c==C_CR && data[i+1]===C_LF)
						{	i++;
						}
					}
				}
			}
			// 4. Limit the data
			const exceedingNegative = limit - curDataLen;
			if (exceedingNegative < 0)
			{	data = data.subarray(0, exceedingNegative); // negative index (from the end of the array)
			}
			return data;
		}

		function start()
		{	const withEllipsis = curDataLen>limit || curNFullLines>=maxLines;
			curNParam = -1;
			curDataLen = 0;
			curNFullLines = 0;
			limit = queryMaxBytes;
			return that.write(dsn, connectionId, !withEllipsis ? '\n' : !withColor ? `…(${curDataLen} bytes)\n` : `${RESET_COLOR}…${COLOR_SQL_COMMENT}(${curDataLen} bytes)${RESET_COLOR}\n`);
		}

		return Promise.resolve
		(	{	async appendToQuery(data: Uint8Array)
				{	limit = queryMaxBytes;
					if (isPrepare)
					{	await that.write(dsn, connectionId, 'PREPARE FROM: ');
						isPrepare = false;
					}
					data = countExceeding(data);
					if (withColor)
					{	await that.#writeColoredSql(dsn, connectionId, data, noBackslashEscapes);
					}
					else
					{	await that.write(dsn, connectionId, data);
					}
				},

				setStmtId(stmtId: number)
				{	return that.write(dsn, connectionId, `EXECUTE stmt_id=${stmtId}`);
				},

				async appendToParam(nParam: number, data: Uint8Array|number|bigint)
				{	let str = '';
					if (!(data instanceof Uint8Array))
					{	str = `\n\tBIND param_${nParam}=`;
						curDataLen = -1;
					}
					else if (nParam != curNParam)
					{	str = `\n\tBIND param_${nParam}=`;
						curNParam = nParam;
						curDataLen = 0;
						curNFullLines = 0;
						limit = paramMaxBytes;
					}
					if (data instanceof Uint8Array)
					{	if (str)
						{	await that.write(dsn, connectionId, str);
						}
						data = countExceeding(data);
						await that.#writeSqlString(dsn, connectionId, data);
					}
					else
					{	await that.write(dsn, connectionId, str + data);
					}
				},

				paramEnd(_nParam: number)
				{	return Promise.resolve();
				},

				nextQuery()
				{	nQueries++;
					return start();
				},

				start,

				end(result: Resultsets<unknown>|Error|undefined, stmtId: number)
				{	let str = `\t${(Date.now()-since) / 1000} sec`;
					if (nQueries != 1)
					{	str += ` (${nQueries} queries)`;
					}
					if (!result)
					{	str += ` - ${msgOk}\n\n`;
					}
					else if (!(result instanceof Resultsets))
					{	str += ` - ${msgError} ${result.message}\n\n`;
					}
					else if (result.columns.length != 0)
					{	str += ` - ${msgOk} (${stmtId==-1 ? '' : 'stmt_id='+stmtId+', '}${result.columns.length} columns)\n\n`;
					}
					else
					{	str += ` - ${msgOk} (${stmtId==-1 ? '' : 'stmt_id='+stmtId+', '}${result.affectedRows} affected, ${result.foundRows} found, last_id ${result.lastInsertId})\n\n`;
					}
					return that.write(dsn, connectionId, str);
				},
			}
		);
	}

	deallocatePrepare(dsn: Dsn, connectionId: number, stmtId: number)
	{	return this.write(dsn, connectionId, `DEALLOCATE PREPARE stmt_id=${stmtId}`);
	}

	async #writeSqlString(dsn: Dsn, connectionId: number, data: Uint8Array)
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

	async #writeColoredSql(dsn: Dsn, connectionId: number, data: Uint8Array, noBackslashEscapes: boolean)
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

/**	Please, use new class called `SqlLogToWritable` that has the same functionality as old `SqlLogToWriter`,
	plus it supports `WritableStream<Uint8Array>`.
	@deprecated
 **/
export class SqlLogToWriter extends SqlLogToWritable
{
}
