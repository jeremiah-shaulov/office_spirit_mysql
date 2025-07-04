import {debugAssert} from './debug_assert.ts';
import {reallocAppend} from './realloc_append.ts';
import {CapabilityFlags, PacketType, StatusFlags, SessionTrack, Command, Charset, CursorType, MysqlType, ErrorCodes, SetOption} from './constants.ts';
import {BusyError, CanceledError, CanRetry, ServerDisconnectedError, SqlError} from './errors.ts';
import {Dsn} from './dsn.ts';
import {AuthPlugin} from './auth_plugins.ts';
import {SqlSource} from './my_protocol_reader_writer.ts';
import {Column, ResultsetsInternal, type Param} from './resultsets.ts';
import {dateToData} from './conv_column_value.ts';
import {SafeSqlLogger, SafeSqlLoggerQuery} from "./sql_logger.ts";
import {getTimezoneMsecOffsetFromSystem} from "./get_timezone_msec_offset_from_system.ts";
import {RdStream} from './deps.ts';
import {Closer, Reader} from './deno_ifaces.ts';
import {utf8StringLength} from './utf8_string_length.ts';
import {MyProtocolReaderWriterSerializer} from './my_protocol_reader_writer_serializer.ts';
import {promiseAllSettledThrow} from './promise_all_settled_throw.ts';

const DEFAULT_MAX_COLUMN_LEN = 10*1024*1024;
const DEFAULT_RETRY_QUERY_TIMES = 0;
const DEFAULT_CHARACTER_SET_CLIENT = Charset.UTF8_UNICODE_CI;
const DEFAULT_TEXT_DECODER = new TextDecoder('utf-8');

const BUFFER_FOR_END_SESSION = new Uint8Array(8*1024);
const PACKET_NOT_READ_BIT = 256;

type OnLoadFileResult = (Reader & Closer) | ({readonly readable: ReadableStream<Uint8Array>}&Disposable) | undefined;
export type OnLoadFile = (filename: string, dsn: Dsn) => OnLoadFileResult | Promise<OnLoadFileResult>;

// deno-lint-ignore no-explicit-any
type Any = any;

export interface Logger
{	debug(...args: unknown[]): unknown;
	info(...args: unknown[]): unknown;
	log(...args: unknown[]): unknown;
	warn(...args: unknown[]): unknown;
	error(...args: unknown[]): unknown;
}

export const enum ReadPacketMode
{	REGULAR,
	ROWS_OR_PREPARED_STMT,
	PREPARED_STMT_OK_CONTINUATION,
}

