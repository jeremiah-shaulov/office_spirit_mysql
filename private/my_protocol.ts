import {debugAssert} from './debug_assert.ts';
import {reallocAppend} from './realloc_append.ts';
import {CapabilityFlags, PacketType, StatusFlags, SessionTrack, Command, Charset, CursorType, MysqlType, ColumnFlags} from './constants.ts';
import {BusyError, CanceledError, CanRetry, ServerDisconnectedError, SqlError} from './errors.ts';
import {Dsn} from './dsn.ts';
import {AuthPlugin} from './auth_plugins.ts';
import {MyProtocolReaderWriter, SqlSource} from './my_protocol_reader_writer.ts';
import {Column, ResultsetsInternal} from './resultsets.ts';
import type {Param, ColumnValue} from './resultsets.ts';
import {convColumnValue} from './conv_column_value.ts';
import {SafeSqlLogger} from "./sql_logger.ts";

const DEFAULT_MAX_COLUMN_LEN = 10*1024*1024;
const DEFAULT_RETRY_QUERY_TIMES = 0;
const DEFAULT_CHARACTER_SET_CLIENT = Charset.UTF8_UNICODE_CI;
const DEFAULT_TEXT_DECODER = new TextDecoder('utf-8');

const BUFFER_FOR_END_SESSION = new Uint8Array(4096);

export type OnLoadFile = (filename: string) => Promise<(Deno.Reader & Deno.Closer) | undefined>;

// deno-lint-ignore no-explicit-any
type Any = any;

export interface Logger
{	debug(...args: Any[]): unknown;
	info(...args: Any[]): unknown;
	log(...args: Any[]): unknown;
	warn(...args: Any[]): unknown;
	error(...args: Any[]): unknown;
}

export const enum ReadPacketMode
{	REGULAR,
	PREPARED_STMT,
	PREPARED_STMT_OK_CONTINUATION,
}

export const enum RowType
{	OBJECT,
	LAST_COLUMN_READER,
	MAP,
	ARRAY,
	FIRST_COLUMN,
	VOID,
}

const enum ProtocolState
{	IDLE,
	IDLE_IN_POOL,
	QUERYING,
	HAS_MORE_ROWS,
	HAS_MORE_RESULTSETS,
	ERROR,
	TERMINATED,
}

export class MyProtocol extends MyProtocolReaderWriter
{	serverVersion = '';
	connectionId = 0;
	capabilityFlags = 0;
	statusFlags = 0;
	schema = '';

	// for connections pool:
	useTill = Number.MAX_SAFE_INTEGER; // if keepAliveTimeout specified
	useNTimes = Number.MAX_SAFE_INTEGER; // if keepAliveMax specified

	logger: Logger = console;

	private warnings = 0;
	private affectedRows: number|bigint = 0;
	private lastInsertId: number|bigint = 0;
	private statusInfo = '';

	private state = ProtocolState.IDLE;
	private initSchema = '';
	private initSql = '';
	private maxColumnLen = DEFAULT_MAX_COLUMN_LEN;
	private retryQueryTimes = DEFAULT_RETRY_QUERY_TIMES;
	private onLoadFile?: OnLoadFile;
	private sqlLogger: SafeSqlLogger | undefined;

	private curResultsets: ResultsetsInternal<unknown> | undefined;
	private pendingCloseStmts: number[] = [];
	private curLastColumnReader: Deno.Reader | undefined;
	private onEndSession: ((state: ProtocolState) => void) | undefined;

	protected constructor(conn: Deno.Conn, decoder: TextDecoder, useBuffer: Uint8Array|undefined, readonly dsn: Dsn)
	{	super(conn, decoder, useBuffer);
	}

	static async inst(dsn: Dsn, useBuffer?: Uint8Array, onLoadFile?: OnLoadFile, sqlLogger?: SafeSqlLogger, logger?: Logger): Promise<MyProtocol>
	{	const {addr, initSql, maxColumnLen, username, password, schema, foundRows, ignoreSpace, multiStatements, retryQueryTimes} = dsn;
		if (username.length > 256) // must fit packet
		{	throw new SqlError('Username is too long');
		}
		if (password.length > 256) // must fit packet
		{	throw new SqlError('Password is too long');
		}
		if (schema.length > 256) // must fit packet
		{	throw new SqlError('Schema name is too long');
		}
		const conn = await Deno.connect(addr as Any); // "as any" in order to avoid requireing --unstable
		const protocol = new MyProtocol(conn, DEFAULT_TEXT_DECODER, useBuffer, dsn);
		protocol.initSchema = schema;
		protocol.initSql = initSql;
		if (maxColumnLen > 0)
		{	protocol.maxColumnLen = maxColumnLen;
		}
		if (retryQueryTimes >= 0)
		{	protocol.retryQueryTimes = retryQueryTimes;
		}
		protocol.onLoadFile = onLoadFile;
		if (logger)
		{	protocol.logger = logger;
		}
		try
		{	const authPlugin = await protocol.readHandshake();
			if (sqlLogger)
			{	// connectionId is set after `readHandshake()`
				protocol.sqlLogger = sqlLogger;
				await sqlLogger.connect(protocol.connectionId);
			}
			await protocol.writeHandshakeResponse(username, password, schema, authPlugin, foundRows, ignoreSpace, multiStatements);
			const authPlugin2 = await protocol.readAuthResponse(password, authPlugin);
			if (authPlugin2)
			{	await protocol.writeAuthSwitchResponse(password, authPlugin2);
				await protocol.readAuthResponse(password, authPlugin2);
			}
			if (initSql)
			{	await protocol.sendComQuery(initSql);
			}
			return protocol;
		}
		catch (e)
		{	try
			{	conn.close();
			}
			catch (e2)
			{	protocol.logger.debug(e2);
			}
			throw e;
		}
	}

	/**	When connecting to a MySQL server, the server immediately sends handshake packet.
	 **/
	private async readHandshake()
	{	// header
		this.readPacketHeader() || await this.readPacketHeaderAsync();
		// payload
		const protocolVersion = this.readUint8() ?? await this.readUint8Async();
		if (protocolVersion == 255)
		{	// ERR
			const errorCode = this.readUint16() ?? await this.readUint16Async();
			const errorMessage = this.readShortEofString() ?? await this.readShortEofStringAsync();
			debugAssert(this.isAtEndOfPacket());
			throw new ServerDisconnectedError(errorMessage, errorCode);
		}
		if (protocolVersion < 9)
		{	throw new Error(`Protocol version ${protocolVersion} is not supported`);
		}
		const serverVersion = this.readShortNulString() ?? await this.readShortNulStringAsync();
		const connectionId = this.readUint32() ?? await this.readUint32Async();
		let authPluginData = new Uint8Array(24).subarray(0, 0);
		let capabilityFlags = 0;
		let statusFlags = 0;
		let authPluginName = '';
		if (protocolVersion == 9)
		{	authPluginData = reallocAppend(authPluginData, this.readShortNulBytes() ?? await this.readShortNulBytesAsync());
		}
		else
		{	authPluginData = reallocAppend(authPluginData, this.readShortBytes(8) ?? await this.readShortBytesAsync(8));
			this.readVoid(1) || await this.readVoidAsync(1);
			capabilityFlags = this.readUint16() ?? await this.readUint16Async();
			if (!this.isAtEndOfPacket())
			{	this.readUint8() ?? await this.readUint8Async(); // lower 8 bits of the server-default charset (skip)
				statusFlags = this.readUint16() ?? await this.readUint16Async();
				capabilityFlags |= (this.readUint16() ?? await this.readUint16Async()) << 16;
				let authPluginDataLen = 0;
				if (capabilityFlags & CapabilityFlags.CLIENT_PLUGIN_AUTH)
				{	authPluginDataLen = this.readUint8() ?? await this.readUint8Async();
					this.readVoid(10) || await this.readVoidAsync(10);
				}
				else
				{	this.readVoid(11) || await this.readVoidAsync(11);
				}
				if (capabilityFlags & CapabilityFlags.CLIENT_SECURE_CONNECTION)
				{	// read 2nd part of auth_plugin_data
					authPluginDataLen = Math.max(13, authPluginDataLen-8);
					let authPluginData2 = this.readShortBytes(authPluginDataLen) ?? await this.readShortBytesAsync(authPluginDataLen);
					if (authPluginData2[authPluginData2.length - 1] == 0)
					{	authPluginData2 = authPluginData2.subarray(0, -1);
					}
					authPluginData = reallocAppend(authPluginData, authPluginData2);
				}
				if (capabilityFlags & CapabilityFlags.CLIENT_PLUGIN_AUTH)
				{	authPluginName = this.readShortNulString() ?? await this.readShortNulStringAsync();
				}
			}
		}
		// done
		this.gotoEndOfPacket() || await this.gotoEndOfPacketAsync();
		this.serverVersion = serverVersion;
		this.connectionId = connectionId;
		this.capabilityFlags = capabilityFlags;
		this.statusFlags = statusFlags;
		return AuthPlugin.inst(authPluginName, authPluginData);
	}

