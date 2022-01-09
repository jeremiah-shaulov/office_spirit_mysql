import {debugAssert} from "./debug_assert.ts";
import {reallocAppend} from "./realloc_append.ts";
import {Dsn} from "./dsn.ts";
import {SqlLogger} from "./sql_logger.ts";
import {Resultsets} from "./resultsets.ts";
import {writeAll} from "./deps.ts";

const encoder = new TextEncoder;

export class SqlLogToWriterBase implements SqlLogger
{	private pending = new Map<Dsn, Map<number, Uint8Array>>();
	private ongoing: Promise<void> | undefined;
	private prevDsn: Dsn | undefined;
	private prevConnectionId = -1;
	private isShutDown = false;

	constructor(protected writer: Deno.Writer)
	{
	}

	protected write(dsn: Dsn, connectionId: number, data: Uint8Array|string)
	{	if (this.isShutDown)
		{	throw new Error("This logger is shut down");
		}
		if (typeof(data) == 'string')
		{	data = encoder.encode(data);
		}
		if (data.length == 0)
		{	return;
		}
		// byConn
		let byConn = this.pending.get(dsn);
		if (!byConn)
		{	byConn = new Map();
			this.pending.set(dsn, byConn);
		}
		// buf
		let buf = byConn.get(connectionId);
		if (!buf)
		{	buf = new Uint8Array(8*1024).subarray(0, 0);
			byConn.set(connectionId, buf);
		}
		// add
		const newBuf = reallocAppend(buf, data, true);
		byConn.set(connectionId, newBuf);
		// ongoing
		if (!this.ongoing)
		{	this.ongoing = this.doTask();
		}
	}

	private async doTask()
	{	while (true)
		{	// byConn
			const dsn: Dsn|undefined = this.pending.keys().next().value;
			if (!dsn)
			{	break;
			}
			// connectionId
			while (true)
			{	const byConn = this.pending.get(dsn);
				if (!byConn)
				{	break;
				}
				const connectionId: number|undefined = byConn.keys().next().value;
				debugAssert(connectionId != undefined); // i don't keep byConn with `byConn.size == 0`
				// buf
				while (true)
				{	let buf = byConn.get(connectionId);
					if (buf)
					{	if (connectionId!=this.prevConnectionId || dsn!=this.prevDsn)
						{	this.prevDsn = dsn;
							this.prevConnectionId = connectionId;
							let banner = this.nextConnBanner(dsn, connectionId);
							if (banner)
							{	if (typeof(banner) == 'string')
								{	banner = encoder.encode(banner);
								}
								await writeAll(this.writer, banner);
							}
						}
						const n = await this.writer.write(buf);
						buf = byConn.get(connectionId);
						if (!buf || n==buf.length)
						{	byConn.delete(connectionId);
							if (byConn.size == 0)
							{	this.pending.delete(dsn);
							}
							break;
						}
						buf = buf.subarray(n);
						byConn.set(connectionId, buf);
					}
				}
			}
		}
		this.ongoing = undefined;
	}

	protected nextConnBanner(_dsn: Dsn, _connectionId: number): Uint8Array|string|undefined
	{	return;
	}

	async shutdown()
	{	this.isShutDown = true;
		if (this.ongoing)
		{	await this.ongoing;
		}
	}

	connect(_dsn: Dsn, _connectionId: number)
	{
	}

	resetConnection(_dsn: Dsn, _connectionId: number)
	{
	}

	disconnect(_dsn: Dsn, _connectionId: number)
	{
	}

	queryNew(_dsn: Dsn, _connectionId: number, _isPrepare: boolean, _previousResultNotRead: boolean)
	{
	}

	querySql(_dsn: Dsn, _connectionId: number, _data: Uint8Array)
	{
	}

	queryStart(_dsn: Dsn, _connectionId: number)
	{
	}

	queryEnd(_dsn: Dsn, _connectionId: number, _result: Resultsets<unknown>|Error, _stmtId?: number)
	{
	}

	execNew(_dsn: Dsn, _connectionId: number, _stmtId: number)
	{
	}

	execParam(_dsn: Dsn, _connectionId: number, _nParam: number, _data: Uint8Array|number|bigint|Date)
	{
	}

	execStart(_dsn: Dsn, _connectionId: number)
	{
	}

	execEnd(_dsn: Dsn, _connectionId: number, _result: Resultsets<unknown>|Error|undefined)
	{
	}

	deallocatePrepare(_dsn: Dsn, _connectionId: number, _stmtId: number)
	{
	}
}
