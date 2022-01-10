import {debugAssert} from "./debug_assert.ts";
import {reallocAppend} from "./realloc_append.ts";
import {Dsn} from "./dsn.ts";
import {SqlLogger} from "./sql_logger.ts";
import {Resultsets} from "./resultsets.ts";
import {writeAll} from "./deps.ts";

const MAX_BUFFER_SIZE = 1*1024*1024;

const encoder = new TextEncoder;

export class SqlLogToWriterBase implements SqlLogger
{	private pending = new Map<Dsn, Map<number, Uint8Array>>();
	private ongoing: Promise<void> | undefined;
	private prevDsn: Dsn | undefined;
	private prevConnectionId = -1;
	private continueAfterFlush: (() => void) | undefined;
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
		{	return Promise.resolve();
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
		// await?
		if (this.getMemory() < MAX_BUFFER_SIZE)
		{	return Promise.resolve();
		}
		return new Promise<void>(y => {this.continueAfterFlush = y});
	}

	private async doTask()
	{	while (true)
		{	const {continueAfterFlush} = this;
			if (continueAfterFlush && this.getMemory()<MAX_BUFFER_SIZE)
			{	this.continueAfterFlush = undefined;
				continueAfterFlush();
			}
			// byConn
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

	private getMemory()
	{	let memory = 0;
		for (const b of this.pending.values())
		{	for (const c of b.values())
			{	memory += c.buffer.byteLength;
			}
		}
		return memory;
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
	{	return Promise.resolve();
	}

	resetConnection(_dsn: Dsn, _connectionId: number)
	{	return Promise.resolve();
	}

	disconnect(_dsn: Dsn, _connectionId: number)
	{	return Promise.resolve();
	}

	queryNew(_dsn: Dsn, _connectionId: number, _isPrepare: boolean, _previousResultNotRead: boolean)
	{	return Promise.resolve();
	}

	querySql(_dsn: Dsn, _connectionId: number, _data: Uint8Array)
	{	return Promise.resolve();
	}

	queryStart(_dsn: Dsn, _connectionId: number)
	{	return Promise.resolve();
	}

	queryEnd(_dsn: Dsn, _connectionId: number, _result: Resultsets<unknown>|Error, _stmtId?: number)
	{	return Promise.resolve();
	}

	execNew(_dsn: Dsn, _connectionId: number, _stmtId: number)
	{	return Promise.resolve();
	}

	execParam(_dsn: Dsn, _connectionId: number, _nParam: number, _data: Uint8Array|number|bigint|Date)
	{	return Promise.resolve();
	}

	execStart(_dsn: Dsn, _connectionId: number)
	{	return Promise.resolve();
	}

	execEnd(_dsn: Dsn, _connectionId: number, _result: Resultsets<unknown>|Error|undefined)
	{	return Promise.resolve();
	}

	deallocatePrepare(_dsn: Dsn, _connectionId: number, _stmtId: number)
	{	return Promise.resolve();
	}
}