	/**	Write client's response to initial server handshake packet.
	 **/
	private async writeHandshakeResponse(username: string, password: string, schema: string, authPlugin: AuthPlugin, foundRows: boolean, ignoreSpace: boolean, multiStatements: boolean)
	{	// apply client capabilities
		this.capabilityFlags &=
		(	CapabilityFlags.CLIENT_PLUGIN_AUTH |
			CapabilityFlags.CLIENT_LONG_PASSWORD |
			CapabilityFlags.CLIENT_TRANSACTIONS |
			CapabilityFlags.CLIENT_MULTI_RESULTS |
			CapabilityFlags.CLIENT_PS_MULTI_RESULTS |
			CapabilityFlags.CLIENT_SECURE_CONNECTION |
			CapabilityFlags.CLIENT_PROTOCOL_41 |
			CapabilityFlags.CLIENT_LONG_FLAG |
			CapabilityFlags.CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA |
			CapabilityFlags.CLIENT_DEPRECATE_EOF |
			CapabilityFlags.CLIENT_SESSION_TRACK |
			CapabilityFlags.CLIENT_LOCAL_FILES |
			(schema ? CapabilityFlags.CLIENT_CONNECT_WITH_DB : 0) |
			(foundRows ? CapabilityFlags.CLIENT_FOUND_ROWS : 0) |
			(ignoreSpace ? CapabilityFlags.CLIENT_IGNORE_SPACE : 0) |
			(multiStatements ? CapabilityFlags.CLIENT_MULTI_STATEMENTS : 0)
		);
		if (this.capabilityFlags & CapabilityFlags.CLIENT_SESSION_TRACK)
		{	this.schema = schema;
		}
		// send packet
		this.startWritingNewPacket();
		if (this.capabilityFlags & CapabilityFlags.CLIENT_PROTOCOL_41)
		{	this.writeUint32(this.capabilityFlags);
			this.writeUint32(0xFFFFFF); // max packet size
			this.writeUint8(DEFAULT_CHARACTER_SET_CLIENT);
			this.writeZero(23);
			this.writeNulString(username);
			// auth
			if (!password)
			{	this.writeUint8(0);
			}
			else
			{	const auth = await authPlugin.quickAuth(password);
				if (this.capabilityFlags & CapabilityFlags.CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA)
				{	this.writeLenencInt(auth.length);
					this.writeBytes(auth);
				}
				else if (this.capabilityFlags & CapabilityFlags.CLIENT_SECURE_CONNECTION)
				{	this.writeUint8(auth.length);
					this.writeBytes(auth);
				}
				else
				{	this.writeNulBytes(auth);
				}
			}
			// schema
			if (this.capabilityFlags & CapabilityFlags.CLIENT_CONNECT_WITH_DB)
			{	this.writeNulString(schema);
			}
			// auth_plugin_name
			if (this.capabilityFlags & CapabilityFlags.CLIENT_PLUGIN_AUTH)
			{	this.writeNulString(authPlugin.name);
			}
		}
		else
		{	this.writeUint16(this.capabilityFlags);
			this.writeUint32(0xFFFFFF); // max packet size
			this.writeNulString(username);
			const auth = !password ? new Uint8Array : await authPlugin.quickAuth(password);
			if (this.capabilityFlags & CapabilityFlags.CLIENT_CONNECT_WITH_DB)
			{	this.writeNulBytes(auth);
				this.writeNulString(schema);
			}
			else
			{	this.writeBytes(auth);
			}
		}
		return await this.send();
	}

	/**	If guessed auth method that was used during handshake was correct, just OK packet will be read on successful auth, and ERR if auth failed.
		But server can ask to switch auth method (EOF) or request plugin auth.
		This function returns different authPlugin if auth switch required.
	 **/
	private async readAuthResponse(password: string, authPlugin: AuthPlugin)
	{	this.readPacketHeader() || await this.readPacketHeaderAsync();
		let type = this.readUint8() ?? await this.readUint8Async();
		switch (type)
		{	case PacketType.EOF: // AuthSwitchRequest
			{	const authPluginName = this.readShortNulString() ?? await this.readShortNulStringAsync();
				const authPluginData = (this.readShortEofBytes() ?? await this.readShortEofBytesAsync()).slice();
				debugAssert(this.isAtEndOfPacket());
				return AuthPlugin.inst(authPluginName, authPluginData);
			}
			case PacketType.OK:
			{	this.gotoEndOfPacket() || await this.gotoEndOfPacketAsync();
				return;
			}
			case PacketType.ERR:
			{	const errorCode = this.readUint16() ?? await this.readUint16Async();
				let sqlState = '';
				if (this.capabilityFlags & CapabilityFlags.CLIENT_PROTOCOL_41)
				{	sqlState = this.readShortString(6) ?? await this.readShortStringAsync(6);
				}
				const errorMessage = this.readShortEofString() ?? await this.readShortEofStringAsync();
				throw new SqlError(errorMessage, errorCode, sqlState);
			}
			default: // Use plugin for authentication
			{	let data = this.readShortEofBytes() ?? await this.readShortEofBytesAsync();
				while (!await authPlugin.progress(password, type, data, this))
				{	type = await this.readPacket();
					if (type != PacketType.OK)
					{	data = this.readShortEofBytes() ?? await this.readShortEofBytesAsync();
					}
				}
			}
		}
	}

	/**	Respond to second auth attempt, after got AuthSwitchRequest.
	 **/
	private async writeAuthSwitchResponse(password: string, authPlugin: AuthPlugin)
	{	this.startWritingNewPacket();
		if (password)
		{	const auth = await authPlugin.quickAuth(password);
			this.writeBytes(auth);
		}
		return await this.send();
	}

	/**	Reads packet header, and packet type (first byte of the packet).
		If the packet type was OK or EOF, and ReadPacketMode.REGULAR, reads it to the end, and returns OK.
		If it was ERR, reads it to the end, and throws SqlError.
		Else, returns the packet type, and leaves the caller responsible to read the packet to the end.
		In case of ReadPacketMode.PREPARED_STMT, an OK or an EOF packet must be read by the caller (because it has different format after COM_STMT_PREPARE).
	 **/
	private async readPacket(mode=ReadPacketMode.REGULAR)
	{	let type = 0;
		if (mode != ReadPacketMode.PREPARED_STMT_OK_CONTINUATION)
		{	debugAssert(this.isAtEndOfPacket());
			this.readPacketHeader() || await this.readPacketHeaderAsync();
			type = this.readUint8() ?? await this.readUint8Async();
		}
		switch (type)
		{	// deno-lint-ignore no-fallthrough
			case PacketType.EOF:
			{	if (this.payloadLength >= 9) // not a EOF packet. EOF packets are <9 bytes long, and if it's >=9, it's a lenenc int
				{	return type;
				}
				if (!(this.capabilityFlags & CapabilityFlags.CLIENT_DEPRECATE_EOF))
				{	if (this.capabilityFlags & CapabilityFlags.CLIENT_PROTOCOL_41)
					{	this.warnings = this.readUint16() ?? await this.readUint16Async();
						this.statusFlags = this.readUint16() ?? await this.readUint16Async();
					}
					this.gotoEndOfPacket() || await this.gotoEndOfPacketAsync();
					return mode==ReadPacketMode.REGULAR ? PacketType.OK : type;
				}
				// else fallthrough to OK
			}
			case PacketType.OK:
			{	if (mode!=ReadPacketMode.PREPARED_STMT || type==PacketType.EOF)
				{	this.affectedRows = this.readLenencInt() ?? await this.readLenencIntAsync();
					this.lastInsertId = this.readLenencInt() ?? await this.readLenencIntAsync();
					if (this.capabilityFlags & CapabilityFlags.CLIENT_PROTOCOL_41)
					{	this.statusFlags = this.readUint16() ?? await this.readUint16Async();
						this.warnings = this.readUint16() ?? await this.readUint16Async();
					}
					else if (this.capabilityFlags & CapabilityFlags.CLIENT_TRANSACTIONS)
					{	this.statusFlags = this.readUint16() ?? await this.readUint16Async();
					}
					if (!this.isAtEndOfPacket())
					{	if (this.capabilityFlags & CapabilityFlags.CLIENT_SESSION_TRACK)
						{	this.statusInfo = this.readShortLenencString() ?? await this.readShortLenencStringAsync();
							if (this.statusFlags & StatusFlags.SERVER_SESSION_STATE_CHANGED)
							{	const sessionStateChangesLen = Number(this.readLenencInt() ?? await this.readLenencIntAsync());
								const to = this.packetOffset + sessionStateChangesLen;
								while (this.packetOffset < to)
								{	const changeType = this.readUint8() ?? await this.readUint8Async();
									switch (changeType)
									{	case SessionTrack.SYSTEM_VARIABLES:
										{	this.readLenencInt() ?? await this.readLenencIntAsync(); // skip
											const name = this.readShortLenencString() ?? await this.readShortLenencStringAsync();
											const value = this.readShortLenencString() ?? await this.readShortLenencStringAsync();
											if (name == 'character_set_client')
											{	this.setCharacterSetClient(value);
											}
											else if (name == 'character_set_results')
											{	this.setCharacterSetResults(value);
											}
											break;
										}
										case SessionTrack.SCHEMA:
											this.readLenencInt() ?? await this.readLenencIntAsync(); // skip
											this.schema = this.readShortLenencString() ?? await this.readShortLenencStringAsync();
											break;
										default:
											this.readShortLenencBytes() ?? await this.readShortLenencBytesAsync(); // skip
									}
								}
							}
							this.gotoEndOfPacket() || await this.gotoEndOfPacketAsync();
						}
						else
						{	this.statusInfo = this.readShortEofString() ?? await this.readShortEofStringAsync();
						}
					}
				}
				return mode==ReadPacketMode.REGULAR ? PacketType.OK : type;
			}
			case PacketType.ERR:
			{	const errorCode = this.readUint16() ?? await this.readUint16Async();
				let sqlState = '';
				if (this.capabilityFlags & CapabilityFlags.CLIENT_PROTOCOL_41)
				{	sqlState = this.readShortString(6) ?? await this.readShortStringAsync(6);
				}
				const errorMessage = this.readShortEofString() ?? await this.readShortEofStringAsync();
				debugAssert(this.isAtEndOfPacket());
				throw new SqlError(errorMessage, errorCode, sqlState);
			}
			default:
			{	return type;
			}
		}
	}

	private setCharacterSetClient(value: string)
	{	if (value.slice(0, 4) != 'utf8')
		{	throw new Error(`Cannot use this value for character_set_client: ${value}. Can only use utf8.`);
		}
	}

