import {Dsn} from './dsn.ts';
import {SqlError} from "./errors.ts";
import {MyConn, OnBeforeCommit, GetConnFunc, ReturnConnFunc, doSavepoint} from './my_conn.ts';
import {MyPool, XaInfoTable} from "./my_pool.ts";
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
		private getConnFunc: GetConnFunc,
		private returnConnFunc: ReturnConnFunc,
		private onBeforeCommit?: OnBeforeCommit,
	)
	{
	}

	get conns(): Iterable<MyConn> // Iterable<MyConn>, not MyConn[], to ensure that the array will not be modified from outside
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
		// 3. trxOptions
		const readonly = !!options?.readonly;
		let xaId1 = '';
		let curXaInfoTable: XaInfoTable | undefined;
		if (options?.xa)
		{	const {xaInfoTables} = this;
			const {length} = xaInfoTables;
			const i = length<=1 ? 0 : Math.floor(Math.random() * length) % length;
			curXaInfoTable = xaInfoTables[i];
			xaId1 = xaIdGen.next(curXaInfoTable?.hash);
		}
		const trxOptions = {readonly, xaId1};
		this.trxOptions = trxOptions;
		this.curXaInfoTable = curXaInfoTable;
		// 4. Start transaction
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

	async commit()
	{	const {trxOptions, curXaInfoTable} = this;
		this.trxOptions = undefined;
		this.curXaInfoTable = undefined;
		if (trxOptions && curXaInfoTable)
		{	await this.pool.forConn
			(	async conn =>
				{	// 1. Connect to curXaInfoTable DSN (if throws exception, don't continue)
					await conn.connect();
					if (!conn.autocommit)
					{	await conn.execute("SET autocommit=1");
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
					try
					{	await conn.execute(`INSERT INTO \`${curXaInfoTable.table}\` (\`xa_id\`) VALUES ('${trxOptions.xaId1}')`);
						recordAdded = true;
					}
					catch (e)
					{	console.error(`Couldn't add record to info table ${curXaInfoTable.table} on ${conn.dsnStr}`, e);
					}
					// 5. Commit
					promises.length = 0;
					for (const conn of this.connsArr)
					{	promises[promises.length] = conn.commit();
					}
					await this.doAll(promises);
					// 6. Remove record from XA info table
					if (recordAdded)
					{	try
						{	await conn.execute(`DELETE FROM \`${curXaInfoTable.table}\` WHERE \`xa_id\` = '${trxOptions.xaId1}'`);
						}
						catch (e)
						{	console.error(e);
						}
					}
				},
				curXaInfoTable.dsn
			);
		}
		else
		{	// 1. Call onBeforeCommit
			if (this.onBeforeCommit)
			{	await this.onBeforeCommit(this.conns);
			}
			// 2. Prepare commit
			const promises = [];
			for (const conn of this.connsArr)
			{	if (conn.inXa)
				{	promises[promises.length] = conn.prepareCommit();
				}
			}
			await this.doAll(promises, true);
			// 3. Commit
			promises.length = 0;
			for (const conn of this.connsArr)
			{	promises[promises.length] = conn.commit();
			}
			await this.doAll(promises);
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
				{	console.error(r.reason);
				}
			}
		}
		if (error)
		{	if (rollbackOnError)
			{	try
				{	await this.rollback();
				}
				catch (e2)
				{	console.error(e2);
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