export const enum RowType
{	OBJECT,
	/**	Old.
		@deprecated
	 **/
	LAST_COLUMN_READER,
	LAST_COLUMN_READABLE,
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

export const enum MultiStatements
{	NO_MATTER = 2
}

export type TakeCareOfDisconneced =
{	dsn: Dsn;
	rollbackPreparedXaId: string;
	killConnectionId: number;
};

export class MyProtocol extends MyProtocolReaderWriterSerializer
{	serverVersion = '';
	connectionId = 0;
	capabilityFlags = 0;
	statusFlags = 0;
	schema = '';

	// for connections pool:
	useTill = Number.MAX_SAFE_INTEGER; // if keepAliveTimeout specified
	useNTimes = Number.MAX_SAFE_INTEGER; // if keepAliveMax specified

	#warnings = 0;
	#affectedRows: number|bigint = 0;
	#lastInsertId: number|bigint = 0;
	#statusInfo = '';
	#timezoneMsecOffsetFromSystem = NaN;

	#state = ProtocolState.IDLE;
	#maxColumnLen = DEFAULT_MAX_COLUMN_LEN;
	#retryQueryTimes = DEFAULT_RETRY_QUERY_TIMES;
	#onLoadFile?: OnLoadFile;
	#sqlLogger: SafeSqlLogger | undefined;

	#curMultiStatements: SetOption | MultiStatements = SetOption.MULTI_STATEMENTS_OFF; // `MultiStatements.NO_MATTER` means that deprecated `multiStatements` setting was used, so the mode must not be changed
	#curResultsets: ResultsetsInternal<unknown> | undefined;
	#pendingCloseStmts = new Array<number>;
	#pendingChangeSchema = '';
	#curLastColumnReader: Reader | RdStream | undefined;
	#onEndSession: ((state: ProtocolState) => void) | undefined;

	#closer;

	protected constructor(writer: WritableStreamDefaultWriter<Uint8Array>, reader: ReadableStreamBYOBReader, closer: Disposable, decoder: TextDecoder, useBuffer: Uint8Array|undefined, public dsn: Dsn, readonly logger: Logger=console)
	{	super(writer, reader, decoder, useBuffer);
		this.#closer = closer;
	}

	static async inst(dsn: Dsn, pendingChangeSchema: string, takeCareOfDisconneced: TakeCareOfDisconneced[], useBuffer?: Uint8Array, onLoadFile?: OnLoadFile, sqlLogger?: SafeSqlLogger, logger: Logger=console): Promise<MyProtocol>
	{	const {addr, initSql, maxColumnLen, username, password, schema, foundRows, ignoreSpace, multiStatements, retryQueryTimes} = dsn;
		if (username.length > 256) // must fit packet
		{	throw new SqlError('Username is too long');
		}
		if (password.length > 256) // must fit packet
		{	throw new SqlError('Password is too long');
		}
		if (schema.length>256 || pendingChangeSchema.length>256) // must fit packet
		{	throw new SqlError('Schema name is too long');
		}
		const conn = await Deno.connect(addr as Any); // "as any" in order to avoid requireing --unstable
		const reader = conn.readable.getReader({mode: 'byob'});
		const writer = conn.writable.getWriter();
		const protocol = new MyProtocol(writer, reader, conn, DEFAULT_TEXT_DECODER, useBuffer, dsn, logger);
		if (maxColumnLen > 0)
		{	protocol.#maxColumnLen = maxColumnLen;
		}
		protocol.#curMultiStatements = multiStatements ? MultiStatements.NO_MATTER : initSql ? SetOption.MULTI_STATEMENTS_ON : SetOption.MULTI_STATEMENTS_OFF; // `multiStatements` setting is deprecated
		if (retryQueryTimes >= 0)
		{	protocol.#retryQueryTimes = retryQueryTimes;
		}
		protocol.#onLoadFile = onLoadFile;
		try
		{	const authPlugin = await protocol.#readHandshake();
			if (sqlLogger)
			{	// connectionId is set after `readHandshake()`
				protocol.#sqlLogger = sqlLogger;
				await sqlLogger.connect(protocol.connectionId);
			}
			await protocol.#writeHandshakeResponse(username, password, pendingChangeSchema || schema, authPlugin, foundRows, ignoreSpace, multiStatements || !!initSql);
			const authPlugin2 = await protocol.#readAuthResponse(password, authPlugin);
			if (authPlugin2)
			{	await protocol.#writeAuthSwitchResponse(password, authPlugin2);
				await protocol.#readAuthResponse(password, authPlugin2);
			}
			if (takeCareOfDisconneced.length)
			{	await protocol.#clearDisconnected(takeCareOfDisconneced);
			}
			if (initSql)
			{	await protocol.sendComQuery(initSql, RowType.VOID, false, SetOption.MULTI_STATEMENTS_ON);
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
	async #readHandshake()
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
		let authPluginData: Uint8Array<ArrayBufferLike> = new Uint8Array(24).subarray(0, 0);
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
	async #writeHandshakeResponse(username: string, password: string, schema: string, authPlugin: AuthPlugin, foundRows: boolean, ignoreSpace: boolean, multiStatements: boolean)
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
			this.writeShortNulString(username);
			// auth
			if (!password)
			{	this.writeUint8(0);
			}
			else
			{	const auth = await authPlugin.quickAuth(password);
				if (this.capabilityFlags & CapabilityFlags.CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA)
				{	this.writeLenencInt(auth.length);
					this.writeShortBytes(auth);
				}
				else if (this.capabilityFlags & CapabilityFlags.CLIENT_SECURE_CONNECTION)
				{	this.writeUint8(auth.length);
					this.writeShortBytes(auth);
				}
				else
				{	this.writeShortNulBytes(auth);
				}
			}
			// schema
			if (this.capabilityFlags & CapabilityFlags.CLIENT_CONNECT_WITH_DB)
			{	this.writeShortNulString(schema);
			}
			// auth_plugin_name
			if (this.capabilityFlags & CapabilityFlags.CLIENT_PLUGIN_AUTH)
			{	this.writeShortNulString(authPlugin.name);
			}
		}
		else
		{	this.writeUint16(this.capabilityFlags);
			this.writeUint32(0xFFFFFF); // max packet size
			this.writeShortNulString(username);
			const auth = !password ? new Uint8Array : await authPlugin.quickAuth(password);
			if (this.capabilityFlags & CapabilityFlags.CLIENT_CONNECT_WITH_DB)
			{	this.writeShortNulBytes(auth);
				this.writeShortNulString(schema);
			}
			else
			{	this.writeShortBytes(auth);
			}
		}
		return await this.send();
	}

	/**	If guessed auth method that was used during handshake was correct, just OK packet will be read on successful auth, and ERR if auth failed.
		But server can ask to switch auth method (EOF) or request plugin auth.
		This function returns different authPlugin if auth switch required.
	 **/
	async #readAuthResponse(password: string, authPlugin: AuthPlugin)
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
				throw new SqlError(errorMessage, errorCode, sqlState, (this.statusFlags & StatusFlags.SERVER_STATUS_AUTOCOMMIT) != 0, (this.statusFlags & StatusFlags.SERVER_STATUS_IN_TRANS) != 0);
			}
			default: // Use plugin for authentication
			{	let data = this.readShortEofBytes() ?? await this.readShortEofBytesAsync();
				while (!await authPlugin.progress(password, type, data, this))
				{	type = await this.#readPacket();
					if (type != PacketType.OK)
					{	data = this.readShortEofBytes() ?? await this.readShortEofBytesAsync();
					}
				}
			}
		}
	}

	/**	Respond to second auth attempt, after got AuthSwitchRequest.
	 **/
	async #writeAuthSwitchResponse(password: string, authPlugin: AuthPlugin)
	{	this.startWritingNewPacket();
		if (password)
		{	const auth = await authPlugin.quickAuth(password);
			this.writeShortBytes(auth);
		}
		return await this.send();
	}

	/**	Reads packet header, and packet type (first byte of the packet).
		If the packet type was OK (in all modes except ROWS_OR_PREPARED_STMT) or EOF (in all modes), reads it to the end, and returns either OK (in ReadPacketMode.REGULAR), or (in other modes) the read packet type (OK or EOF).
		If it was ERR, reads it to the end, and throws SqlError.
		Else, returns the packet type orred with PACKET_NOT_READ_BIT, and leaves the caller responsible to read the packet to the end.
	 **/
	async #readPacket(mode=ReadPacketMode.REGULAR)
	{	let type = 0;
		if (mode != ReadPacketMode.PREPARED_STMT_OK_CONTINUATION)
		{	debugAssert(this.isAtEndOfPacket());
			this.readPacketHeader() || await this.readPacketHeaderAsync();
			type = this.readUint8() ?? await this.readUint8Async();
		}
		switch (type)
		{	case PacketType.EOF:
			{	if (this.payloadLength >= 9) // not a EOF packet. EOF packets are <9 bytes long, and if it's >=9, it's a lenenc int
				{	return type|PACKET_NOT_READ_BIT;
				}
				if (!(this.capabilityFlags & CapabilityFlags.CLIENT_DEPRECATE_EOF))
				{	if (this.capabilityFlags & CapabilityFlags.CLIENT_PROTOCOL_41)
					{	this.#warnings = this.readUint16() ?? await this.readUint16Async();
						this.statusFlags = this.readUint16() ?? await this.readUint16Async();
					}
					this.gotoEndOfPacket() || await this.gotoEndOfPacketAsync();
					return mode==ReadPacketMode.REGULAR ? PacketType.OK : type;
				}
			}
			// fallthrough to OK
			case PacketType.OK:
			{	if (mode!=ReadPacketMode.ROWS_OR_PREPARED_STMT || type==PacketType.EOF)
				{	this.#affectedRows = this.readLenencInt() ?? await this.readLenencIntAsync();
					this.#lastInsertId = this.readLenencInt() ?? await this.readLenencIntAsync();
					if (this.capabilityFlags & CapabilityFlags.CLIENT_PROTOCOL_41)
					{	this.statusFlags = this.readUint16() ?? await this.readUint16Async();
						this.#warnings = this.readUint16() ?? await this.readUint16Async();
					}
					else if (this.capabilityFlags & CapabilityFlags.CLIENT_TRANSACTIONS)
					{	this.statusFlags = this.readUint16() ?? await this.readUint16Async();
					}
					if (!this.isAtEndOfPacket())
					{	if (this.capabilityFlags & CapabilityFlags.CLIENT_SESSION_TRACK)
						{	this.#statusInfo = this.readShortLenencString() ?? await this.readShortLenencStringAsync();
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
											{	this.#setCharacterSetClient(value);
											}
											else if (name == 'character_set_results')
											{	this.#setCharacterSetResults(value);
											}
											else if (name == 'time_zone')
											{	this.#setTimeZone(value);
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
						{	this.#statusInfo = this.readShortEofString() ?? await this.readShortEofStringAsync();
						}
					}
					return mode==ReadPacketMode.REGULAR ? PacketType.OK : type;
				}
				return type|PACKET_NOT_READ_BIT;
			}
			case PacketType.ERR:
			{	const errorCode = this.readUint16() ?? await this.readUint16Async();
				let sqlState = '';
				if (this.capabilityFlags & CapabilityFlags.CLIENT_PROTOCOL_41)
				{	sqlState = this.readShortString(6) ?? await this.readShortStringAsync(6);
				}
				const errorMessage = this.readShortEofString() ?? await this.readShortEofStringAsync();
				debugAssert(this.isAtEndOfPacket());
				throw new SqlError(errorMessage, errorCode, sqlState, (this.statusFlags & StatusFlags.SERVER_STATUS_AUTOCOMMIT) != 0, (this.statusFlags & StatusFlags.SERVER_STATUS_IN_TRANS) != 0);
			}
			default:
			{	return type|PACKET_NOT_READ_BIT;
			}
		}
	}

	#setCharacterSetClient(value: string)
	{	if (value.slice(0, 4) != 'utf8')
		{	throw new Error(`Cannot use this value for character_set_client: ${value}. Can only use utf8.`);
		}
	}

	#setCharacterSetResults(value: string)
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

	#setTimeZone(value: string)
	{	this.#timezoneMsecOffsetFromSystem = 0;
		if (value != 'SYSTEM')
		{	try
			{	this.#timezoneMsecOffsetFromSystem = getTimezoneMsecOffsetFromSystem(value);
			}
			catch (e)
			{	this.logger.warn(e);
			}
		}
	}

	getTimezoneMsecOffsetFromSystem()
	{	if (Number.isNaN(this.#timezoneMsecOffsetFromSystem))
		{	this.logger.warn(`Using system timezone to convert dates, that can lead to distortion if MySQL and Deno use different timezones. To respect MySQL timezone, execute "SET time_zone = '...'" statement as part of connection initialization. However this library can recognize such statement only if you're using MySQL 5.7+, and this doesn't work on MariaDB (at least up to 10.7).`);
			this.#timezoneMsecOffsetFromSystem = 0;
		}
		return this.#timezoneMsecOffsetFromSystem;
	}

	authSendUint8Packet(value: number)
	{	debugAssert(this.#state == ProtocolState.IDLE); // this function is used during connecting phase, when the MyProtocol object is not returned from MyProtocol.inst().
		this.startWritingNewPacket();
		this.writeUint8(value);
		return this.send();
	}

	authSendBytesPacket(value: Uint8Array)
	{	debugAssert(this.#state == ProtocolState.IDLE); // this function is used during connecting phase, when the MyProtocol object is not returned from MyProtocol.inst().
		this.startWritingNewPacket();
		this.writeShortBytes(value);
		return this.send();
	}

	async #clearDisconnected(takeCareOfDisconneced: TakeCareOfDisconneced[])
	{	const {hashNoSchema} = this.dsn;
		const failed = new Array<TakeCareOfDisconneced>;
		while (true)
		{	const i = takeCareOfDisconneced.findIndex(v => v.dsn.hashNoSchema == hashNoSchema);
			if (i == -1)
			{	break;
			}
			let {dsn, rollbackPreparedXaId, killConnectionId} = takeCareOfDisconneced[i];
			takeCareOfDisconneced[i] = takeCareOfDisconneced[takeCareOfDisconneced.length - 1];
			takeCareOfDisconneced.length--;
			if (killConnectionId)
			{	try
				{	await this.sendComQuery(`KILL ${Number(killConnectionId)}`);
					killConnectionId = 0;
				}
				catch (e)
				{	if (e instanceof SqlError && e.errorCode==ErrorCodes.ER_NO_SUCH_THREAD)
					{	killConnectionId = 0;
					}
				}
			}
			if (rollbackPreparedXaId)
			{	try
				{	await this.sendComQuery(`XA ROLLBACK '${rollbackPreparedXaId}'`);
					rollbackPreparedXaId = '';
				}
				catch (e)
				{	if (e instanceof SqlError && e.errorCode==ErrorCodes.ER_XAER_NOTA)
					{	rollbackPreparedXaId = '';
					}
				}
			}
			if (killConnectionId || rollbackPreparedXaId)
			{	failed.push({dsn, rollbackPreparedXaId, killConnectionId});
			}
		}
		for (const f of failed)
		{	takeCareOfDisconneced.push(f);
		}
	}

	#initResultsets(resultsets: ResultsetsInternal<unknown>)
	{	resultsets.lastInsertId = this.#lastInsertId;
		resultsets.warnings = this.#warnings;
		resultsets.statusInfo = this.#statusInfo;
		resultsets.noGoodIndexUsed = (this.statusFlags & StatusFlags.SERVER_STATUS_NO_GOOD_INDEX_USED) != 0;
		resultsets.noIndexUsed = (this.statusFlags & StatusFlags.SERVER_STATUS_NO_INDEX_USED) != 0;
		resultsets.isSlowQuery = (this.statusFlags & StatusFlags.SERVER_QUERY_WAS_SLOW) != 0;
		if (this.capabilityFlags & CapabilityFlags.CLIENT_FOUND_ROWS)
		{	resultsets.foundRows = this.#affectedRows;
		}
		else
		{	resultsets.affectedRows = this.#affectedRows;
		}
	}

	async #readQueryResponse(resultsets: ResultsetsInternal<unknown>, mode: ReadPacketMode, skipColumns=false)
	{	debugAssert(mode==ReadPacketMode.REGULAR || mode==ReadPacketMode.ROWS_OR_PREPARED_STMT);
		debugAssert(resultsets.stmtId < 0);
L:		while (true)
		{	const type = await this.#readPacket(mode);
			let nColumns: number|bigint = 0;
			let nPlaceholders = 0;
			switch (type)
			{	case PacketType.OK:
				{	this.#initResultsets(resultsets);
					nColumns = 0;
					break;
				}
				case PACKET_NOT_READ_BIT:
				{	resultsets.isPreparedStmt = true;
					resultsets.stmtId = this.readUint32() ?? await this.readUint32Async();
					nColumns = this.readUint16() ?? await this.readUint16Async();
					nPlaceholders = this.readUint16() ?? await this.readUint16Async();
					this.readUint8() ?? await this.readUint8Async(); // skip reserved1
					this.#warnings = this.readUint16() ?? await this.readUint16Async();
					this.gotoEndOfPacket() || await this.gotoEndOfPacketAsync();
					break;
				}
				case PacketType.NULL_OR_LOCAL_INFILE | PACKET_NOT_READ_BIT:
				{	const filename = this.readShortEofString() ?? await this.readShortEofStringAsync();
					debugAssert(this.isAtEndOfPacket());
					if (!this.#onLoadFile)
					{	throw new Error(`LOCAL INFILE handler is not set. Requested file: ${filename}`);
					}
					const readerPromise = this.#onLoadFile(filename, this.dsn);
					const reader = readerPromise instanceof Promise ? await readerPromise : readerPromise;
					if (!reader)
					{	throw new Error(`File is not accepted for LOCAL INFILE: ${filename}`);
					}
					if ('read' in reader)
					{	try
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
					}
					else
					{	let reader2;
						try
						{	reader2 = reader.readable.getReader({mode: 'byob'});
							let buffer = new Uint8Array(this.buffer.length);
							while (true)
							{	this.startWritingNewPacket();
								const {value, done} = await reader2.read(buffer.subarray(0, this.buffer.length - this.bufferEnd));
								if (done)
								{	await this.send();
									break;
								}
								buffer = new Uint8Array(value.buffer);
								this.writeShortBytes(value);
								await this.send();
							}
						}
						finally
						{	reader2?.releaseLock();
							try
							{	reader[Symbol.dispose]();
							}
							catch (e)
							{	this.logger.error(e);
							}
						}
					}
					continue L;
				}
				case PacketType.UINT16 | PACKET_NOT_READ_BIT:
				{	nColumns = this.readUint16() ?? await this.readUint16Async();
					break;
				}
				case PacketType.UINT24 | PACKET_NOT_READ_BIT:
				{	nColumns = this.readUint24() ?? await this.readUint24Async();
					break;
				}
				case PacketType.UINT64 | PACKET_NOT_READ_BIT:
				{	nColumns = this.readUint64() ?? await this.readUint64Async();
					break;
				}
				default:
				{	nColumns = type & 0xFF; // clear PACKET_NOT_READ_BIT
				}
			}
			if (nColumns > Number.MAX_SAFE_INTEGER) // want cast bigint -> number
			{	throw new Error(`Can't handle so many columns: ${nColumns}`);
			}
			const nColumnsNum = Number(nColumns);

			// Read sequence of ColumnDefinition packets
			if (nPlaceholders > 0)
			{	await this.#skipColumnDefinitionPackets(nPlaceholders);
			}
			resultsets.nPlaceholders = nPlaceholders;
			if (nColumnsNum == 0)
			{	resultsets.columns = [];
			}
			else if (skipColumns)
			{	resultsets.columns = [];
				await this.#skipColumnDefinitionPackets(nColumnsNum);
			}
			else
			{	resultsets.columns = await this.#readColumnDefinitionPackets(nColumnsNum);
			}

			return nColumnsNum!=0 ? ProtocolState.HAS_MORE_ROWS : this.statusFlags&StatusFlags.SERVER_MORE_RESULTS_EXISTS ? ProtocolState.HAS_MORE_RESULTSETS : ProtocolState.IDLE;
		}
	}

	async #skipColumnDefinitionPackets(nPackets: number)
	{	debugAssert(nPackets > 0);
		for (let i=0; i<nPackets; i++)
		{	// Read ColumnDefinition41 packet
			this.readPacketHeader() || await this.readPacketHeaderAsync();
			this.gotoEndOfPacket() || await this.gotoEndOfPacketAsync();
		}
		if (!(this.capabilityFlags & CapabilityFlags.CLIENT_DEPRECATE_EOF))
		{	// Read EOF after columns list
			const type = await this.#readPacket();
			debugAssert(type == PacketType.OK);
		}
	}

	async #readColumnDefinitionPackets(nPackets: number)
	{	const columns = new Array<Column>;
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
				const type = await this.#readPacket();
				debugAssert(type == PacketType.OK);
			}
		}
		return columns;
	}

	#setQueryingState()
	{	switch (this.#state)
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
				this.#state = ProtocolState.QUERYING;
				return true;
			default:
				debugAssert(this.#state == ProtocolState.IDLE);
				this.#state = ProtocolState.QUERYING;
				return false;
		}
	}

	#rethrowError(error: unknown): never
	{	let state = ProtocolState.IDLE;
		if (!(error instanceof SqlError))
		{	if (this.#state != ProtocolState.ERROR)
			{	try
				{	this.#closer[Symbol.dispose]();
				}
				catch (e)
				{	this.logger.error(e);
				}
			}
			state = ProtocolState.ERROR;
		}
		this.#setState(state);
		throw error;
	}

	#rethrowErrorIfFatal(error: unknown, isFromPool=false)
	{	let state = ProtocolState.IDLE;
		if (!(error instanceof SqlError))
		{	try
			{	this.#closer[Symbol.dispose]();
			}
			catch (e)
			{	this.logger.error(e);
			}
			if (isFromPool)
			{	this.#setState(ProtocolState.ERROR);
				return;
			}
			state = ProtocolState.ERROR;
		}
		this.#setState(state);
		throw error;
	}

	#setState(state: ProtocolState)
	{	if (this.#onEndSession)
		{	this.#onEndSession(state);
		}
		else
		{	this.#state = state;
		}
	}

	/**	This function adds to the buffer packets that deallocate all the prepared statements that are not in use anymore.
		The server will not respond to these packets.
		Call this before starting to send something else to the server,
		so the deallocation will be sent together with other data, and no special sending operation will be required.
		This function returns promise, if need to send the packets, or `undefined`.
		After awaiting the returned promise, call this function again, until it returns `undefined`.
	 **/
	#doPending(): Promise<unknown>|undefined
	{	const pendingCloseStmts = this.#pendingCloseStmts;
		let i = pendingCloseStmts.length;
		if (i > 0)
		{	const logPromise = !this.#sqlLogger ? undefined : this.#sqlLogger.deallocatePrepare(this.connectionId, pendingCloseStmts);
			if (this.bufferEnd == this.bufferStart)
			{	this.bufferStart = 0;
				this.bufferEnd = 0;
			}
			while (i>0 && this.bufferEnd+9<=this.buffer.length)
			{	const stmtId = pendingCloseStmts[--i];
				this.startWritingNewPacket(true);
				this.writeUint8(Command.COM_STMT_CLOSE);
				this.writeUint32(stmtId);
			}
			pendingCloseStmts.length = i;
			if (this.bufferEnd > this.buffer.length/2)
			{	const promise = this.send();
				return !logPromise ? promise : promiseAllSettledThrow([logPromise, promise]);
			}
			return logPromise;
		}
	}

	use(schema: string)
	{	this.#pendingChangeSchema = schema;
	}

	setSqlLogger(sqlLogger?: SafeSqlLogger)
	{	this.#sqlLogger = sqlLogger;
	}

	/**	I assume that i'm in ProtocolState.IDLE.
	 **/
	async #sendComResetConnectionAndInitDb(schema: string)
	{	this.startWritingNewPacket(true);
		this.writeUint8(Command.COM_RESET_CONNECTION);
		if (schema)
		{	this.writeComInitDb(schema);
		}
		await this.send();
		let isOk = true;
		let error;
		try
		{	await this.#readPacket();
		}
		catch (e)
		{	if (!(e instanceof SqlError))
			{	throw e; // rethrow non-SQL error
			}
			if (e.message == 'Unknown command')
			{	this.logger.warn(`Couldn't reset connection state. This is only supported on MySQL 5.7+ and MariaDB 10.2+`, e);
				isOk = false;
			}
			else
			{	error = e;
			}
		}
		if (schema)
		{	await this.#readPacket();
		}
		if (error)
		{	throw error;
		}
		return isOk;
	}

	writeComInitDb(schema: string)
	{	this.startWritingNewPacket(true);
		this.writeUint8(Command.COM_INIT_DB);
		this.writeShortString(schema);
	}

	/**	I assume that i'm in ProtocolState.IDLE.
	 **/
	#sendComQuit()
	{	this.startWritingNewPacket(true);
		this.writeUint8(Command.COM_QUIT);
		return this.send();
	}

	#maybeInitDb()
	{	if (this.#pendingChangeSchema)
		{	if (!this.schema || this.schema!=this.#pendingChangeSchema)
			{	this.writeComInitDb(this.#pendingChangeSchema);
				this.#pendingChangeSchema = '';
				return true;
			}
			this.#pendingChangeSchema = '';
		}
		return false;
	}

	#maybeSetOption(multiStatements: SetOption|MultiStatements)
	{	if (multiStatements==SetOption.MULTI_STATEMENTS_ON && this.#curMultiStatements==SetOption.MULTI_STATEMENTS_OFF || multiStatements==SetOption.MULTI_STATEMENTS_OFF && this.#curMultiStatements==SetOption.MULTI_STATEMENTS_ON)
		{	this.startWritingNewPacket(true);
			this.writeUint8(Command.COM_SET_OPTION);
			this.writeUint16(multiStatements);
			return true;
		}
		return false;
	}

	/**	On success returns ResultsetsProtocol<Row>.
		On error throws exception.
		If `letReturnUndefined` and communication error occured on connection that was just taken form pool, returns undefined.
	 **/
	async sendComQuery<Row>
	(	sql: SqlSource,
		rowType = RowType.VOID,
		letReturnUndefined = false,
		multiStatements: SetOption|MultiStatements = MultiStatements.NO_MATTER,
		noConvertError = false,
		maxColumnLen = this.#maxColumnLen,
		retryLockWaitTimeout = this.dsn.retryLockWaitTimeout,
		retryQueryTimes = this.#retryQueryTimes,
		jsonAsString = this.dsn.jsonAsString,
		datesAsString = this.dsn.datesAsString,
		correctDates = this.dsn.correctDates
	)
	{	const isFromPool = this.#setQueryingState();
		const noBackslashEscapes = (this.statusFlags & StatusFlags.SERVER_STATUS_NO_BACKSLASH_ESCAPES) != 0;
		let sqlLoggerQuery: SafeSqlLoggerQuery | undefined;
		while (true)
		{	let error;
			try
			{	// Send COM_STMT_CLOSE if needed
				{	let promise;
					while ((promise = this.#doPending()))
					{	await promise;
					}
				}
				// Send COM_INIT_DB
				const wantInitDb = this.#maybeInitDb();
				// Log query begin
				if (this.#sqlLogger)
				{	sqlLoggerQuery = await this.#sqlLogger.query(this.connectionId, false, noBackslashEscapes);
				}
				// Send COM_SET_OPTION
				const wantSetOption = this.#maybeSetOption(multiStatements);
				// Send query
				this.startWritingNewPacket(true);
				this.writeUint8(Command.COM_QUERY);
				await this.sendWithData(sql, noBackslashEscapes, sqlLoggerQuery?.appendToQuery);
				// Read COM_INIT_DB result
				if (wantInitDb)
				{	try
					{	await this.#readPacket();
					}
					catch (e)
					{	error = e;
					}
				}
				// Read COM_SET_OPTION result
				if (wantSetOption)
				{	try
					{	await this.#readPacket();
						this.#curMultiStatements = multiStatements;
					}
					catch (e)
					{	error = e;
					}
				}
				// Read query result
				if (sqlLoggerQuery)
				{	await sqlLoggerQuery.start();
				}
				const resultsets = new ResultsetsInternal<Row>(rowType, maxColumnLen, jsonAsString, datesAsString, correctDates);
				let state = await this.#readQueryResponse(resultsets, ReadPacketMode.REGULAR);
				if (state != ProtocolState.IDLE)
				{	resultsets.protocol = this;
					resultsets.hasMoreInternal = true;
					this.#curResultsets = resultsets;
					if (rowType == RowType.VOID)
					{	// discard resultsets
						state = await this.#doDiscard(state);
					}
				}
				this.#setState(state);
				if (sqlLoggerQuery)
				{	await sqlLoggerQuery.end(resultsets, -1);
				}
				if (error)
				{	throw error;
				}
				return resultsets;
			}
			catch (e)
			{	if (!error)
				{	error = e;
				}
				if (sqlLoggerQuery)
				{	await sqlLoggerQuery.end(error instanceof Error ? error: new Error(error+''), -1);
				}
				if (retryQueryTimes>0 && (error instanceof SqlError) && error.canRetry==CanRetry.QUERY && !(error.errorCode==ErrorCodes.ER_LOCK_WAIT_TIMEOUT && !retryLockWaitTimeout))
				{	this.logger.warn(`Query failed and will be retried more ${retryQueryTimes} times: ${error.message}`);
					retryQueryTimes--;
					continue;
				}
				if (noConvertError)
				{	throw error;
				}
				this.#rethrowErrorIfFatal(error, isFromPool && letReturnUndefined);
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
	async sendThreeQueries<Row>
	(	preStmtId: number,
		preStmtParams: unknown[]|undefined,
		prequery: Uint8Array|string|undefined,
		ignorePrequeryError: boolean,
		sql: SqlSource,
		rowType = RowType.VOID,
		letReturnUndefined = false,
		multiStatements: SetOption|MultiStatements = MultiStatements.NO_MATTER,
		maxColumnLen = this.#maxColumnLen,
		retryLockWaitTimeout = this.dsn.retryLockWaitTimeout,
		retryQueryTimes = this.#retryQueryTimes,
		jsonAsString = this.dsn.jsonAsString,
		datesAsString = this.dsn.datesAsString,
		correctDates = this.dsn.correctDates
	)
	{	const isFromPool = this.#setQueryingState();
		const noBackslashEscapes = (this.statusFlags & StatusFlags.SERVER_STATUS_NO_BACKSLASH_ESCAPES) != 0;
		let sqlLoggerQuery: SafeSqlLoggerQuery | undefined;
		while (true)
		{	let error;
			try
			{	// Send COM_STMT_CLOSE if needed
				{	let promise;
					while ((promise = this.#doPending()))
					{	await promise;
					}
				}
				// Send COM_INIT_DB
				const wantInitDb = this.#maybeInitDb();
				// Log query begin
				if (this.#sqlLogger)
				{	sqlLoggerQuery = await this.#sqlLogger.query(this.connectionId, false, noBackslashEscapes);
				}
				// Send preStmt
				if (preStmtId >= 0)
				{	debugAssert(preStmtParams);
					if (sqlLoggerQuery)
					{	await sqlLoggerQuery.setStmtId(preStmtId);
					}
					await this.#sendComStmtExecute(preStmtId, preStmtParams.length, preStmtParams, sqlLoggerQuery, correctDates);
				}
				// Send prequery
				if (prequery)
				{	if (sqlLoggerQuery && preStmtId>=0)
					{	await sqlLoggerQuery.nextQuery();
					}
					this.startWritingNewPacket(true);
					this.writeUint8(Command.COM_QUERY);
					await this.sendWithData(prequery, false, sqlLoggerQuery?.appendToQuery, true);
				}
				// Send COM_SET_OPTION
				const wantSetOption = this.#maybeSetOption(multiStatements);
				// Send sql
				if (sqlLoggerQuery && (preStmtId>=0 || prequery))
				{	await sqlLoggerQuery.nextQuery();
				}
				this.startWritingNewPacket(true);
				this.writeUint8(Command.COM_QUERY);
				await this.sendWithData(sql, noBackslashEscapes, sqlLoggerQuery?.appendToQuery);
				if (sqlLoggerQuery)
				{	await sqlLoggerQuery.start();
				}
				// Read COM_INIT_DB result
				if (wantInitDb)
				{	try
					{	await this.#readPacket();
					}
					catch (e)
					{	error = e;
					}
				}
				// Read preStmt result
				if (preStmtId >= 0)
				{	const rowNColumns = await this.#readPacket(ReadPacketMode.ROWS_OR_PREPARED_STMT);
					debugAssert(rowNColumns == PACKET_NOT_READ_BIT); // preStmt must not return rows/columns
					debugAssert(!(this.statusFlags & StatusFlags.SERVER_MORE_RESULTS_EXISTS)); // preStmt must not return rows/columns
					if (!this.isAtEndOfPacket())
					{	await this.#readPacket(ReadPacketMode.PREPARED_STMT_OK_CONTINUATION);
					}
				}
				// Read prequery result
				const resultsets = new ResultsetsInternal<Row>(rowType, maxColumnLen, jsonAsString, datesAsString, correctDates);
				let state = ProtocolState.IDLE;
				if (prequery)
				{	try
					{	state = await this.#readQueryResponse(resultsets, ReadPacketMode.REGULAR);
					}
					catch (e)
					{	if (ignorePrequeryError && (e instanceof SqlError))
						{	this.logger.error(e);
						}
						else
						{	error = e;
						}
					}
				}
				debugAssert(state == ProtocolState.IDLE);
				// Read COM_SET_OPTION result
				if (wantSetOption)
				{	try
					{	await this.#readPacket();
						this.#curMultiStatements = multiStatements;
					}
					catch (e)
					{	error = e;
					}
				}
				// Read sql result
				try
				{	state = await this.#readQueryResponse(resultsets, ReadPacketMode.REGULAR);
					if (sqlLoggerQuery)
					{	await sqlLoggerQuery.end(resultsets, -1);
					}
				}
				catch (e)
				{	if (sqlLoggerQuery)
					{	await sqlLoggerQuery.end(e instanceof Error ? e : new Error(e+''), -1);
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
					this.#curResultsets = resultsets;
					if (rowType == RowType.VOID)
					{	// discard resultsets
						state = await this.#doDiscard(state);
					}
				}
				this.#setState(state);
				return resultsets;
			}
			catch (e)
			{	if (!error)
				{	error = e;
				}
				if (retryQueryTimes>0 && (error instanceof SqlError) && error.canRetry==CanRetry.QUERY && !(error.errorCode==ErrorCodes.ER_LOCK_WAIT_TIMEOUT && !retryLockWaitTimeout))
				{	this.logger.warn(`Query failed and will be retried more ${retryQueryTimes} times: ${error.message}`);
					retryQueryTimes--;
					preStmtId = -1;
					prequery = undefined;
					continue;
				}
				this.#rethrowErrorIfFatal(error, isFromPool && letReturnUndefined);
			}
			break;
		}
	}

	/**	On success returns ResultsetsProtocol<Row>.
		On error throws exception.
		If `letReturnUndefined` and communication error occured on connection that was just taken form pool, returns undefined.
	 **/
	async sendComStmtPrepare<Row>
	(	sql: SqlSource,
		putParamsTo: unknown[]|undefined,
		rowType: RowType,
		letReturnUndefined = false,
		skipColumns = false,
		maxColumnLen = this.#maxColumnLen,
		jsonAsString = this.dsn.jsonAsString,
		datesAsString = this.dsn.datesAsString,
		correctDates = this.dsn.correctDates
	)
	{	const isFromPool = this.#setQueryingState();
		const noBackslashEscapes = (this.statusFlags & StatusFlags.SERVER_STATUS_NO_BACKSLASH_ESCAPES) != 0;
		let sqlLoggerQuery: SafeSqlLoggerQuery | undefined;
		try
		{	// Send COM_STMT_CLOSE if needed
			{	let promise;
				while ((promise = this.#doPending()))
				{	await promise;
				}
			}
			// Send COM_INIT_DB
			const wantInitDb = this.#maybeInitDb();
			// Log query begin
			if (this.#sqlLogger)
			{	sqlLoggerQuery = await this.#sqlLogger.query(this.connectionId, true, noBackslashEscapes);
			}
			// Send COM_STMT_PREPARE
			this.startWritingNewPacket(true);
			this.writeUint8(Command.COM_STMT_PREPARE);
			await this.sendWithData(sql, noBackslashEscapes, sqlLoggerQuery?.appendToQuery, false, putParamsTo);
			// Read COM_INIT_DB result
			let error;
			if (wantInitDb)
			{	try
				{	await this.#readPacket();
				}
				catch (e)
				{	error = e;
				}
			}
			// Read COM_STMT_PREPARE result
			if (sqlLoggerQuery)
			{	await sqlLoggerQuery.start();
			}
			const resultsets = new ResultsetsInternal<Row>(rowType, maxColumnLen, jsonAsString, datesAsString, correctDates);
			await this.#readQueryResponse(resultsets, ReadPacketMode.ROWS_OR_PREPARED_STMT, skipColumns);
			resultsets.protocol = this;
			this.#setState(ProtocolState.IDLE);
			if (sqlLoggerQuery)
			{	await sqlLoggerQuery.end(resultsets, resultsets.stmtId);
			}
			if (error)
			{	throw error;
			}
			return resultsets;
		}
		catch (e)
		{	if (sqlLoggerQuery)
			{	await sqlLoggerQuery.end(e instanceof Error ? e : new Error(e+''), -1);
			}
			this.#rethrowErrorIfFatal(e, isFromPool && letReturnUndefined);
		}
	}

	/**	This function can be called at any time, and the actual operation will be performed later when the connections enters idle state.
	 **/
	disposePreparedStmt(stmtId: number)
	{	const state = this.#state;
		if (state!=ProtocolState.ERROR && state!=ProtocolState.TERMINATED)
		{	this.#pendingCloseStmts.push(stmtId);
		}
	}

	async #sendComStmtExecute(stmtId: number, nPlaceholders: number, params: Param[], sqlLoggerQuery: SafeSqlLoggerQuery|undefined, correctDates: boolean)
	{	const bitmaskAndTypesSize = (nPlaceholders >> 3) + (nPlaceholders&7 ? 1 : 0) + (nPlaceholders << 1); // 1 bit per each placeholder (nPlaceholders/8 bytes) + partial byte (0 or 1 byte) + 2-byte type per each placeholder (nPlaceholders*2 bytes)
		let payloadLength = 11 + bitmaskAndTypesSize; // COM_STMT_EXECUTE (1-byte) + stmt_id (4-byte) + NO_CURSOR (1-byte) + iteration_count (4-byte) + new_params_bound_flag (1-byte) = 11
		const emptyBlobs = new Array<number>;
		for (let i=0; i<nPlaceholders; i++)
		{	const param = params[i];
			if (param!=null && typeof(param)!='function' && typeof(param)!='symbol') // if is not NULL
			{	if (typeof(param) == 'boolean')
				{	payloadLength++;
				}
				else if (typeof(param) == 'number')
				{	if (Number.isInteger(param) && param>=-0x8000_0000 && param<=0x7FFF_FFFF)
					{	payloadLength += 4;
					}
					else
					{	payloadLength += 8;
					}
				}
				else if (typeof(param) == 'bigint')
				{	payloadLength += 8;
				}
				else if (typeof(param) == 'string')
				{	if (param.length < (0xFB >> 2)) // assume: max utf8 length is param.length*4, so max param.length must be < 0xFB/4
					{	payloadLength += 1 + utf8StringLength(param); // lenenc string length (1 byte for < 0xFB data bytes) + string byte length
					}
					else
					{	this.startWritingNewPacket(true);
						this.writeUint8(Command.COM_STMT_SEND_LONG_DATA);
						this.writeUint32(stmtId);
						this.writeUint16(i);
						if (!sqlLoggerQuery)
						{	await this.sendWithData(param, false, undefined, true);
						}
						else
						{	sqlLoggerQuery.paramStart(i);
							await this.sendWithData(param, false, sqlLoggerQuery.appendToParam, true);
							await sqlLoggerQuery.paramEnd();
						}
					}
				}
				else if (param instanceof Date)
				{	const frac = param.getMilliseconds();
					payloadLength += frac ? 12 : 8;
				}
				else if (param.buffer instanceof ArrayBuffer)
				{	if (param.byteLength < 0xFB)
					{	payloadLength += 1 + param.byteLength; // lenenc blob length (1 byte for < 0xFB data bytes) + blob byte length
					}
					else
					{	this.startWritingNewPacket(true);
						this.writeUint8(Command.COM_STMT_SEND_LONG_DATA);
						this.writeUint32(stmtId);
						this.writeUint16(i);
						const data = param instanceof Uint8Array ? param : new Uint8Array(param.buffer, param.byteOffset, param.byteLength);
						if (sqlLoggerQuery)
						{	sqlLoggerQuery.paramStart(i);
							await sqlLoggerQuery.appendToParam(data);
							await sqlLoggerQuery.paramEnd();
						}
						await this.sendWithData(data, false, undefined, true);
					}
				}
				else if (param instanceof ReadableStream)
				{	const reader = param.getReader({mode: 'byob'});
					try
					{	let buffer = new Uint8Array(this.buffer.length);
						sqlLoggerQuery?.paramStart(i);
						let isNotEmpty = false;
						while (true)
						{	this.startWritingNewPacket(!isNotEmpty);
							this.writeUint8(Command.COM_STMT_SEND_LONG_DATA);
							this.writeUint32(stmtId);
							this.writeUint16(i);
							const from = this.bufferEnd;
							const {value, done} = await reader.read(buffer.subarray(0, this.buffer.length - from));
							if (done)
							{	this.discardPacket();
								break;
							}
							buffer = new Uint8Array(value.buffer);
							this.writeShortBytes(value);
							if (sqlLoggerQuery)
							{	await sqlLoggerQuery.appendToParam(this.buffer.subarray(from, this.bufferEnd));
							}
							await this.send();
							isNotEmpty = true;
						}
						if (sqlLoggerQuery)
						{	await sqlLoggerQuery.paramEnd();
						}
						if (!isNotEmpty)
						{	emptyBlobs.push(i);
						}
					}
					finally
					{	reader.releaseLock();
					}
				}
				else if (typeof(param.read) == 'function')
				{	sqlLoggerQuery?.paramStart(i);
					let isNotEmpty = false;
					while (true)
					{	this.startWritingNewPacket(!isNotEmpty);
						this.writeUint8(Command.COM_STMT_SEND_LONG_DATA);
						this.writeUint32(stmtId);
						this.writeUint16(i);
						const from = this.bufferEnd;
						const n = await this.writeReadChunk(param);
						if (n == null)
						{	this.discardPacket();
							break;
						}
						if (sqlLoggerQuery)
						{	await sqlLoggerQuery.appendToParam(this.buffer.subarray(from, this.bufferEnd));
						}
						await this.send();
						isNotEmpty = true;
					}
					if (sqlLoggerQuery)
					{	await sqlLoggerQuery.paramEnd();
					}
					if (!isNotEmpty)
					{	emptyBlobs.push(i);
					}
				}
				else
				{	// JSON-stringify object
					this.startWritingNewPacket(true);
					this.writeUint8(Command.COM_STMT_SEND_LONG_DATA);
					this.writeUint32(stmtId);
					this.writeUint16(i);
					if (!sqlLoggerQuery)
					{	await this.sendWithData(JSON.stringify(param), false, undefined, true);
					}
					else
					{	sqlLoggerQuery.paramStart(i);
						await this.sendWithData(JSON.stringify(param), false, sqlLoggerQuery.appendToParam, true);
						await sqlLoggerQuery.paramEnd();
					}
				}
			}
		}
		payloadLength += emptyBlobs.length; // empty blobs are sent as 0 byte (lenenc size of blob which is 0)
		if (payloadLength >= 0xFFFFFF)
		{	// Must not happen, because MySQL supports at most 2**16 parameters, and the longest inlined parameter i send is 0xFB bytes + 2-byte type + 1 bit (byte) nullBitMask = 254 bytes
			// So 2**16 * 254 + 11-byte packet data = 0xFE000B, which is less than 0xFFFFFF
			throw new Error("Couldn't send so many parameters");
		}
		// Send COM_STMT_EXECUTE
		this.startWritingNewPacket(true);
		this.setHeader(payloadLength);
		this.writeUint8(Command.COM_STMT_EXECUTE);
		this.writeUint32(stmtId);
		this.writeUint8(CursorType.NO_CURSOR);
		this.writeUint32(1); // iteration_count
		// Send null-bitmap for each param
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
			{	if (this.bufferEnd+3 >= this.buffer.length) // if cannot add `nullBits` + partial byte + new_params_bound_flag
				{	// Flush the buffer
					await this.writer.write(this.buffer.subarray(0, this.bufferEnd));
					this.bufferStart = 0;
					this.bufferEnd = 0;
				}
				this.writeUint8(nullBits);
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
		for (let i=0; i<nPlaceholders; i++)
		{	const param = params[i];
			let type = MysqlType.MYSQL_TYPE_STRING;
			if (param!=null && typeof(param)!='function' && typeof(param)!='symbol') // if is not NULL
			{	if (typeof(param) == 'boolean')
				{	type = MysqlType.MYSQL_TYPE_TINY;
				}
				else if (typeof(param) == 'number')
				{	if (Number.isInteger(param) && param>=-0x8000_0000 && param<=0x7FFF_FFFF)
					{	type = MysqlType.MYSQL_TYPE_LONG;
					}
					else
					{	type = MysqlType.MYSQL_TYPE_DOUBLE;
					}
				}
				else if (typeof(param) == 'bigint')
				{	type = MysqlType.MYSQL_TYPE_LONGLONG;
				}
				else if (typeof(param) == 'string')
				{	// MysqlType.MYSQL_TYPE_STRING
				}
				else if (param instanceof Date)
				{	type = MysqlType.MYSQL_TYPE_DATETIME;
				}
				else if (param.buffer instanceof ArrayBuffer)
				{	type = MysqlType.MYSQL_TYPE_LONG_BLOB;
				}
				else if (param instanceof ReadableStream)
				{	type = MysqlType.MYSQL_TYPE_LONG_BLOB;
				}
				else if (typeof(param.read) == 'function')
				{	type = MysqlType.MYSQL_TYPE_LONG_BLOB;
				}
			}
			if (this.bufferEnd+2 >= this.buffer.length) // if cannot add the `type`
			{	// Flush the buffer
				await this.writer.write(this.buffer.subarray(0, this.bufferEnd));
				this.bufferStart = 0;
				this.bufferEnd = 0;
			}
			this.writeUint16(type);
		}
		// Send value of each param
		for (let i=0; i<nPlaceholders; i++)
		{	const param = params[i];
			if (this.bufferEnd+0xFB >= this.buffer.length) // if cannot add the the longest possible value (1-byte lenenc length of blob + less than 0xFB bytes of the blob data)
			{	// Flush the buffer
				await this.writer.write(this.buffer.subarray(0, this.bufferEnd));
				this.bufferStart = 0;
				this.bufferEnd = 0;
			}
			if (param!=null && typeof(param)!='function' && typeof(param)!='symbol') // if is not NULL
			{	if (typeof(param) == 'boolean')
				{	const data = param ? 1 : 0;
					if (sqlLoggerQuery)
					{	sqlLoggerQuery.paramStart(i);
						await sqlLoggerQuery.appendToParam(data);
						await sqlLoggerQuery.paramEnd();
					}
					this.writeUint8(data);
				}
				else if (typeof(param) == 'number')
				{	if (sqlLoggerQuery)
					{	sqlLoggerQuery.paramStart(i);
						await sqlLoggerQuery.appendToParam(param);
						await sqlLoggerQuery.paramEnd();
					}
					if (Number.isInteger(param) && param>=-0x8000_0000 && param<=0x7FFF_FFFF)
					{	this.writeUint32(param);
					}
					else
					{	this.writeDouble(param);
					}
				}
				else if (typeof(param) == 'bigint')
				{	if (sqlLoggerQuery)
					{	sqlLoggerQuery.paramStart(i);
						await sqlLoggerQuery.appendToParam(param);
						await sqlLoggerQuery.paramEnd();
					}
					this.writeUint64(param);
				}
				else if (typeof(param) == 'string')
				{	if (param.length < (0xFB >> 2)) // assume: max utf8 length is param.length*4, so max param.length must be < 0xFB/4
					{	let from = this.bufferEnd;
						this.writeShortLenencString(param);
						if (sqlLoggerQuery)
						{	from += this.buffer[from]==0xFC ? 3 : 1;
							sqlLoggerQuery.paramStart(i);
							await sqlLoggerQuery.appendToParam(this.buffer.subarray(from, this.bufferEnd));
							await sqlLoggerQuery.paramEnd();
						}
					}
				}
				else if (param instanceof Date)
				{	let date = param;
					const timezoneMsecOffsetFromSystem = !correctDates ? 0 : this.getTimezoneMsecOffsetFromSystem();
					if (timezoneMsecOffsetFromSystem != 0)
					{	date = new Date(date.getTime() + timezoneMsecOffsetFromSystem);
					}
					if (sqlLoggerQuery)
					{	sqlLoggerQuery.paramStart(i);
						await sqlLoggerQuery.appendToParam(dateToData(date));
						await sqlLoggerQuery.paramEnd();
					}
					const frac = date.getMilliseconds();
					this.writeUint8(frac ? 11 : 7); // length
					this.writeUint16(date.getFullYear());
					this.writeUint8(date.getMonth() + 1);
					this.writeUint8(date.getDate());
					this.writeUint8(date.getHours());
					this.writeUint8(date.getMinutes());
					this.writeUint8(date.getSeconds());
					if (frac)
					{	this.writeUint32(frac * 1000);
					}
				}
				else if (param.buffer instanceof ArrayBuffer)
				{	if (param.byteLength < 0xFB)
					{	const data = param instanceof Uint8Array ? param : new Uint8Array(param.buffer, param.byteOffset, param.byteLength);
						if (sqlLoggerQuery)
						{	sqlLoggerQuery.paramStart(i);
							await sqlLoggerQuery.appendToParam(data);
							await sqlLoggerQuery.paramEnd();
						}
						this.writeShortLenencBytes(data);
					}
				}
				else if (param instanceof ReadableStream || typeof(param.read)=='function')
				{	if (emptyBlobs.findIndex(v => v == i) != -1)
					{	if (sqlLoggerQuery)
						{	sqlLoggerQuery.paramStart(i);
							await sqlLoggerQuery.appendToParam(new Uint8Array);
							await sqlLoggerQuery.paramEnd();
						}
						this.writeUint8(0); // 0-length lenenc-string
					}
				}
			}
		}
		if (this.bufferEnd > 0) // if there's packet data remaining
		{	// Flush the buffer
			await this.writer.write(this.buffer.subarray(0, this.bufferEnd));
			this.bufferStart = 0;
			this.bufferEnd = 0;
		}
	}

	async execStmt(resultsets: ResultsetsInternal<unknown>, params: Param[], correctDates: boolean)
	{	const {isPreparedStmt, stmtId, nPlaceholders} = resultsets;
		if (stmtId < 0)
		{	throw new SqlError(isPreparedStmt ? 'This prepared statement disposed' : 'Not a prepared statement');
		}
		this.#setQueryingState();
		const noBackslashEscapes = (this.statusFlags & StatusFlags.SERVER_STATUS_NO_BACKSLASH_ESCAPES) != 0;
		let sqlLoggerQuery: SafeSqlLoggerQuery | undefined;
		let started = false;
		try
		{	debugAssert(!resultsets.hasMoreInternal); // because setQueryingState() ensures that current resultset is read to the end
			let promise;
			while ((promise = this.#doPending()))
			{	await promise;
			}
			if (this.#sqlLogger)
			{	sqlLoggerQuery = await this.#sqlLogger.query(this.connectionId, false, noBackslashEscapes);
				if (sqlLoggerQuery)
				{	await sqlLoggerQuery.setStmtId(stmtId);
				}
			}
			await this.#sendComStmtExecute(stmtId, nPlaceholders, params, sqlLoggerQuery, correctDates);
			if (sqlLoggerQuery)
			{	started = true;
				await sqlLoggerQuery.start();
			}
			// Read Binary Protocol Resultset
			const type = await this.#readPacket(ReadPacketMode.ROWS_OR_PREPARED_STMT); // throw if ERR packet
			let rowNColumns = type & 0xFF; // clear PACKET_NOT_READ_BIT
			if (rowNColumns >= 0xFB)
			{	this.unput(rowNColumns);
				const value = this.readLenencInt() ?? await this.readLenencIntAsync();
				if (value > Number.MAX_SAFE_INTEGER) // want cast bigint -> number
				{	throw new Error(`Can't handle so many columns: ${value}`);
				}
				rowNColumns = Number(value);
			}
			if (rowNColumns > 0)
			{	resultsets.columns = await this.#readColumnDefinitionPackets(rowNColumns);
				resultsets.protocol = this;
				resultsets.hasMoreInternal = true;
				this.#curResultsets = resultsets;
				this.#setState(ProtocolState.HAS_MORE_ROWS);
			}
			else if (this.statusFlags & StatusFlags.SERVER_MORE_RESULTS_EXISTS)
			{	resultsets.protocol = this;
				resultsets.hasMoreInternal = true;
				if (!this.isAtEndOfPacket())
				{	await this.#readPacket(ReadPacketMode.PREPARED_STMT_OK_CONTINUATION);
					this.#initResultsets(resultsets);
				}
				this.#curResultsets = resultsets;
				this.#setState(ProtocolState.HAS_MORE_RESULTSETS);
			}
			else
			{	if (!this.isAtEndOfPacket())
				{	await this.#readPacket(ReadPacketMode.PREPARED_STMT_OK_CONTINUATION);
					this.#initResultsets(resultsets);
				}
				this.#setState(ProtocolState.IDLE);
			}
			if (sqlLoggerQuery)
			{	await sqlLoggerQuery.end(resultsets, -1);
			}
		}
		catch (e)
		{	if (sqlLoggerQuery)
			{	if (!started)
				{	await sqlLoggerQuery.start();
				}
				await sqlLoggerQuery.end(e instanceof Error ? e : new Error(e+''), -1);
			}
			this.#rethrowError(e);
		}
	}

	async fetch<Row>
	(	rowType: RowType,
		maxColumnLen = this.#maxColumnLen,
		jsonAsString = this.dsn.jsonAsString,
		datesAsString = this.dsn.datesAsString,
		isForSerialize = false
	): Promise<Row | undefined>
	{	switch (this.#state)
		{	case ProtocolState.IDLE:
			case ProtocolState.IDLE_IN_POOL:
			case ProtocolState.HAS_MORE_RESULTSETS:
				return undefined; // no more rows in this resultset
			case ProtocolState.QUERYING:
				throw new BusyError('Previous operation is still in progress');
			case ProtocolState.TERMINATED:
				throw new CanceledError('Connection terminated');
		}
		debugAssert(this.#state == ProtocolState.HAS_MORE_ROWS);
		debugAssert(this.#curResultsets?.hasMoreInternal); // because we're in ProtocolState.HAS_MORE_ROWS
		this.#state = ProtocolState.QUERYING;
		try
		{	const curResultsets = this.#curResultsets;
			const {isPreparedStmt, stmtId, columns} = curResultsets;
			const type = await this.#readPacket(ReadPacketMode.ROWS_OR_PREPARED_STMT);
			if (type == PacketType.EOF)
			{	if (this.statusFlags & StatusFlags.SERVER_MORE_RESULTS_EXISTS)
				{	this.#setState(ProtocolState.HAS_MORE_RESULTSETS);
				}
				else
				{	if (stmtId < 0)
					{	curResultsets.protocol = undefined;
					}
					curResultsets.hasMoreInternal = false;
					this.#curResultsets = undefined;
					this.#setState(ProtocolState.IDLE);
				}
				return undefined;
			}
			if (!isPreparedStmt)
			{	// Text protocol row
				this.unput(type & 0xFF); // clear PACKET_NOT_READ_BIT
				// deno-lint-ignore no-var no-inner-declarations
				var {row, lastColumnReaderLen} = await this.deserializeRowText(rowType, columns, jsonAsString, datesAsString, this, maxColumnLen, isForSerialize);
			}
			else
			{	// Binary protocol row
				// deno-lint-ignore no-var no-inner-declarations no-redeclare
				var {row, lastColumnReaderLen} = await this.deserializeRowBinary(rowType, columns, jsonAsString, datesAsString, this, maxColumnLen, isForSerialize);
			}
			if (rowType==RowType.LAST_COLUMN_READER || rowType==RowType.LAST_COLUMN_READABLE)
			{	// deno-lint-ignore no-this-alias
				const that = this;
				let dataInCurPacketLen = Math.min(lastColumnReaderLen, this.payloadLength - this.packetOffset);
				const enum IsReading
				{	NO,
					YES,
					YES_BY_END_SESSION,
				}
				let isReading = IsReading.NO;
				let anotherBuffer: Uint8Array|undefined; // ReadableStream shamelessly transfers buffers back and forth, so i'm forced to create anotherBuffer, and to copy bytes again after they're copied to their main buffer
				const reader =
				{	async read(dest: Uint8Array)
					{	if (isReading != IsReading.NO)
						{	if (isReading==IsReading.YES && that.#onEndSession)
							{	isReading = IsReading.YES_BY_END_SESSION;
								return null; // assume: `session[Symbol.dispose]()` called me (maybe in parallel with user's reader)
							}
							throw new BusyError('Data is being read by another reader');
						}
						isReading = that.#onEndSession ? IsReading.YES_BY_END_SESSION : IsReading.YES;
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
									await that.#doDiscard(ProtocolState.HAS_MORE_ROWS);
									debugAssert(!that.#curResultsets);
									// done
									that.#curLastColumnReader = undefined;
									that.#setState(ProtocolState.IDLE);
									if (that.#onEndSession)
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
								if (!anotherBuffer || anotherBuffer.length<n)
								{	anotherBuffer = new Uint8Array(n);
								}
								const data = await that.readBytesToBuffer(anotherBuffer.subarray(0, n));
								anotherBuffer = new Uint8Array(data.buffer);
								dest.set(data);
								dataInCurPacketLen -= n;
								lastColumnReaderLen -= n;
								if (!that.#onEndSession)
								{	break;
								}
							}
						}
						catch (e)
						{	that.#rethrowError(e);
						}
						finally
						{	isReading = IsReading.NO;
						}
						return n;
					}
				};
				const value = rowType==RowType.LAST_COLUMN_READER ? reader : new RdStream(reader);
				const columnName = columns[columns.length - 1].name;
				row[columnName] = value;
				this.#curLastColumnReader = value;
			}
			else
			{	this.#setState(ProtocolState.HAS_MORE_ROWS);
			}
			return row;
		}
		catch (e)
		{	this.#rethrowError(e);
		}
	}

	/**	If `onlyRows` is false returns `ProtocolState.IDLE`. Else can also return `ProtocolState.HAS_MORE_RESULTSETS`.
	 **/
	async #doDiscard(state: ProtocolState, onlyRows=false)
	{	const curResultsets = this.#curResultsets;
		debugAssert(curResultsets);
		const {isPreparedStmt, stmtId} = curResultsets;
		const mode = isPreparedStmt ? ReadPacketMode.ROWS_OR_PREPARED_STMT : ReadPacketMode.REGULAR;
		const okType = isPreparedStmt ? PacketType.EOF : PacketType.OK;
		while (true)
		{	if (state == ProtocolState.HAS_MORE_ROWS)
			{	while (true)
				{	const type = await this.#readPacket(mode);
					this.gotoEndOfPacket() || await this.gotoEndOfPacketAsync();
					if (type == okType)
					{	state = this.statusFlags & StatusFlags.SERVER_MORE_RESULTS_EXISTS ? ProtocolState.HAS_MORE_RESULTSETS : ProtocolState.IDLE;
						break;
					}
				}
			}
			if (!onlyRows && state==ProtocolState.HAS_MORE_RESULTSETS)
			{	state = await this.#readQueryResponse(curResultsets, mode);
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
			this.#curResultsets = undefined;
		}
		return state;
	}

	async nextResultset(ignoreTerminated=false)
	{	let state = this.#state;
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
			{	this.#state = ProtocolState.QUERYING;
				state = await this.#doDiscard(state, true);
			}
			let yes = false;
			if (state == ProtocolState.HAS_MORE_RESULTSETS)
			{	yes = true;
				this.#state = ProtocolState.QUERYING;
				const curResultsets = this.#curResultsets;
				debugAssert(curResultsets?.hasMoreInternal);
				const {isPreparedStmt, stmtId} = curResultsets;
				curResultsets.resetFields();
				state = await this.#readQueryResponse(curResultsets, isPreparedStmt ? ReadPacketMode.ROWS_OR_PREPARED_STMT : ReadPacketMode.REGULAR);
				if (state == ProtocolState.IDLE)
				{	if (stmtId < 0)
					{	curResultsets.protocol = undefined;
					}
					curResultsets.hasMoreInternal = false;
					this.#curResultsets = undefined;
				}
			}
			this.#setState(state);
			return yes;
		}
		catch (e)
		{	this.#rethrowError(e);
		}
	}

	/**	Finalize session (skip unread resultsets, and execute COM_RESET_CONNECTION), then if the connection is alive, reinitialize it (set dsn.schema and execute dsn.initSql).
		If the connection was alive, and `recycleConnection` was true, returns new `MyProtocol` object with the same `Deno.Conn` to the database, and current object marks as terminated (method calls will throw `CanceledError`).
		If the connection was dead, returns Uint8Array buffer to be recycled.
		This function doesn't throw errors (errors can be considered fatal).
	 **/
	async end(rollbackPreparedXaId='', recycleConnection=false, withDisposeSqlLogger=false)
	{	let state = this.#state;
		if (state != ProtocolState.TERMINATED)
		{	this.#state = ProtocolState.TERMINATED;
			if (state == ProtocolState.QUERYING)
			{	debugAssert(this.#curLastColumnReader);
				const promise = new Promise<ProtocolState>(y => {this.#onEndSession = y});
				try
				{	if (this.#curLastColumnReader instanceof RdStream)
					{	await this.#curLastColumnReader.cancel();
					}
					else
					{	while (true)
						{	if (!await this.#curLastColumnReader?.read(BUFFER_FOR_END_SESSION))
							{	break;
							}
						}
					}
				}
				catch (e)
				{	if (!(e instanceof CanceledError))
					{	this.logger.error(e);
					}
				}
				state = await promise;
				debugAssert(!this.#curLastColumnReader);
				this.#onEndSession = undefined;
			}
			const curResultsets = this.#curResultsets;
			if (curResultsets)
			{	debugAssert(state==ProtocolState.HAS_MORE_ROWS || state==ProtocolState.HAS_MORE_RESULTSETS);
				try
				{	debugAssert(curResultsets.hasMoreInternal);
					state = await this.#doDiscard(state);
					debugAssert(!curResultsets.hasMoreInternal && (!curResultsets.protocol || curResultsets.stmtId>=0));
					curResultsets.hasMoreInternal = true; // mark this resultset as cancelled (hasMoreProtocol && !protocol)
				}
				catch (e)
				{	this.logger.error(e);
					recycleConnection = false;
					this.#curResultsets = undefined;
				}
				debugAssert(!this.#curResultsets);
			}
			if (rollbackPreparedXaId)
			{	try
				{	await this.sendComQuery(`XA END '${rollbackPreparedXaId}'`);
				}
				catch
				{	// ok
				}
				try
				{	await this.sendComQuery(`XA ROLLBACK '${rollbackPreparedXaId}'`, RowType.VOID, false, MultiStatements.NO_MATTER, true);
				}
				catch (e)
				{	if (!(e instanceof SqlError && e.errorCode==ErrorCodes.ER_XAER_NOTA)) // maybe already rolled back
					{	this.logger.error(e);
					}
				}
			}
			this.#curLastColumnReader = undefined;
			this.#onEndSession = undefined;
			if (recycleConnection && (state==ProtocolState.IDLE || state==ProtocolState.IDLE_IN_POOL))
			{	// recycle connection
				const protocol = new MyProtocol(this.writer, this.reader, this.#closer, this.decoder, this.recycleBuffer(), this.dsn, this.logger);
				protocol.useTill = this.useTill;
				protocol.useNTimes = this.useNTimes;
				protocol.serverVersion = this.serverVersion;
				protocol.connectionId = this.connectionId;
				protocol.capabilityFlags = this.capabilityFlags;
				protocol.#maxColumnLen = this.#maxColumnLen;
				protocol.#curMultiStatements = this.#curMultiStatements;
				protocol.#retryQueryTimes = this.#retryQueryTimes;
				protocol.#onLoadFile = this.#onLoadFile;
				try
				{	if (this.#sqlLogger)
					{	await this.#sqlLogger.resetConnection(this.connectionId);
						if (withDisposeSqlLogger)
						{	await this.#sqlLogger.dispose();
						}
					}
					if (await protocol.#sendComResetConnectionAndInitDb(this.dsn.schema))
					{	if (this.dsn.initSql)
						{	await protocol.sendComQuery(this.dsn.initSql, RowType.VOID, false, SetOption.MULTI_STATEMENTS_ON);
						}
						debugAssert(protocol.#state == ProtocolState.IDLE);
						protocol.#state = ProtocolState.IDLE_IN_POOL;
						return protocol;
					}
				}
				catch (e)
				{	this.logger.error(`Connection not recycled: ${e}`);
				}
				this.buffer = protocol.buffer; // revert `this.recycleBuffer()`
			}
			// don't recycle connection (only buffer)
			if (state!=ProtocolState.ERROR && state!=ProtocolState.TERMINATED)
			{	try
				{	await this.#sendComQuit();
				}
				catch (e)
				{	this.logger.error(e);
				}
				try
				{	this.reader.releaseLock();
				}
				catch (e)
				{	this.logger.error(e);
				}
				try
				{	this.writer.releaseLock();
				}
				catch (e)
				{	this.logger.error(e);
				}
				try
				{	this.#closer[Symbol.dispose]();
				}
				catch (e)
				{	this.logger.error(e);
				}
			}
			if (this.#sqlLogger)
			{	await this.#sqlLogger.disconnect(this.connectionId);
				if (withDisposeSqlLogger)
				{	await this.#sqlLogger.dispose();
				}
			}
		}
		return this.recycleBuffer();
	}

	/**	@returns Returns `true` if there was ongoing query. In this case probably you need to reconnect and KILL it.
	 **/
	forceImmediateDisconnect()
	{	const state = this.#state;
		if (state!=ProtocolState.ERROR && state!=ProtocolState.TERMINATED)
		{	try
			{	this.#closer[Symbol.dispose]();
			}
			catch (e)
			{	this.logger.error(e);
			}
			this.#state = ProtocolState.ERROR;
		}
		return state == ProtocolState.QUERYING;
	}
}