	private setCharacterSetResults(value: string)
	{	if (value.slice(0, 4) == 'utf8')
		{	this.decoder = new TextDecoder('utf-8');
		}
		else
		{	switch (value)
			{	case 'latin1':
				case 'latin2':
				case 'latin3':
				case 'latin4':
				case 'cp866':
				case 'cp1250':
				case 'cp1251':
				case 'cp1256':
				case 'cp1257':
				case 'big5':
				case 'gb2312':
				case 'gb18030':
				case 'greek':
				case 'hebrew':
				case 'sjis':
					this.decoder = new TextDecoder(value);
					break;
				case 'koi8r':
					this.decoder = new TextDecoder('koi8-r');
					break;
				case 'koi8u':
					this.decoder = new TextDecoder('koi8-u');
					break;
				case 'eucjpms':
					this.decoder = new TextDecoder('euc-jp');
					break;
				default:
					throw new Error(`Cannot use this value for character_set_results: ${value}. Options: utf8, utf8mb4, latin1, latin2, latin3, latin4, cp866, cp1250, cp1251, cp1256, cp1257, big5, gb2312, gb18030, greek, hebrew, sjis, koi8r, koi8u, eucjpms.`);
			}
		}
	}

	authSendUint8Packet(value: number)
	{	debugAssert(this.state == ProtocolState.IDLE); // this function is used during connecting phase, when the MyProtocol object is not returned from MyProtocol.inst().
		this.startWritingNewPacket();
		this.writeUint8(value);
		return this.send();
	}

	authSendBytesPacket(value: Uint8Array)
	{	debugAssert(this.state == ProtocolState.IDLE); // this function is used during connecting phase, when the MyProtocol object is not returned from MyProtocol.inst().
		this.startWritingNewPacket();
		this.writeBytes(value);
		return this.send();
	}

	private initResultsets(resultsets: ResultsetsInternal<unknown>)
	{	resultsets.lastInsertId = this.lastInsertId;
		resultsets.warnings = this.warnings;
		resultsets.statusInfo = this.statusInfo;
		resultsets.noGoodIndexUsed = (this.statusFlags & StatusFlags.SERVER_STATUS_NO_GOOD_INDEX_USED) != 0;
		resultsets.noIndexUsed = (this.statusFlags & StatusFlags.SERVER_STATUS_NO_INDEX_USED) != 0;
		resultsets.isSlowQuery = (this.statusFlags & StatusFlags.SERVER_QUERY_WAS_SLOW) != 0;
		if (this.capabilityFlags & CapabilityFlags.CLIENT_FOUND_ROWS)
		{	resultsets.foundRows = this.affectedRows;
		}
		else
		{	resultsets.affectedRows = this.affectedRows;
		}
	}

	private async readQueryResponse(resultsets: ResultsetsInternal<unknown>, mode: ReadPacketMode, skipColumns=false)
	{	debugAssert(mode==ReadPacketMode.REGULAR || mode==ReadPacketMode.PREPARED_STMT);
		debugAssert(resultsets.stmtId < 0);
L:		while (true)
		{	const type = await this.readPacket(mode);
			let nColumns: number|bigint = 0;
			let nPlaceholders = 0;
			switch (type)
			{	case PacketType.OK:
				{	if (mode == ReadPacketMode.REGULAR)
					{	this.initResultsets(resultsets);
						nColumns = 0;
					}
					else
					{	resultsets.isPreparedStmt = true;
						resultsets.stmtId = this.readUint32() ?? await this.readUint32Async();
						nColumns = this.readUint16() ?? await this.readUint16Async();
						nPlaceholders = this.readUint16() ?? await this.readUint16Async();
						this.readUint8() ?? await this.readUint8Async(); // skip reserved1
						this.warnings = this.readUint16() ?? await this.readUint16Async();
						this.gotoEndOfPacket() || await this.gotoEndOfPacketAsync();
					}
					break;
				}
				case PacketType.NULL_OR_LOCAL_INFILE:
				{	const filename = this.readShortEofString() ?? await this.readShortEofStringAsync();
					debugAssert(this.isAtEndOfPacket());
					if (!this.onLoadFile)
					{	throw new Error(`LOCAL INFILE handler is not set. Requested file: ${filename}`);
					}
					const reader = await this.onLoadFile(filename);
					if (!reader)
					{	throw new Error(`File is not accepted for LOCAL INFILE: ${filename}`);
					}
					try
					{	while (true)
						{	this.startWritingNewPacket();
							const n = await this.writeReadChunk(reader);
							await this.send();
							if (n == null)
							{	break;
							}
						}
					}
					finally
					{	try
						{	reader.close();
						}
						catch (e)
						{	this.logger.error(e);
						}
					}
					continue L;
				}
				case PacketType.UINT16:
				{	nColumns = this.readUint16() ?? await this.readUint16Async();
					break;
				}
				case PacketType.UINT24:
				{	nColumns = this.readUint24() ?? await this.readUint24Async();
					break;
				}
				case PacketType.UINT64:
				{	nColumns = this.readUint64() ?? await this.readUint64Async();
					break;
				}
				default:
				{	nColumns = type;
				}
			}
			if (nColumns > Number.MAX_SAFE_INTEGER) // want cast bigint -> number
			{	throw new Error(`Can't handle so many columns: ${nColumns}`);
			}
			const nColumnsNum = Number(nColumns);

			// Read sequence of ColumnDefinition packets
			if (nPlaceholders > 0)
			{	await this.skipColumnDefinitionPackets(nPlaceholders);
			}
			resultsets.nPlaceholders = nPlaceholders;
			if (nColumnsNum == 0)
			{	resultsets.columns = [];
			}
			else if (skipColumns)
			{	resultsets.columns = [];
				await this.skipColumnDefinitionPackets(nColumnsNum);
			}
			else
			{	resultsets.columns = await this.readColumnDefinitionPackets(nColumnsNum);
			}

			return nColumnsNum!=0 ? ProtocolState.HAS_MORE_ROWS : this.statusFlags&StatusFlags.SERVER_MORE_RESULTS_EXISTS ? ProtocolState.HAS_MORE_RESULTSETS : ProtocolState.IDLE;
		}
	}

	private async skipColumnDefinitionPackets(nPackets: number)
	{	debugAssert(nPackets > 0);
		for (let i=0; i<nPackets; i++)
		{	// Read ColumnDefinition41 packet
			this.readPacketHeader() || await this.readPacketHeaderAsync();
			this.gotoEndOfPacket() || await this.gotoEndOfPacketAsync();
		}
		if (!(this.capabilityFlags & CapabilityFlags.CLIENT_DEPRECATE_EOF))
		{	// Read EOF after columns list
			const type = await this.readPacket();
			debugAssert(type == PacketType.OK);
		}
	}

	private async readColumnDefinitionPackets(nPackets: number)
	{	const columns: Column[] = [];
		if (nPackets > 0)
		{	if (this.capabilityFlags & CapabilityFlags.CLIENT_PROTOCOL_41)
			{	for (let i=0; i<nPackets; i++)
				{	// Read ColumnDefinition41 packet
					this.readPacketHeader() || await this.readPacketHeaderAsync();
					const catalog = this.readShortLenencString() ?? await this.readShortLenencStringAsync();
					const schema = this.readShortLenencString() ?? await this.readShortLenencStringAsync();
					const table = this.readShortLenencString() ?? await this.readShortLenencStringAsync();
					const orgTable = this.readShortLenencString() ?? await this.readShortLenencStringAsync();
					const name = this.readShortLenencString() ?? await this.readShortLenencStringAsync();
					const orgName = this.readShortLenencString() ?? await this.readShortLenencStringAsync();
					const blockLen = Number(this.readLenencInt() ?? await this.readLenencIntAsync());
					debugAssert(blockLen >= 12);
					const block = this.readShortBytes(blockLen) ?? await this.readShortBytesAsync(blockLen);
					const v = new DataView(block.buffer, block.byteOffset);
					const charset = v.getUint16(0, true);
					const columnLen = v.getUint32(2, true);
					const columnType = v.getUint8(6);
					const flags = v.getUint16(7, true);
					const decimals = v.getUint8(9);
					this.gotoEndOfPacket() || await this.gotoEndOfPacketAsync();
					columns[i] = new Column(catalog, schema, table, orgTable, name, orgName, charset, columnLen, columnType, flags, decimals);
				}
			}
			else
			{	for (let i=0; i<nPackets; i++)
				{	// Read ColumnDefinition320 packet
					this.readPacketHeader() || await this.readPacketHeaderAsync();
					const table = this.readShortLenencString() ?? await this.readShortLenencStringAsync();
					const name = this.readShortLenencString() ?? await this.readShortLenencStringAsync();
					let blockLen = Number(this.readLenencInt() ?? await this.readLenencIntAsync());
					let block = this.readShortBytes(blockLen) ?? await this.readShortBytesAsync(blockLen);
					let v = new DataView(block.buffer, block.byteOffset);
					const columnLen = v.getUint16(0, true) | (v.getUint8(2) << 16);
					blockLen = Number(this.readLenencInt() ?? await this.readLenencIntAsync());
					block = this.readShortBytes(blockLen) ?? await this.readShortBytesAsync(blockLen);
					v = new DataView(block.buffer, block.byteOffset);
					const columnType = v.getUint8(0);
					blockLen = Number(this.readLenencInt() ?? await this.readLenencIntAsync());
					block = this.readShortBytes(blockLen) ?? await this.readShortBytesAsync(blockLen);
					v = new DataView(block.buffer, block.byteOffset);
					let flags;
					let decimals;
					if (this.capabilityFlags & CapabilityFlags.CLIENT_LONG_FLAG)
					{	flags = v.getUint16(0, true);
						decimals = v.getUint8(2);
					}
					else
					{	flags = v.getUint8(0);
						decimals = v.getUint8(1);
					}
					this.gotoEndOfPacket() || await this.gotoEndOfPacketAsync();
					columns[i] = new Column('', '', table, '', name, '', Charset.UNKNOWN, columnLen, columnType, flags, decimals);
				}
			}
			if (!(this.capabilityFlags & CapabilityFlags.CLIENT_DEPRECATE_EOF))
			{	// Read EOF after columns list
				const type = await this.readPacket();
				debugAssert(type == PacketType.OK);
			}
		}
		return columns;
	}

