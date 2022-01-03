import {Dsn} from './dsn.ts';
import {SqlError} from "./errors.ts";
import {MyConn, OnBeforeCommit, GetConnFunc, ReturnConnFunc, doSavepoint} from './my_conn.ts';
import {MyPool, XaInfoTable} from "./my_pool.ts";
import {Logger} from "./my_protocol.ts";
import {XaIdGen} from "./xa_id_gen.ts";

const xaIdGen = new XaIdGen;

export class MySession
{	protected connsArr: MyConn[] = [];
	private savepointEnum = 0;
	private trxOptions: {readonly: boolean, xaId1: string} | undefined;
	private curXaInfoTable: XaInfoTable | undefined;

	constructor
	(	private pool: MyPool,
		private dsn: Dsn|undefined,
		private maxConns: number,
		private xaInfoTables: XaInfoTable[] = [],
		private logger: Logger,
		private getConnFunc: GetConnFunc,
		private returnConnFunc: ReturnConnFunc,
		private onBeforeCommit?: OnBeforeCommit,
	)
	{
	}

	get conns(): readonly MyConn[]
	{	return this.connsArr;
	}

	conn(dsn?: Dsn|string, fresh=false)
	{	if (dsn == undefined)
		{	dsn = this.dsn;
			if (dsn == undefined)
			{	throw new Error(`DSN not provided, and also default DSN was not specified`);
			}
		}
		if (!fresh)
		{	const dsnStr = typeof(dsn)=='string' ? dsn : dsn.name;
			for (const conn of this.connsArr)
			{	if (conn.dsnStr == dsnStr)
				{	return conn;
				}
			}
		}
		const conn = new MyConn(typeof(dsn)=='string' ? new Dsn(dsn) : dsn, this.maxConns, this.trxOptions, this.getConnFunc, this.returnConnFunc, undefined);
		this.connsArr[this.connsArr.length] = conn;
		return conn;
	}

	async startTrx(options?: {readonly?: boolean, xa?: boolean})
	{	// 1. Fail if there are XA started
		for (const conn of this.connsArr)
		{	if (conn.inXa)
			{	throw new SqlError(`There's already an active Distributed Transaction on ${conn.dsnStr}`);
			}
		}
		// 2. Commit current transactions
		await this.commit();
		// 3. options
		const readonly = !!options?.readonly;
		const xa = !!options?.xa;
		// 4. trxOptions
		let xaId1 = '';
		let curXaInfoTable: XaInfoTable | undefined;
		if (xa)
		{	const {xaInfoTables} = this;
			const {length} = xaInfoTables;
			const i = length<=1 ? 0 : Math.floor(Math.random() * length) % length;
			curXaInfoTable = xaInfoTables[i];
			xaId1 = xaIdGen.next(curXaInfoTable?.hash);
		}
		const trxOptions = {readonly, xaId1};
		this.trxOptions = trxOptions;
		this.curXaInfoTable = curXaInfoTable;
		// 5. Start transaction
		const promises = [];
		for (const conn of this.connsArr)
		{	promises[promises.length] = conn.startTrx(trxOptions);
		}
		await this.doAll(promises, true);
	}

	savepoint()
	{	const pointId = ++this.savepointEnum;
		const promises = [];
		for (const conn of this.connsArr)
		{	promises[promises.length] = conn[doSavepoint](pointId, `SAVEPOINT s${pointId}`);
		}
		return this.doAll(promises);
	}

	rollback(toPointId?: number)
	{	this.trxOptions = undefined;
		this.curXaInfoTable = undefined;
		const promises = [];
		for (const conn of this.connsArr)
		{	promises[promises.length] = conn.rollback(toPointId);
		}
		return this.doAll(promises);
	}

	commit()
	{	if (this.trxOptions && this.curXaInfoTable)
		{	return this.pool.forConn
			(	infoTableConn => this.doCommit(infoTableConn),
				this.curXaInfoTable.dsn
			);
		}
		else
		{	return this.doCommit();
		}
	}

	private async doCommit(infoTableConn?: MyConn)
	{	const {trxOptions, curXaInfoTable} = this;
		this.trxOptions = undefined;
		this.curXaInfoTable = undefined;
		// 1. Connect to curXaInfoTable DSN (if throws exception, don't continue)
		if (infoTableConn)
		{	await infoTableConn.connect();
			if (!infoTableConn.autocommit)
			{	await infoTableConn.execute("SET autocommit=1");
			}
		}
		// 2. Call onBeforeCommit
		if (this.onBeforeCommit)
		{	await this.onBeforeCommit(this.conns);
		}
		// 3. Prepare commit
		const promises = [];
		for (const conn of this.connsArr)
		{	if (conn.inXa)
			{	promises[promises.length] = conn.prepareCommit();
			}
		}
		await this.doAll(promises, true);
		// 4. Log to XA info table
		let recordAdded = false;
		if (trxOptions && curXaInfoTable && infoTableConn)
		{	try
			{	await infoTableConn.execute(`INSERT INTO \`${curXaInfoTable.table}\` (\`xa_id\`) VALUES ('${trxOptions.xaId1}')`);
				recordAdded = true;
			}
			catch (e)
			{	this.logger.warn(`Couldn't add record to info table ${curXaInfoTable.table} on ${infoTableConn.dsnStr}`, e);
			}
		}
		// 5. Commit
		promises.length = 0;
		for (const conn of this.connsArr)
		{	promises[promises.length] = conn.commit();
		}
		await this.doAll(promises);
		// 6. Remove record from XA info table
		if (recordAdded && trxOptions && curXaInfoTable && infoTableConn)
		{	try
			{	await infoTableConn.execute(`DELETE FROM \`${curXaInfoTable.table}\` WHERE \`xa_id\` = '${trxOptions.xaId1}'`);
			}
			catch (e)
			{	this.logger.error(e);
			}
		}
	}

	private async doAll(promises: Promise<unknown>[], rollbackOnError=false)
	{	const result = await Promise.allSettled(promises);
		let error;
		for (const r of result)
		{	if (r.status == 'rejected')
			{	if (!error)
				{	error = r.reason;
				}
				else
				{	this.logger.error(r.reason);
				}
			}
		}
		if (error)
		{	if (rollbackOnError)
			{	try
				{	await this.rollback();
				}
				catch (e2)
				{	this.logger.debug(e2);
				}
			}
			throw error;
		}
	}
}

export class MySessionInternal extends MySession
{	endSession()
	{	for (const conn of this.connsArr)
		{	conn.end();
		}
	}
}