	private setQueryingState()
	{	switch (this.state)
		{	case ProtocolState.QUERYING:
				throw new BusyError('Previous operation is still in progress');
			case ProtocolState.HAS_MORE_ROWS:
				throw new BusyError('Rows from previous query are not read to the end');
			case ProtocolState.HAS_MORE_RESULTSETS:
				throw new BusyError('Previous query has unread resultsets');
			case ProtocolState.TERMINATED:
				throw new CanceledError('Connection terminated');
			case ProtocolState.ERROR:
				throw new Error('Protocol error');
			case ProtocolState.IDLE_IN_POOL:
				this.state = ProtocolState.QUERYING;
				return true;
			default:
				debugAssert(this.state == ProtocolState.IDLE);
				this.state = ProtocolState.QUERYING;
				return false;
		}
	}

	private rethrowError(error: Error): never
	{	let state = ProtocolState.IDLE;
		if (!(error instanceof SqlError))
		{	try
			{	this.conn.close();
			}
			catch (e)
			{	this.logger.error(e);
			}
			state = ProtocolState.ERROR;
		}
		this.setState(state);
		throw error;
	}

	private rethrowErrorIfFatal(error: Error, isFromPool=false)
	{	let state = ProtocolState.IDLE;
		if (!(error instanceof SqlError))
		{	try
			{	this.conn.close();
			}
			catch (e)
			{	this.logger.error(e);
			}
			if (isFromPool)
			{	return;
			}
			state = ProtocolState.ERROR;
		}
		this.setState(state);
		throw error;
	}

	private setState(state: ProtocolState)
	{	if (this.onEndSession)
		{	this.onEndSession(state);
		}
		else
		{	this.state = state;
		}
	}

	/**	Call this before entering ProtocolState.IDLE.
	 **/
	private async doPending()
	{	const {pendingCloseStmts} = this;
		debugAssert(pendingCloseStmts.length != 0);
		this.state = ProtocolState.QUERYING;
		for (let i=0; i<pendingCloseStmts.length; i++)
		{	await this.sendComStmtClose(pendingCloseStmts[i]);
		}
		pendingCloseStmts.length = 0;
	}

	setSqlLogger(sqlLogger?: SafeSqlLogger)
	{	this.sqlLogger = sqlLogger;
	}

	/**	I assume that i'm in ProtocolState.IDLE.
	 **/
	private async sendComResetConnectionAndInitDb(schema: string)
	{	this.startWritingNewPacket(true);
		this.writeUint8(Command.COM_RESET_CONNECTION);
		if (schema)
		{	this.startWritingNewPacket(true, true);
			this.writeUint8(Command.COM_INIT_DB);
			this.writeString(schema);
		}
		await this.send();
		try
		{	await this.readPacket();
		}
		catch (e)
		{	if ((e instanceof SqlError) && e.message=='Unknown command')
			{	this.logger.warn(`Couldn't reset connection state. This is only supported on MySQL 5.7+ and MariaDB 10.2+`, e);
			}
			throw e;
		}
		if (schema)
		{	await this.readPacket();
		}
	}

	/**	I assume that i'm in ProtocolState.IDLE.
	 **/
	private async sendComStmtClose(stmtId: number)
	{	if (this.sqlLogger)
		{	await this.sqlLogger.deallocatePrepare(this.connectionId, stmtId);
		}
		this.startWritingNewPacket(true);
		this.writeUint8(Command.COM_STMT_CLOSE);
		this.writeUint32(stmtId);
		return await this.send();
	}

	/**	On success returns ResultsetsProtocol<Row>.
		On error throws exception.
		If `letReturnUndefined` and communication error occured on connection that was just taken form pool, returns undefined.
	 **/
	async sendComQuery<Row>(sql: SqlSource, rowType=RowType.VOID, letReturnUndefined=false)
	{	const isFromPool = this.setQueryingState();
		const noBackslashEscapes = (this.statusFlags & StatusFlags.SERVER_STATUS_NO_BACKSLASH_ESCAPES) != 0;
		const {sqlLogger} = this;
		let curDataLen = 0;
		const querySql = !sqlLogger ? undefined : (d: Uint8Array) => sqlLogger.querySql(this.connectionId, d, noBackslashEscapes, (curDataLen += d.length));
		let nRetry = this.retryQueryTimes;
		while (true)
		{	try
			{	if (sqlLogger)
				{	await sqlLogger.queryNew(this.connectionId, false, 0, 1);
				}
				this.startWritingNewPacket(true);
				this.writeUint8(Command.COM_QUERY);
				await this.sendWithData(sql, noBackslashEscapes, querySql);
				if (sqlLogger)
				{	await sqlLogger.queryStart(this.connectionId, 0, 1);
				}
				const resultsets = new ResultsetsInternal<Row>(rowType);
				let state = await this.readQueryResponse(resultsets, ReadPacketMode.REGULAR);
				if (state != ProtocolState.IDLE)
				{	resultsets.protocol = this;
					resultsets.hasMoreInternal = true;
					this.curResultsets = resultsets;
					if (rowType == RowType.VOID)
					{	// discard resultsets
						state = await this.doDiscard(state);
					}
				}
				else if (this.pendingCloseStmts.length != 0)
				{	await this.doPending();
				}
				this.setState(state);
				if (sqlLogger)
				{	await sqlLogger.queryEnd(this.connectionId, resultsets, -1, 0, 1);
				}
				return resultsets;
			}
			catch (e)
			{	if (sqlLogger)
				{	await sqlLogger.queryEnd(this.connectionId, e, -1, 0, 1);
				}
				if (nRetry>0 && (e instanceof SqlError) && e.canRetry==CanRetry.QUERY)
				{	this.logger.warn(`Query failed and will be retried more ${nRetry} times: ${e.message}`);
					nRetry--;
					continue;
				}
				this.rethrowErrorIfFatal(e, isFromPool && letReturnUndefined);
			}
			break;
		}
	}

	/**	Send 2 or 3 queries in 1 round-trip.
		First sends preStmt (if preStmtId >= 0) defined by `preStmtId` and `preStmtParams`.
		Then sends `prequery`.
		`preStmt` and `prequery` must not return resultsets.
		Number of placeholders in prepared query must be exactly `preStmtParams.length`.
		And finally it sends `sql`.
		Then it reads the results of the sent queries.
		If one of the queries returned error, exception will be thrown (excepting the case when `ignorePrequeryError` was true, and `prequery` thrown error).
	 **/
	async sendThreeQueries<Row>(preStmtId: number, preStmtParams: Any[]|undefined, prequery: Uint8Array|string|undefined, ignorePrequeryError: boolean, sql: SqlSource, rowType=RowType.VOID, letReturnUndefined=false)
	{	const isFromPool = this.setQueryingState();
		const noBackslashEscapes = (this.statusFlags & StatusFlags.SERVER_STATUS_NO_BACKSLASH_ESCAPES) != 0;
		const {sqlLogger} = this;
		let curDataLen = 0;
		const querySql = !sqlLogger ? undefined : (d: Uint8Array) => sqlLogger.querySql(this.connectionId, d, noBackslashEscapes, (curDataLen += d.length));
		let nRetry = this.retryQueryTimes;
		const nQueriesInBatch = (preStmtId>=0 ? 1 : 0) + (prequery ? 2 : 1);
		let nQueryInBatch = 0;
		while (true)
		{	try
			{	// Send preStmt
				if (preStmtId >= 0)
				{	debugAssert(preStmtParams);
					if (sqlLogger)
					{	await sqlLogger.execNew(this.connectionId, preStmtId, nQueryInBatch, nQueriesInBatch);
					}
					await this.sendComStmtExecute(preStmtId, preStmtParams.length, preStmtParams);
					if (sqlLogger)
					{	await sqlLogger.execStart(this.connectionId, nQueryInBatch++, nQueriesInBatch);
					}
				}
				// Send prequery
				if (prequery)
				{	if (sqlLogger)
					{	await sqlLogger.queryNew(this.connectionId, false, nQueryInBatch, nQueriesInBatch);
					}
					this.startWritingNewPacket(true);
					this.writeUint8(Command.COM_QUERY);
					await this.sendWithData(prequery, false, querySql, true);
					if (sqlLogger)
					{	await sqlLogger.queryStart(this.connectionId, nQueryInBatch++, nQueriesInBatch);
					}
				}
				// Send sql
				if (sqlLogger)
				{	await sqlLogger.queryNew(this.connectionId, false, nQueryInBatch, nQueriesInBatch);
				}
				this.startWritingNewPacket(true, true);
				this.writeUint8(Command.COM_QUERY);
				await this.sendWithData(sql, noBackslashEscapes, querySql);
				if (sqlLogger)
				{	await sqlLogger.queryStart(this.connectionId, nQueryInBatch++, nQueriesInBatch);
				}
				// Read result of preStmt
				nQueryInBatch = 0;
				if (preStmtId >= 0)
				{	const rowNColumns = await this.readPacket(ReadPacketMode.PREPARED_STMT);
					debugAssert(rowNColumns == 0); // preStmt must not return rows/columns
					debugAssert(!(this.statusFlags & StatusFlags.SERVER_MORE_RESULTS_EXISTS)); // preStmt must not return rows/columns
					if (!this.isAtEndOfPacket())
					{	await this.readPacket(ReadPacketMode.PREPARED_STMT_OK_CONTINUATION);
					}
					if (sqlLogger)
					{	await sqlLogger.execEnd(this.connectionId, undefined, nQueryInBatch++, nQueriesInBatch);
					}
				}
				// Read result of prequery
				const resultsets = new ResultsetsInternal<Row>(rowType);
				let state = ProtocolState.IDLE;
				let error;
				if (prequery)
				{	try
					{	state = await this.readQueryResponse(resultsets, ReadPacketMode.REGULAR);
						if (sqlLogger)
						{	await sqlLogger.queryEnd(this.connectionId, resultsets, -1, nQueryInBatch++, nQueriesInBatch);
						}
					}
					catch (e)
					{	if (sqlLogger)
						{	await sqlLogger.queryEnd(this.connectionId, e, -1, nQueryInBatch++, nQueriesInBatch);
						}
						if (ignorePrequeryError && (e instanceof SqlError))
						{	this.logger.error(e);
						}
						else
						{	error = e;
						}
					}
				}
				debugAssert(state == ProtocolState.IDLE);
				// Read result of sql
				try
				{	state = await this.readQueryResponse(resultsets, ReadPacketMode.REGULAR);
					if (sqlLogger)
					{	await sqlLogger.queryEnd(this.connectionId, resultsets, -1, nQueryInBatch++, nQueriesInBatch);
					}
				}
				catch (e)
				{	if (sqlLogger)
					{	await sqlLogger.queryEnd(this.connectionId, e, -1, nQueryInBatch++, nQueriesInBatch);
					}
					if (error)
					{	this.logger.error(error);
					}
					error = e;
				}
				if (error)
				{	throw error;
				}
				if (state != ProtocolState.IDLE)
				{	resultsets.protocol = this;
					resultsets.hasMoreInternal = true;
					this.curResultsets = resultsets;
					if (rowType == RowType.VOID)
					{	// discard resultsets
						state = await this.doDiscard(state);
					}
				}
				else if (this.pendingCloseStmts.length != 0)
				{	await this.doPending();
				}
				this.setState(state);
				return resultsets;
			}
			catch (e)
			{	if (nRetry>0 && (e instanceof SqlError) && e.canRetry==CanRetry.QUERY)
				{	this.logger.warn(`Query failed and will be retried more ${nRetry} times: ${e.message}`);
					nRetry--;
					preStmtId = -1;
					prequery = undefined;
					continue;
				}
				this.rethrowErrorIfFatal(e, isFromPool && letReturnUndefined);
			}
			break;
		}
	}

	/**	On success returns ResultsetsProtocol<Row>.
		On error throws exception.
		If `letReturnUndefined` and communication error occured on connection that was just taken form pool, returns undefined.
	 **/
	async sendComStmtPrepare<Row>(sql: SqlSource, putParamsTo: Any[]|undefined, rowType: RowType, letReturnUndefined=false, skipColumns=false)
	{	const isFromPool = this.setQueryingState();
		const noBackslashEscapes = (this.statusFlags & StatusFlags.SERVER_STATUS_NO_BACKSLASH_ESCAPES) != 0;
		const {sqlLogger} = this;
		let curDataLen = 0;
		const querySql = !sqlLogger ? undefined : (d: Uint8Array) => sqlLogger.querySql(this.connectionId, d, noBackslashEscapes, (curDataLen += d.length));
		try
		{	if (sqlLogger)
			{	await sqlLogger.queryNew(this.connectionId, true, 0, 1);
			}
			this.startWritingNewPacket(true);
			this.writeUint8(Command.COM_STMT_PREPARE);
			await this.sendWithData(sql, noBackslashEscapes, querySql, false, putParamsTo);
			if (sqlLogger)
			{	await sqlLogger.queryStart(this.connectionId, 0, 1);
			}
			const resultsets = new ResultsetsInternal<Row>(rowType);
			await this.readQueryResponse(resultsets, ReadPacketMode.PREPARED_STMT, skipColumns);
			resultsets.protocol = this;
			if (this.pendingCloseStmts.length != 0)
			{	await this.doPending();
			}
			this.setState(ProtocolState.IDLE);
			if (sqlLogger)
			{	await sqlLogger.queryEnd(this.connectionId, resultsets, resultsets.stmtId, 0, 1);
			}
			return resultsets;
		}
		catch (e)
		{	if (sqlLogger)
			{	await sqlLogger.queryEnd(this.connectionId, e, -1, 0, 1);
			}
			this.rethrowErrorIfFatal(e, isFromPool && letReturnUndefined);
		}
	}

	/**	This function can be called at any time. If the connection is busy, the operation will be performed later.
	 **/
	async disposePreparedStmt(stmtId: number)
	{	const {state} = this;
		if (state==ProtocolState.IDLE || state==ProtocolState.IDLE_IN_POOL)
		{	this.state = ProtocolState.QUERYING;
			try
			{	await this.sendComStmtClose(stmtId);
				this.setState(ProtocolState.IDLE);
			}
			catch (error)
			{	try
				{	this.rethrowError(error);
				}
				catch (e)
				{	this.logger.error(e);
				}
			}
		}
		else if (state!=ProtocolState.ERROR && state!=ProtocolState.TERMINATED)
		{	this.pendingCloseStmts.push(stmtId);
		}
	}

	private async sendComStmtExecute(stmtId: number, nPlaceholders: number, params: Param[])
	{	const maxExpectedPacketSizeIncludingHeader = 15 + nPlaceholders*16; // packet header (4-byte) + COM_STMT_EXECUTE (1-byte) + stmt_id (4-byte) + NO_CURSOR (1-byte) + iteration_count (4-byte) + new_params_bound_flag (1-byte) = 15; each placeholder can be Date (max 12 bytes) + param type (2-byte) + null mask (1-bit) <= 15
		let extraSpaceForParams = Math.max(0, this.buffer.length - maxExpectedPacketSizeIncludingHeader);
		const placeholdersSent = new Set<number>();
		const {sqlLogger} = this;
		let nParam = 0;
		let curDataLen = 0;
		const execParam = !sqlLogger ? undefined : (d: Uint8Array|number|bigint|Date) => sqlLogger.execParam(this.connectionId, nParam, d, d instanceof Uint8Array ? (curDataLen += d.length) : -1);
		// First send COM_STMT_SEND_LONG_DATA params, as they must be sent before COM_STMT_EXECUTE
		for (nParam=0; nParam<nPlaceholders; nParam++)
		{	const param = params[nParam];
			if (param!=null && typeof(param)!='function' && typeof(param)!='symbol') // if is not NULL
			{	if (typeof(param) == 'string')
				{	const maxByteLen = 9 + param.length * 4; // lenenc string length (9 max bytes) + string byte length
					if (maxByteLen > extraSpaceForParams)
					{	this.startWritingNewPacket(true, true);
						this.writeUint8(Command.COM_STMT_SEND_LONG_DATA);
						this.writeUint32(stmtId);
						this.writeUint16(nParam);
						if (!sqlLogger)
						{	await this.sendWithData(param, false, undefined, true);
						}
						else
						{	curDataLen = 0;
							await this.sendWithData(param, false, execParam, true);
							await sqlLogger.execParamEnd(this.connectionId, nParam, curDataLen);
						}
						placeholdersSent.add(nParam);
					}
					else
					{	extraSpaceForParams -= maxByteLen;
					}
				}
				else if (typeof(param) == 'object')
				{	if (param instanceof Uint8Array)
					{	if (param.byteLength > extraSpaceForParams)
						{	this.startWritingNewPacket(true, true);
							this.writeUint8(Command.COM_STMT_SEND_LONG_DATA);
							this.writeUint32(stmtId);
							this.writeUint16(nParam);
							if (sqlLogger && execParam)
							{	curDataLen = 0;
								await execParam(param);
								await sqlLogger.execParamEnd(this.connectionId, nParam, curDataLen);
							}
							await this.sendWithData(param, false, undefined, true);
							placeholdersSent.add(nParam);
						}
						else
						{	extraSpaceForParams -= param.byteLength;
						}
					}
					else if (param.buffer instanceof ArrayBuffer)
					{	if (param.byteLength > extraSpaceForParams)
						{	this.startWritingNewPacket(true, true);
							this.writeUint8(Command.COM_STMT_SEND_LONG_DATA);
							this.writeUint32(stmtId);
							this.writeUint16(nParam);
							const data = new Uint8Array(param.buffer, param.byteOffset, param.byteLength);
							if (sqlLogger && execParam)
							{	curDataLen = 0;
								await execParam(data);
								await sqlLogger.execParamEnd(this.connectionId, nParam, curDataLen);
							}
							await this.sendWithData(data, false, undefined, true);
							placeholdersSent.add(nParam);
						}
						else
						{	extraSpaceForParams -= param.byteLength;
						}
					}
					else if (typeof(param.read) == 'function')
					{	let isNotEmpty = false;
						curDataLen = 0;
						while (true)
						{	this.startWritingNewPacket(!isNotEmpty, true);
							this.writeUint8(Command.COM_STMT_SEND_LONG_DATA);
							this.writeUint32(stmtId);
							this.writeUint16(nParam);
							const from = this.bufferEnd;
							const n = await this.writeReadChunk(param);
							if (n == null)
							{	this.discardPacket();
								break;
							}
							if (sqlLogger && execParam)
							{	await execParam(this.buffer.subarray(from, this.bufferEnd));
								await sqlLogger.execParamEnd(this.connectionId, nParam, curDataLen);
							}
							await this.send();
							isNotEmpty = true;
						}
						if (isNotEmpty)
						{	placeholdersSent.add(nParam);
						}
					}
					else if (!(param instanceof Date))
					{	this.startWritingNewPacket(true, true);
						this.writeUint8(Command.COM_STMT_SEND_LONG_DATA);
						this.writeUint32(stmtId);
						this.writeUint16(nParam);
						if (!sqlLogger)
						{	await this.sendWithData(JSON.stringify(param), false, undefined, true);
						}
						else
						{	curDataLen = 0;
							await this.sendWithData(JSON.stringify(param), false, execParam, true);
							await sqlLogger.execParamEnd(this.connectionId, nParam, curDataLen);
						}
						placeholdersSent.add(nParam);
					}
				}
			}
		}
		// Flush, if not enuogh space in buffer for the placeholders packet
		if (this.bufferEnd > this.bufferStart && this.bufferEnd + maxExpectedPacketSizeIncludingHeader > this.buffer.length)
		{	await this.send();
		}
		// Send params in binary protocol
		this.startWritingNewPacket(true, true);
		this.writeUint8(Command.COM_STMT_EXECUTE);
		this.writeUint32(stmtId);
		this.writeUint8(CursorType.NO_CURSOR);
		this.writeUint32(1); // iteration_count
		if (nPlaceholders > 0)
		{	// Send null-bitmap for each param
			this.ensureRoom((nPlaceholders >> 3) + 2 + (nPlaceholders << 1)); // 1 bit per each placeholder (nPlaceholders/8 bytes) + partial byte (1 byte) + new_params_bound_flag (1 byte) + 2-byte type per each placeholder (nPlaceholders*2 bytes)
			let nullBits = 0;
			let nullBitMask = 1;
			for (let i=0; i<nPlaceholders; i++)
			{	const param = params[i];
				if (param==null || typeof(param)=='function' || typeof(param)=='symbol') // if is NULL
				{	nullBits |= nullBitMask;
				}
				if (nullBitMask != 0x80)
				{	nullBitMask <<= 1;
				}
				else
				{	this.writeUint8(nullBits);
					nullBits = 0;
					nullBitMask = 1;
				}
			}
			if (nullBitMask != 1)
			{	// partial byte
				this.writeUint8(nullBits);
			}
			this.writeUint8(1); // new_params_bound_flag
			// Send type of each param
			let paramsLen = 0;
			for (let i=0; i<nPlaceholders; i++)
			{	const param = params[i];
				let type = MysqlType.MYSQL_TYPE_STRING;
				if (param!=null && typeof(param)!='function' && typeof(param)!='symbol') // if is not NULL
				{	if (typeof(param) == 'boolean')
					{	type = MysqlType.MYSQL_TYPE_TINY;
						paramsLen++;
					}
					else if (typeof(param) == 'number')
					{	if (Number.isInteger(param) && param>=-0x8000_0000 && param<=0x7FFF_FFFF)
						{	type = MysqlType.MYSQL_TYPE_LONG;
							paramsLen += 4;
						}
						else
						{	type = MysqlType.MYSQL_TYPE_DOUBLE;
							paramsLen += 8;
						}
					}
					else if (typeof(param) == 'bigint')
					{	type = MysqlType.MYSQL_TYPE_LONGLONG;
						paramsLen += 8;
					}
					else if (typeof(param) == 'string')
					{	// no need to add to `paramsLen`, because strings must be sent separately, and if they don't, this means that the string is fitting `extraSpaceForParams` (see above), so no need to ensure length
					}
					else if (param instanceof Date)
					{	type = MysqlType.MYSQL_TYPE_DATETIME;
						paramsLen += 12;
					}
					else if (param.buffer instanceof ArrayBuffer)
					{	type = MysqlType.MYSQL_TYPE_LONG_BLOB;
						// no need to add to `paramsLen`, because ArrayBuffer must be sent separately, and if they don't, this means that the string is fitting `extraSpaceForParams` (see above), so no need to ensure length
					}
					else if (typeof(param.read) == 'function')
					{	type = MysqlType.MYSQL_TYPE_LONG_BLOB;
						paramsLen++;
					}
				}
				this.writeUint16(type);
			}
			// Send value of each param
			this.ensureRoom(paramsLen);
			for (nParam=0; nParam<nPlaceholders; nParam++)
			{	const param = params[nParam];
				if (param!=null && typeof(param)!='function' && typeof(param)!='symbol' && !placeholdersSent.has(nParam)) // if is not NULL and not sent
				{	if (typeof(param) == 'boolean')
					{	const data = param ? 1 : 0;
						if (sqlLogger && execParam)
						{	await execParam(data);
							await sqlLogger.execParamEnd(this.connectionId, nParam, -1);
						}
						this.writeUint8(data);
					}
					else if (typeof(param) == 'number')
					{	if (sqlLogger && execParam)
						{	await execParam(param);
							await sqlLogger.execParamEnd(this.connectionId, nParam, -1);
						}
						if (Number.isInteger(param) && param>=-0x8000_0000 && param<=0x7FFF_FFFF)
						{	this.writeUint32(param);
						}
						else
						{	this.writeDouble(param);
						}
					}
					else if (typeof(param) == 'bigint')
					{	if (sqlLogger && execParam)
						{	await execParam(param);
							await sqlLogger.execParamEnd(this.connectionId, nParam, -1);
						}
						this.writeUint64(param);
					}
					else if (typeof(param) == 'string')
					{	let from = this.bufferEnd;
						this.writeLenencString(param);
						if (sqlLogger && execParam)
						{	from += this.buffer[from]==0xFC ? 3 : 1;
							curDataLen = 0;
							await execParam(this.buffer.subarray(from, this.bufferEnd));
							await sqlLogger.execParamEnd(this.connectionId, nParam, curDataLen);
						}
					}
					else if (param instanceof Date)
					{	if (sqlLogger && execParam)
						{	await execParam(param);
							await sqlLogger.execParamEnd(this.connectionId, nParam, -1);
						}
						const frac = param.getMilliseconds();
						this.writeUint8(frac ? 11 : 7); // length
						this.writeUint16(param.getFullYear());
						this.writeUint8(param.getMonth() + 1);
						this.writeUint8(param.getDate());
						this.writeUint8(param.getHours());
						this.writeUint8(param.getMinutes());
						this.writeUint8(param.getSeconds());
						if (frac)
						{	this.writeUint32(frac * 1000);
						}
					}
					else if (param instanceof Uint8Array)
					{	if (sqlLogger && execParam)
						{	curDataLen = 0;
							await execParam(param);
							await sqlLogger.execParamEnd(this.connectionId, nParam, curDataLen);
						}
						this.writeLenencBytes(param);
					}
					else if (param.buffer instanceof ArrayBuffer)
					{	const data = new Uint8Array(param.buffer, param.byteOffset, param.byteLength);
						if (sqlLogger && execParam)
						{	curDataLen = 0;
							await execParam(data);
							await sqlLogger.execParamEnd(this.connectionId, nParam, curDataLen);
						}
						this.writeLenencBytes(data);
					}
					else
					{	debugAssert(typeof(param.read) == 'function');
						// nothing written for this param (as it's not in placeholdersSent), so write empty string
						if (sqlLogger && execParam)
						{	curDataLen = 0;
							await execParam(new Uint8Array);
							await sqlLogger.execParamEnd(this.connectionId, nParam, curDataLen);
						}
						this.writeUint8(0); // 0-length lenenc-string
					}
				}
			}
		}
		await this.send();
	}

	async execStmt(resultsets: ResultsetsInternal<unknown>, params: Param[])
	{	const {isPreparedStmt, stmtId, nPlaceholders} = resultsets;
		const {sqlLogger} = this;
		if (stmtId < 0)
		{	throw new SqlError(isPreparedStmt ? 'This prepared statement disposed' : 'Not a prepared statement');
		}
		this.setQueryingState();
		try
		{	debugAssert(!resultsets.hasMoreInternal); // because setQueryingState() ensures that current resultset is read to the end
			if (sqlLogger)
			{	await sqlLogger.execNew(this.connectionId, stmtId, 0, 1);
			}
			await this.sendComStmtExecute(stmtId, nPlaceholders, params);
			// Read Binary Protocol Resultset
			const type = await this.readPacket(ReadPacketMode.PREPARED_STMT); // throw if ERR packet
			if (sqlLogger)
			{	await sqlLogger.execStart(this.connectionId, 0, 1);
			}
			let rowNColumns = type;
			if (type >= 0xFB)
			{	this.unput(type);
				const value = this.readLenencInt() ?? await this.readLenencIntAsync();
				if (value > Number.MAX_SAFE_INTEGER) // want cast bigint -> number
				{	throw new Error(`Can't handle so many columns: ${value}`);
				}
				rowNColumns = Number(value);
			}
			if (rowNColumns > 0)
			{	resultsets.columns = await this.readColumnDefinitionPackets(rowNColumns);
				resultsets.protocol = this;
				resultsets.hasMoreInternal = true;
				this.curResultsets = resultsets;
				this.setState(ProtocolState.HAS_MORE_ROWS);
			}
			else if (this.statusFlags & StatusFlags.SERVER_MORE_RESULTS_EXISTS)
			{	resultsets.protocol = this;
				resultsets.hasMoreInternal = true;
				if (!this.isAtEndOfPacket())
				{	await this.readPacket(ReadPacketMode.PREPARED_STMT_OK_CONTINUATION);
					this.initResultsets(resultsets);
				}
				this.curResultsets = resultsets;
				this.setState(ProtocolState.HAS_MORE_RESULTSETS);
			}
			else
			{	if (!this.isAtEndOfPacket())
				{	await this.readPacket(ReadPacketMode.PREPARED_STMT_OK_CONTINUATION);
					this.initResultsets(resultsets);
				}
				if (this.pendingCloseStmts.length != 0)
				{	await this.doPending();
				}
				this.setState(ProtocolState.IDLE);
			}
			if (sqlLogger)
			{	await sqlLogger.execEnd(this.connectionId, resultsets, 0, 1);
			}
		}
		catch (e)
		{	if (sqlLogger)
			{	await sqlLogger.execEnd(this.connectionId, e, 0, 1);
			}
			this.rethrowError(e);
		}
	}

	async fetch<Row>(rowType: RowType): Promise<Row | undefined>
	{	switch (this.state)
		{	case ProtocolState.IDLE:
			case ProtocolState.IDLE_IN_POOL:
			case ProtocolState.HAS_MORE_RESULTSETS:
				return undefined; // no more rows in this resultset
			case ProtocolState.QUERYING:
				throw new BusyError('Previous operation is still in progress');
			case ProtocolState.TERMINATED:
				throw new CanceledError('Connection terminated');
		}
		debugAssert(this.state == ProtocolState.HAS_MORE_ROWS);
		debugAssert(this.curResultsets?.hasMoreInternal); // because we're in ProtocolState.HAS_MORE_ROWS
		this.state = ProtocolState.QUERYING;
		try
		{	const {curResultsets} = this;
			const {isPreparedStmt, stmtId, columns} = curResultsets;
			const nColumns = columns.length;
			const type = await this.readPacket(isPreparedStmt ? ReadPacketMode.PREPARED_STMT : ReadPacketMode.REGULAR);
			if (type == (isPreparedStmt ? PacketType.EOF : PacketType.OK))
			{	if (this.statusFlags & StatusFlags.SERVER_MORE_RESULTS_EXISTS)
				{	this.setState(ProtocolState.HAS_MORE_RESULTSETS);
				}
				else
				{	if (stmtId < 0)
					{	curResultsets.protocol = undefined;
					}
					curResultsets.hasMoreInternal = false;
					this.curResultsets = undefined;
					if (this.pendingCloseStmts.length != 0)
					{	await this.doPending();
					}
					this.setState(ProtocolState.IDLE);
				}
				return undefined;
			}
			let buffer: Uint8Array|undefined;
			let row: Any;
			switch (rowType)
			{	case RowType.OBJECT:
				case RowType.LAST_COLUMN_READER:
					row = {};
					break;
				case RowType.MAP:
					row = new Map;
					break;
				case RowType.ARRAY:
					row = [];
					break;
				default:
					debugAssert(rowType==RowType.FIRST_COLUMN || rowType==RowType.VOID);
			}
			let lastColumnReaderLen = 0;
			if (!isPreparedStmt)
			{	// Text protocol row
				this.unput(type);
				for (let i=0; i<nColumns; i++)
				{	const {typeId, flags, name} = columns[i];
					let len = this.readLenencInt() ?? await this.readLenencIntAsync();
					if (len > Number.MAX_SAFE_INTEGER)
					{	throw new Error(`Field is too long: ${len} bytes`);
					}
					len = Number(len);
					let value: ColumnValue = null;
					if (len != -1) // if not a null value
					{	if (rowType==RowType.LAST_COLUMN_READER && i+1==nColumns)
						{	lastColumnReaderLen = len;
						}
						else if (len>this.maxColumnLen || rowType==RowType.VOID)
						{	this.readVoid(len) || this.readVoidAsync(len);
						}
						else if (len <= this.buffer.length)
						{	const v = this.readShortBytes(len) ?? await this.readShortBytesAsync(len);
							value = convColumnValue(v, typeId, flags, this.decoder);
						}
						else
						{	if (!buffer || buffer.length<len)
							{	buffer = new Uint8Array(len);
							}
							const v = buffer.subarray(0, len);
							await this.readBytesToBuffer(v);
							value = convColumnValue(v, typeId, flags, this.decoder);
						}
					}
					switch (rowType)
					{	case RowType.OBJECT:
						case RowType.LAST_COLUMN_READER:
							row[name] = value;
							break;
						case RowType.MAP:
							row.set(name, value);
							break;
						case RowType.ARRAY:
							row[i] = value;
							break;
						case RowType.FIRST_COLUMN:
							if (i == 0)
							{	row = value;
							}
							break;
						default:
							debugAssert(rowType == RowType.VOID);
					}
				}
			}
			else
			{	// Binary protocol row
				const nullBitsLen = (nColumns + 2 + 7) >> 3;
				const nullBits = (this.readShortBytes(nullBitsLen) ?? await this.readShortBytesAsync(nullBitsLen)).slice();
				let nullBitsI = 0;
				let nullBitMask = 4; // starts from bit offset 1 << 2, according to protocol definition
				for (let i=0; i<nColumns; i++)
				{	let value: ColumnValue = null;
					const isNull = nullBits[nullBitsI] & nullBitMask;
					if (nullBitMask != 0x80)
					{	nullBitMask <<= 1;
					}
					else
					{	nullBitsI++;
						nullBitMask = 1;
					}
					const {typeId, flags, name} = columns[i];
					if (!isNull)
					{	switch (typeId)
						{	case MysqlType.MYSQL_TYPE_TINY:
								if (flags & ColumnFlags.UNSIGNED)
								{	value = this.readUint8() ?? await this.readUint8Async();
								}
								else
								{	value = this.readInt8() ?? await this.readInt8Async();
								}
								break;
							case MysqlType.MYSQL_TYPE_SHORT:
							case MysqlType.MYSQL_TYPE_YEAR:
								if (flags & ColumnFlags.UNSIGNED)
								{	value = this.readUint16() ?? await this.readUint16Async();
								}
								else
								{	value = this.readInt16() ?? await this.readInt16Async();
								}
								break;
							case MysqlType.MYSQL_TYPE_INT24:
							case MysqlType.MYSQL_TYPE_LONG:
								if (flags & ColumnFlags.UNSIGNED)
								{	value = this.readUint32() ?? await this.readUint32Async();
								}
								else
								{	value = this.readInt32() ?? await this.readInt32Async();
								}
								break;
							case MysqlType.MYSQL_TYPE_LONGLONG:
								if (flags & ColumnFlags.UNSIGNED)
								{	value = this.readUint64() ?? await this.readUint64Async();
									if (value <= Number.MAX_SAFE_INTEGER)
									{	value = Number(value); // as happen in text protocol
									}
								}
								else
								{	value = this.readInt64() ?? await this.readInt64Async();
									if (value>=Number.MIN_SAFE_INTEGER && value<=Number.MAX_SAFE_INTEGER)
									{	value = Number(value); // as happen in text protocol
									}
								}
								break;
							case MysqlType.MYSQL_TYPE_FLOAT:
								value = this.readFloat() ?? await this.readFloatAsync();
								break;
							case MysqlType.MYSQL_TYPE_DOUBLE:
								value = this.readDouble() ?? await this.readDoubleAsync();
								break;
							case MysqlType.MYSQL_TYPE_DATE:
							case MysqlType.MYSQL_TYPE_DATETIME:
							case MysqlType.MYSQL_TYPE_TIMESTAMP:
							{	const len = this.readUint8() ?? await this.readUint8Async();
								if (len >= 4)
								{	const year = this.readUint16() ?? await this.readUint16Async();
									const month = this.readUint8() ?? await this.readUint8Async();
									const day = this.readUint8() ?? await this.readUint8Async();
									let hour=0, minute=0, second=0, micro=0;
									if (len >= 7)
									{	hour = this.readUint8() ?? await this.readUint8Async();
										minute = this.readUint8() ?? await this.readUint8Async();
										second = this.readUint8() ?? await this.readUint8Async();
										if (len >= 11)
										{	micro = this.readUint32() ?? await this.readUint32Async();
										}
									}
									value = new Date(year, month-1, day, hour, minute, second, micro/1000);
								}
								else
								{	value = new Date(0);
								}
								break;
							}
							case MysqlType.MYSQL_TYPE_TIME:
							{	const len = this.readUint8() ?? await this.readUint8Async();
								if (len >= 8)
								{	const isNegative = this.readUint8() ?? await this.readUint8Async();
									const days = this.readUint32() ?? await this.readUint32Async();
									let hours = this.readUint8() ?? await this.readUint8Async();
									let minutes = this.readUint8() ?? await this.readUint8Async();
									let seconds = this.readUint8() ?? await this.readUint8Async();
									hours += days * 24;
									minutes += hours * 60;
									seconds += minutes * 60;
									if (len >= 12)
									{	const micro = this.readUint32() ?? await this.readUint32Async();
										seconds += micro / 1_000_000;
									}
									value = isNegative ? -seconds : seconds;
								}
								else
								{	value = 0;
								}
								break;
							}
							case MysqlType.MYSQL_TYPE_BIT:
							{	// MySQL sends bit value as blob with length=1
								value = (this.readUint16() ?? await this.readUint16Async()) == 257;
								break;
							}
							default:
							{	let len = this.readLenencInt() ?? await this.readLenencIntAsync();
								if (len > Number.MAX_SAFE_INTEGER)
								{	throw new Error(`Field is too long: ${len} bytes`);
								}
								len = Number(len);
								if (rowType==RowType.LAST_COLUMN_READER && i+1==nColumns)
								{	lastColumnReaderLen = len;
								}
								else if (len>this.maxColumnLen || rowType==RowType.VOID)
								{	this.readVoid(len) || this.readVoidAsync(len);
								}
								else if ((flags & ColumnFlags.BINARY) && typeId != MysqlType.MYSQL_TYPE_JSON)
								{	value = new Uint8Array(len);
									await this.readBytesToBuffer(value);
								}
								else
								{	if (len <= this.buffer.length)
									{	value = this.readShortString(len) ?? await this.readShortStringAsync(len);
									}
									else
									{	if (!buffer || buffer.length<len)
										{	buffer = new Uint8Array(len);
										}
										const v = buffer.subarray(0, len);
										await this.readBytesToBuffer(v);
										value = this.decoder.decode(v);
									}
									if (typeId == MysqlType.MYSQL_TYPE_JSON)
									{	value = JSON.parse(value);
									}
								}
							}
						}
					}
					switch (rowType)
					{	case RowType.OBJECT:
						case RowType.LAST_COLUMN_READER:
							row[name] = value;
							break;
						case RowType.MAP:
							row.set(name, value);
							break;
						case RowType.ARRAY:
							row[i] = value;
							break;
						case RowType.FIRST_COLUMN:
							if (i == 0)
							{	row = value;
							}
							break;
						default:
							debugAssert(rowType == RowType.VOID);
					}
				}
			}
			if (rowType == RowType.LAST_COLUMN_READER)
			{	// deno-lint-ignore no-this-alias
				const that = this;
				let dataInCurPacketLen = Math.min(lastColumnReaderLen, this.payloadLength - this.packetOffset);
				const enum IsReading
				{	NO,
					YES,
					YES_BY_END_SESSION,
				}
				let isReading = IsReading.NO;
				const reader =
				{	async read(dest: Uint8Array)
					{	if (isReading != IsReading.NO)
						{	if (isReading==IsReading.YES && that.onEndSession)
							{	isReading = IsReading.YES_BY_END_SESSION;
								return null; // assume: endSession() called me (maybe in parallel with user's reader)
							}
							throw new BusyError('Data is being read by another reader');
						}
						isReading = that.onEndSession ? IsReading.YES_BY_END_SESSION : IsReading.YES;
						let n = 0;
						try
						{	while (true)
							{	if (lastColumnReaderLen <= 0)
								{	// read to the end of the last column
									debugAssert(lastColumnReaderLen==0 && dataInCurPacketLen==0);
									if (that.payloadLength == 0xFFFFFF) // packet of 0xFFFFFF length must be followed by one empty packet
									{	that.readPacketHeader() || await that.readPacketHeaderAsync();
										debugAssert((that.payloadLength as Any) == 0);
									}
									// discard next rows and resultsets
									await that.doDiscard(ProtocolState.HAS_MORE_ROWS);
									debugAssert(!that.curResultsets);
									// done
									that.curLastColumnReader = undefined;
									if (that.pendingCloseStmts.length != 0)
									{	await that.doPending();
									}
									that.setState(ProtocolState.IDLE);
									if (that.onEndSession)
									{	throw new CanceledError('Connection terminated');
									}
									return null;
								}
								if (dataInCurPacketLen <= 0)
								{	debugAssert(dataInCurPacketLen == 0);
									that.readPacketHeader() || await that.readPacketHeaderAsync();
									dataInCurPacketLen = Math.min(lastColumnReaderLen, that.payloadLength - that.packetOffset);
								}
								n = Math.min(dest.length, dataInCurPacketLen);
								await that.readBytesToBuffer(dest.subarray(0, n));
								dataInCurPacketLen -= n;
								lastColumnReaderLen -= n;
								if (!that.onEndSession)
								{	break;
								}
							}
						}
						catch (e)
						{	that.rethrowError(e);
						}
						finally
						{	isReading = IsReading.NO;
						}
						return n;
					}
				};
				const columnName = columns[columns.length - 1].name;
				row[columnName] = reader;
				this.curLastColumnReader = reader;
			}
			else
			{	this.setState(ProtocolState.HAS_MORE_ROWS);
			}
			return row;
		}
		catch (e)
		{	this.rethrowError(e);
		}
	}

	/**	If `onlyRows` is false returns `ProtocolState.IDLE`. Else can also return `ProtocolState.HAS_MORE_RESULTSETS`.
	 **/
	private async doDiscard(state: ProtocolState, onlyRows=false)
	{	const {curResultsets} = this;
		debugAssert(curResultsets);
		const {isPreparedStmt, stmtId} = curResultsets;
		const mode = isPreparedStmt ? ReadPacketMode.PREPARED_STMT : ReadPacketMode.REGULAR;
		const okType = isPreparedStmt ? PacketType.EOF : PacketType.OK;
		while (true)
		{	if (state == ProtocolState.HAS_MORE_ROWS)
			{	while (true)
				{	const type = await this.readPacket(mode);
					this.gotoEndOfPacket() || await this.gotoEndOfPacketAsync();
					if (type == okType)
					{	state = this.statusFlags & StatusFlags.SERVER_MORE_RESULTS_EXISTS ? ProtocolState.HAS_MORE_RESULTSETS : ProtocolState.IDLE;
						break;
					}
				}
			}
			if (!onlyRows && state==ProtocolState.HAS_MORE_RESULTSETS)
			{	state = await this.readQueryResponse(curResultsets, mode);
			}
			else
			{	break;
			}
		}
		debugAssert(state==ProtocolState.HAS_MORE_RESULTSETS || state==ProtocolState.IDLE);
		if (state == ProtocolState.IDLE)
		{	if (stmtId < 0)
			{	curResultsets.protocol = undefined;
			}
			curResultsets.hasMoreInternal = false;
			this.curResultsets = undefined;
		}
		return state;
	}

	async nextResultset(ignoreTerminated=false)
	{	let {state} = this;
		switch (state)
		{	case ProtocolState.IDLE:
			case ProtocolState.IDLE_IN_POOL:
				return false;
			case ProtocolState.QUERYING:
				throw new BusyError('Previous operation is still in progress');
			case ProtocolState.ERROR:
				throw new Error('Protocol error');
			case ProtocolState.TERMINATED:
				if (ignoreTerminated)
				{	return false;
				}
				throw new CanceledError('Connection terminated');
		}
		try
		{	if (state == ProtocolState.HAS_MORE_ROWS)
			{	this.state = ProtocolState.QUERYING;
				state = await this.doDiscard(state, true);
			}
			let yes = false;
			if (state == ProtocolState.HAS_MORE_RESULTSETS)
			{	yes = true;
				this.state = ProtocolState.QUERYING;
				const {curResultsets} = this;
				debugAssert(curResultsets?.hasMoreInternal);
				const {isPreparedStmt, stmtId} = curResultsets;
				curResultsets.resetFields();
				state = await this.readQueryResponse(curResultsets, isPreparedStmt ? ReadPacketMode.PREPARED_STMT : ReadPacketMode.REGULAR);
				if (state == ProtocolState.IDLE)
				{	if (stmtId < 0)
					{	curResultsets.protocol = undefined;
					}
					curResultsets.hasMoreInternal = false;
					this.curResultsets = undefined;
				}
			}
			this.setState(state);
			return yes;
		}
		catch (e)
		{	this.rethrowError(e);
		}
	}

	/**	Finalize session (skip unread resultsets, and execute COM_RESET_CONNECTION), then if the connection is alive, reinitialize it (set dsn.schema and execute dsn.initSql).
		If the connection was alive, and `recycleConnection` was true, returns new `MyProtocol` object with the same `Deno.Conn` to the database, and current object marks as terminated (method calls will throw `CanceledError`).
		If the connection was dead, returns Uint8Array buffer to be recycled.
		This function doesn't throw errors (errors can be considered fatal).
	 **/
	async end(rollbackPreparedXaId='', recycleConnection=false, withDisposeSqlLogger=false)
	{	let {state} = this;
		if (state != ProtocolState.TERMINATED)
		{	this.state = ProtocolState.TERMINATED;
			if (state == ProtocolState.QUERYING)
			{	const promise = new Promise<ProtocolState>(y => {this.onEndSession = y});
				try
				{	await this.curLastColumnReader?.read(BUFFER_FOR_END_SESSION);
				}
				catch (e)
				{	if (!(e instanceof CanceledError))
					{	this.logger.error(e);
					}
				}
				state = await promise;
				debugAssert(!this.curLastColumnReader);
				this.onEndSession = undefined;
			}
			const {curResultsets} = this;
			if (curResultsets)
			{	debugAssert(state==ProtocolState.HAS_MORE_ROWS || state==ProtocolState.HAS_MORE_RESULTSETS);
				try
				{	debugAssert(curResultsets.hasMoreInternal);
					state = await this.doDiscard(state);
					debugAssert(!curResultsets.hasMoreInternal && (!curResultsets.protocol || curResultsets.stmtId>=0));
					curResultsets.hasMoreInternal = true; // mark this resultset as cancelled (hasMoreProtocol && !protocol)
				}
				catch (e)
				{	this.logger.error(e);
					recycleConnection = false;
					this.curResultsets = undefined;
				}
				debugAssert(!this.curResultsets);
			}
			if (rollbackPreparedXaId)
			{	try
				{	await this.sendComQuery(`XA END '${rollbackPreparedXaId}'`);
				}
				catch
				{	// ok
				}
				try
				{	await this.sendComQuery(`XA ROLLBACK '${rollbackPreparedXaId}'`);
				}
				catch (e)
				{	this.logger.error(e);
				}
			}
			this.curLastColumnReader = undefined;
			this.onEndSession = undefined;
			const buffer = this.recycleBuffer();
			if (recycleConnection && (state==ProtocolState.IDLE || state==ProtocolState.IDLE_IN_POOL))
			{	// recycle connection
				const protocol = new MyProtocol(this.conn, this.decoder, buffer, this.dsn);
				protocol.serverVersion = this.serverVersion;
				protocol.connectionId = this.connectionId;
				protocol.capabilityFlags = this.capabilityFlags;
				protocol.initSchema = this.initSchema;
				protocol.initSql = this.initSql;
				protocol.maxColumnLen = this.maxColumnLen;
				protocol.retryQueryTimes = this.retryQueryTimes;
				protocol.onLoadFile = this.onLoadFile;
				protocol.logger = this.logger;
				const {initSchema, initSql} = this;
				try
				{	if (this.sqlLogger)
					{	await this.sqlLogger.resetConnection(this.connectionId);
						if (withDisposeSqlLogger)
						{	await this.sqlLogger.dispose();
						}
					}
					await protocol.sendComResetConnectionAndInitDb(initSchema);
					if (initSql)
					{	await protocol.sendComQuery(initSql);
					}
					debugAssert(protocol.state == ProtocolState.IDLE);
					protocol.state = ProtocolState.IDLE_IN_POOL;
					return protocol;
				}
				catch (e)
				{	this.logger.error(e);
				}
			}
			// don't recycle connection (only buffer)
			if (state!=ProtocolState.ERROR && state!=ProtocolState.TERMINATED)
			{	try
				{	this.conn.close();
				}
				catch (e)
				{	this.logger.error(e);
				}
			}
			if (this.sqlLogger)
			{	await this.sqlLogger.disconnect(this.connectionId);
				if (withDisposeSqlLogger)
				{	await this.sqlLogger.dispose();
				}
			}
			return buffer;
		}
	}
}
