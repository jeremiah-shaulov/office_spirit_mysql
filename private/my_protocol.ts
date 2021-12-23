import {debugAssert} from './debug_assert.ts';
import {reallocAppend} from './realloc_append.ts';
import {CapabilityFlags, PacketType, StatusFlags, SessionTrack, Command, Charset, CursorType, FieldType, ColumnFlags} from './constants.ts';
import {BusyError, CanceledError, SqlError} from './errors.ts';
import {Dsn} from './dsn.ts';
import {AuthPlugin} from './auth_plugins.ts';
import {MyProtocolReaderWriter, SqlSource} from './my_protocol_reader_writer.ts';
import {Column, ResultsetsProtocol} from './resultsets.ts';
import type {Param, ColumnValue} from './resultsets.ts';
import {convColumnValue} from './conv_column_value.ts';

const DEFAULT_MAX_COLUMN_LEN = 10*1024*1024;
const DEFAULT_CHARACTER_SET_CLIENT = Charset.UTF8_UNICODE_CI;
const DEFAULT_TEXT_DECODER = new TextDecoder('utf-8');

const BUFFER_FOR_END_SESSION = new Uint8Array(4096);

export const enum ReadPacketMode
{	REGULAR,
	PREPARED_STMT,
	PREPARED_STMT_OK_CONTINUATION,
}

export const enum RowType
{	MAP,
	OBJECT,
	ARRAY,
	FIRST_COLUMN,
	LAST_COLUMN_READER,
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

// deno-lint-ignore no-explicit-any
type Any = any;

export class MyProtocol extends MyProtocolReaderWriter
{	serverVersion = '';
	connectionId = 0;
	capabilityFlags = 0;
	statusFlags = 0;
	schema = '';

	// for connections pool:
	useTill = Number.MAX_SAFE_INTEGER; // if keepAliveTimeout specified
	useNTimes = Number.MAX_SAFE_INTEGER; // if keepAliveMax specified

	private warnings = 0;
	private affectedRows: number|bigint = 0;
	private lastInsertId: number|bigint = 0;
	private statusInfo = '';

	private state = ProtocolState.IDLE;
	private initSchema = '';
	private initSql = '';
	private maxColumnLen = DEFAULT_MAX_COLUMN_LEN;
	private onloadfile?: (filename: string) => Promise<(Deno.Reader & Deno.Closer) | undefined>;

	private curResultsets: ResultsetsProtocol<unknown> | undefined;
	private pendingCloseStmts: number[] = [];
	private curLastColumnReader: Deno.Reader | undefined;
	private onEndSession: ((state: ProtocolState) => void) | undefined;

	static async inst
	(	dsn: Dsn,
		useBuffer?: Uint8Array,
		onloadfile?: (filename: string) => Promise<(Deno.Reader & Deno.Closer) | undefined>,
	): Promise<MyProtocol>
	{	const {addr, initSql, maxColumnLen, username, password, schema, foundRows, ignoreSpace, multiStatements} = dsn;
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
		const protocol = new MyProtocol(conn, DEFAULT_TEXT_DECODER, useBuffer);
		protocol.initSchema = schema;
		protocol.initSql = initSql;
		if (maxColumnLen > 0)
		{	protocol.maxColumnLen = maxColumnLen;
		}
		protocol.onloadfile = onloadfile;
		try
		{	const authPlugin = await protocol.readHandshake();
			await protocol.writeHandshakeResponse(username, password, schema, authPlugin, foundRows, ignoreSpace, multiStatements);
			const authPlugin2 = await protocol.readAuthResponse(password, authPlugin);
			if (authPlugin2)
			{	await protocol.writeAuthSwitchResponse(password, authPlugin2);
				await protocol.readAuthResponse(password, authPlugin2);
			}
			if (initSql)
			{	const resultsets = await protocol.sendComQuery(initSql, RowType.FIRST_COLUMN);
				await resultsets!.discard();
			}
			return protocol;
		}
		catch (e)
		{	try
			{	conn.close();
			}
			catch (e2)
			{	console.error(e2);
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
				this.gotoEndOfPacket() || await this.gotoEndOfPacketAsync();
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
				this.gotoEndOfPacket() || await this.gotoEndOfPacketAsync();
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

	private initResultsets(resultsets: ResultsetsProtocol<unknown>)
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

	private async readQueryResponse(resultsets: ResultsetsProtocol<unknown>, mode: ReadPacketMode, skipColumns=false)
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
					this.gotoEndOfPacket() || await this.gotoEndOfPacketAsync();
					if (!this.onloadfile)
					{	throw new Error(`LOCAL INFILE handler is not set. Requested file: ${filename}`);
					}
					const reader = await this.onloadfile(filename);
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
						{	console.error(e);
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
			{	console.error(e);
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
			{	console.error(e);
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

	/**	I assume that i'm in ProtocolState.IDLE.
	 **/
	private async sendComResetConnectionAndInitDb(schema: string)
	{	this.startWritingNewPacket(true);
		this.writeUint8(Command.COM_RESET_CONNECTION);
		if (schema)
		{	this.startWritingNextPacket(true);
			this.writeUint8(Command.COM_INIT_DB);
			this.writeString(schema);
		}
		await this.send();
		try
		{	await this.readPacket();
		}
		catch (e)
		{	if ((e instanceof SqlError) && e.message=='Unknown command')
			{	console.error(`Couldn't reset connection state. This is only supported on MySQL 5.7+ and MariaDB 10.2+`, e); // TODO: report about this error in better way
			}
			else
			{	throw e;
			}
		}
		if (schema)
		{	await this.readPacket();
		}
	}

	/**	I assume that i'm in ProtocolState.IDLE.
	 **/
	private sendComStmtClose(stmtId: number)
	{	this.startWritingNewPacket(true);
		this.writeUint8(Command.COM_STMT_CLOSE);
		this.writeUint32(stmtId);
		return this.send();
	}

	/**	On success returns ResultsetsProtocol<Row>.
		On error throws exception.
		If `letReturnUndefined` and communication error occured on connection that was just taken form pool, returns undefined.
	 **/
	async sendComQuery<Row>(sql: SqlSource, rowType: RowType, letReturnUndefined=false)
	{	const isFromPool = this.setQueryingState();
		try
		{	this.startWritingNewPacket(true);
			this.writeUint8(Command.COM_QUERY);
			await this.sendWithData(sql, (this.statusFlags & StatusFlags.SERVER_STATUS_NO_BACKSLASH_ESCAPES) != 0);
			const resultsets = new ResultsetsProtocol<Row>(rowType);
			const state = await this.readQueryResponse(resultsets, ReadPacketMode.REGULAR);
			if (state != ProtocolState.IDLE)
			{	resultsets.protocol = this;
				resultsets.hasMoreProtocol = true;
				this.curResultsets = resultsets;
			}
			else if (this.pendingCloseStmts.length != 0)
			{	await this.doPending();
			}
			this.setState(state);
			return resultsets;
		}
		catch (e)
		{	this.rethrowErrorIfFatal(e, isFromPool && letReturnUndefined);
		}
	}

	/**	On success returns ResultsetsProtocol<Row>.
		On error throws exception.
		If `letReturnUndefined` and communication error occured on connection that was just taken form pool, returns undefined.
	 **/
	async sendComStmtPrepare<Row>(sql: SqlSource, putParamsTo: Any[]|undefined, rowType: RowType, letReturnUndefined=false, skipColumns=false)
	{	const isFromPool = this.setQueryingState();
		try
		{	this.startWritingNewPacket(true);
			this.writeUint8(Command.COM_STMT_PREPARE);
			await this.sendWithData(sql, (this.statusFlags & StatusFlags.SERVER_STATUS_NO_BACKSLASH_ESCAPES) != 0, false, putParamsTo);
			const resultsets = new ResultsetsProtocol<Row>(rowType);
			await this.readQueryResponse(resultsets, ReadPacketMode.PREPARED_STMT, skipColumns);
			resultsets.protocol = this;
			if (this.pendingCloseStmts.length != 0)
			{	await this.doPending();
			}
			this.setState(ProtocolState.IDLE);
			return resultsets;
		}
		catch (e)
		{	this.rethrowErrorIfFatal(e, isFromPool && letReturnUndefined);
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
				{	console.error(e);
				}
			}
		}
		else if (state!=ProtocolState.ERROR && state!=ProtocolState.TERMINATED)
		{	this.pendingCloseStmts.push(stmtId);
		}
	}

	async sendComStmtExecute(resultsets: ResultsetsProtocol<unknown>, params: Param[])
	{	this.setQueryingState();
		const {isPreparedStmt, stmtId, nPlaceholders} = resultsets;
		if (stmtId < 0)
		{	throw new SqlError(isPreparedStmt ? 'This prepared statement disposed' : 'Not a prepared statement');
		}
		debugAssert(!resultsets.hasMoreProtocol); // because setQueryingState() ensures that current resultset is read to the end
		try
		{	const maxExpectedPacketSizeIncludingHeader = 15 + nPlaceholders*16; // packet header (4-byte) + COM_STMT_EXECUTE (1-byte) + stmt_id (4-byte) + NO_CURSOR (1-byte) + iteration_count (4-byte) + new_params_bound_flag (1-byte) = 15; each placeholder can be Date (max 12 bytes) + param type (2-byte) + null mask (1-bit) <= 15
			let extraSpaceForParams = Math.max(0, this.buffer.length - maxExpectedPacketSizeIncludingHeader);
			let packetStart = 0;
			const placeholdersSent = new Set<number>();
			// First send COM_STMT_SEND_LONG_DATA params, as they must be sent before COM_STMT_EXECUTE
			for (let i=0; i<nPlaceholders; i++)
			{	const param = params[i];
				if (param!=null && typeof(param)!='function' && typeof(param)!='symbol') // if is not NULL
				{	if (typeof(param) == 'string')
					{	const maxByteLen = param.length * 4;
						if (maxByteLen > extraSpaceForParams)
						{	this.startWritingNewPacket(true, packetStart);
							this.writeUint8(Command.COM_STMT_SEND_LONG_DATA);
							this.writeUint32(stmtId);
							this.writeUint16(i);
							packetStart = await this.sendWithData(param, false, true);
							placeholdersSent.add(i);
						}
						else
						{	extraSpaceForParams -= maxByteLen;
						}
					}
					else if (typeof(param) == 'object')
					{	if (param instanceof Uint8Array)
						{	if (param.byteLength > extraSpaceForParams)
							{	this.startWritingNewPacket(true, packetStart);
								this.writeUint8(Command.COM_STMT_SEND_LONG_DATA);
								this.writeUint32(stmtId);
								this.writeUint16(i);
								packetStart = await this.sendWithData(param, false, true);
								placeholdersSent.add(i);
							}
							else
							{	extraSpaceForParams -= param.byteLength;
							}
						}
						else if (param.buffer instanceof ArrayBuffer)
						{	if (param.byteLength > extraSpaceForParams)
							{	this.startWritingNewPacket(true, packetStart);
								this.writeUint8(Command.COM_STMT_SEND_LONG_DATA);
								this.writeUint32(stmtId);
								this.writeUint16(i);
								packetStart = await this.sendWithData(new Uint8Array(param.buffer, param.byteOffset, param.byteLength), false, true);
								placeholdersSent.add(i);
							}
							else
							{	extraSpaceForParams -= param.byteLength;
							}
						}
						else if (typeof(param.read) == 'function')
						{	let isEmpty = true;
							while (true)
							{	this.startWritingNewPacket(isEmpty, packetStart);
								this.writeUint8(Command.COM_STMT_SEND_LONG_DATA);
								this.writeUint32(stmtId);
								this.writeUint16(i);
								const n = await this.writeReadChunk(param);
								if (n == null)
								{	this.discardPacket();
									break;
								}
								await this.send();
								packetStart = 0;
								isEmpty = false;
							}
							if (!isEmpty)
							{	placeholdersSent.add(i);
							}
						}
						else if (!(param instanceof Date))
						{	this.startWritingNewPacket(true, packetStart);
							this.writeUint8(Command.COM_STMT_SEND_LONG_DATA);
							this.writeUint32(stmtId);
							this.writeUint16(i);
							packetStart = await this.sendWithData(JSON.stringify(param), false, true);
							placeholdersSent.add(i);
						}
					}
				}
			}
			// Flush, if not enuogh space in buffer for the placeholders packet
			if (packetStart > 0 && packetStart + maxExpectedPacketSizeIncludingHeader > this.buffer.length)
			{	await this.send();
				packetStart = 0;
			}
			// Send params in binary protocol
			this.startWritingNewPacket(true, packetStart);
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
				{	this.writeUint8(nullBits);
				}
				this.writeUint8(1); // new_params_bound_flag
				// Send type of each param
				let paramsLen = 0;
				for (let i=0; i<nPlaceholders; i++)
				{	const param = params[i];
					let type = FieldType.MYSQL_TYPE_STRING;
					if (param!=null && typeof(param)!='function' && typeof(param)!='symbol') // if is not NULL
					{	if (typeof(param) == 'boolean')
						{	type = FieldType.MYSQL_TYPE_TINY;
							paramsLen++;
						}
						else if (typeof(param) == 'number')
						{	if (Number.isInteger(param) && param>=-0x8000_0000 && param<=0x7FFF_FFFF)
							{	type = FieldType.MYSQL_TYPE_LONG;
								paramsLen += 4;
							}
							else
							{	type = FieldType.MYSQL_TYPE_DOUBLE;
								paramsLen+= 8;
							}
						}
						else if (typeof(param) == 'bigint')
						{	type = FieldType.MYSQL_TYPE_LONGLONG;
							paramsLen += 8;
						}
						else if (typeof(param) == 'object')
						{	if (param instanceof Date)
							{	type = FieldType.MYSQL_TYPE_DATETIME;
								paramsLen += 12;
							}
							else if (param.buffer instanceof ArrayBuffer)
							{	type = FieldType.MYSQL_TYPE_LONG_BLOB;
								paramsLen += param.byteLength;
							}
							else if (typeof(param.read) == 'function')
							{	type = FieldType.MYSQL_TYPE_LONG_BLOB;
								paramsLen++;
							}
						}
						else
						{	debugAssert(typeof(param) == 'string');
						}
					}
					this.writeUint16(type);
				}
				// Send value of each param
				this.ensureRoom(paramsLen);
				for (let i=0; i<nPlaceholders; i++)
				{	const param = params[i];
					if (param!=null && typeof(param)!='function' && typeof(param)!='symbol' && !placeholdersSent.has(i)) // if is not NULL and not sent
					{	if (typeof(param) == 'boolean')
						{	this.writeUint8(param ? 1 : 0);
						}
						else if (typeof(param) == 'number')
						{	if (Number.isInteger(param) && param>=-0x8000_0000 && param<=0x7FFF_FFFF)
							{	this.writeUint32(param);
							}
							else
							{	this.writeDouble(param);
							}
						}
						else if (typeof(param) == 'bigint')
						{	this.writeUint64(param);
						}
						else if (typeof(param) == 'string')
						{	this.writeLenencString(param);
						}
						else if (param instanceof Date)
						{	const frac = param.getMilliseconds();
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
						{	this.writeLenencBytes(param);
						}
						else if (param.buffer instanceof ArrayBuffer)
						{	this.writeLenencBytes(new Uint8Array(param.buffer, param.byteOffset, param.byteLength));
						}
						else
						{	debugAssert(typeof(param.read) == 'function');
							// nothing written for this param (as it's not in placeholdersSent), so write empty string
							this.writeUint8(0); // 0-length lenenc-string
						}
					}
				}
			}
			await this.send();
			// Read Binary Protocol Resultset
			const type = await this.readPacket(ReadPacketMode.PREPARED_STMT); // throw if ERR packet
			this.unput(type);
			let rowNColumns = this.readLenencInt() ?? await this.readLenencIntAsync();
			if (rowNColumns > Number.MAX_SAFE_INTEGER) // want cast bigint -> number
			{	throw new Error(`Can't handle so many columns: ${rowNColumns}`);
			}
			rowNColumns = Number(rowNColumns);
			if (rowNColumns > 0)
			{	resultsets.columns = await this.readColumnDefinitionPackets(rowNColumns);
				resultsets.protocol = this;
				resultsets.hasMoreProtocol = true;
				this.curResultsets = resultsets;
				this.setState(ProtocolState.HAS_MORE_ROWS);
			}
			else if (this.statusFlags & StatusFlags.SERVER_MORE_RESULTS_EXISTS)
			{	resultsets.protocol = this;
				resultsets.hasMoreProtocol = true;
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
		}
		catch (e)
		{	this.rethrowError(e);
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
		debugAssert(this.curResultsets?.hasMoreProtocol); // because we're in ProtocolState.HAS_MORE_ROWS
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
					curResultsets.hasMoreProtocol = false;
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
			{	case RowType.ARRAY:
					row = [];
					break;
				case RowType.OBJECT:
				case RowType.LAST_COLUMN_READER:
					row = {};
					break;
				case RowType.MAP:
					row = new Map;
					break;
				default:
					debugAssert(rowType == RowType.FIRST_COLUMN);
			}
			let lastColumnReaderLen = 0;
			if (!isPreparedStmt)
			{	// Text protocol row
				this.unput(type);
				for (let i=0; i<nColumns; i++)
				{	const {type, flags, name} = columns[i];
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
						else if (len > this.maxColumnLen)
						{	this.readVoid(len) || this.readVoidAsync(len);
						}
						else if (len <= this.buffer.length)
						{	const v = this.readShortBytes(len) ?? await this.readShortBytesAsync(len);
							value = convColumnValue(v, type, flags, this.decoder);
						}
						else
						{	if (!buffer || buffer.length<len)
							{	buffer = new Uint8Array(len);
							}
							const v = buffer.subarray(0, len);
							await this.readBytesToBuffer(v);
							value = convColumnValue(v, type, flags, this.decoder);
						}
					}
					switch (rowType)
					{	case RowType.ARRAY:
							row[i] = value;
							break;
						case RowType.OBJECT:
						case RowType.LAST_COLUMN_READER:
							row[name] = value;
							break;
						case RowType.MAP:
							row.set(name, value);
							break;
						default:
							debugAssert(rowType == RowType.FIRST_COLUMN);
							if (i == 0)
							{	row = value;
							}
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
					const {type, flags, name} = columns[i];
					if (!isNull)
					{	switch (type)
						{	case FieldType.MYSQL_TYPE_TINY:
								if (flags & ColumnFlags.UNSIGNED)
								{	value = this.readUint8() ?? await this.readUint8Async();
								}
								else
								{	value = this.readInt8() ?? await this.readInt8Async();
								}
								break;
							case FieldType.MYSQL_TYPE_SHORT:
							case FieldType.MYSQL_TYPE_YEAR:
								if (flags & ColumnFlags.UNSIGNED)
								{	value = this.readUint16() ?? await this.readUint16Async();
								}
								else
								{	value = this.readInt16() ?? await this.readInt16Async();
								}
								break;
							case FieldType.MYSQL_TYPE_INT24:
							case FieldType.MYSQL_TYPE_LONG:
								if (flags & ColumnFlags.UNSIGNED)
								{	value = this.readUint32() ?? await this.readUint32Async();
								}
								else
								{	value = this.readInt32() ?? await this.readInt32Async();
								}
								break;
							case FieldType.MYSQL_TYPE_LONGLONG:
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
							case FieldType.MYSQL_TYPE_FLOAT:
								value = this.readFloat() ?? await this.readFloatAsync();
								break;
							case FieldType.MYSQL_TYPE_DOUBLE:
								value = this.readDouble() ?? await this.readDoubleAsync();
								break;
							case FieldType.MYSQL_TYPE_DATE:
							case FieldType.MYSQL_TYPE_DATETIME:
							case FieldType.MYSQL_TYPE_TIMESTAMP:
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
							case FieldType.MYSQL_TYPE_TIME:
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
							case FieldType.MYSQL_TYPE_BIT:
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
								else if (len > this.maxColumnLen)
								{	this.readVoid(len) || this.readVoidAsync(len);
								}
								else if ((flags & ColumnFlags.BINARY) && type != FieldType.MYSQL_TYPE_JSON)
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
									if (type == FieldType.MYSQL_TYPE_JSON)
									{	value = JSON.parse(value);
									}
								}
							}
						}
					}
					switch (rowType)
					{	case RowType.ARRAY:
							row[i] = value;
							break;
						case RowType.OBJECT:
						case RowType.LAST_COLUMN_READER:
							row[name] = value;
							break;
						case RowType.MAP:
							row.set(name, value);
							break;
						default:
							debugAssert(rowType == RowType.FIRST_COLUMN);
							if (i == 0)
							{	row = value;
							}
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
			curResultsets.hasMoreProtocol = false;
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
				debugAssert(curResultsets?.hasMoreProtocol);
				const {isPreparedStmt, stmtId} = curResultsets;
				curResultsets.resetFields();
				state = await this.readQueryResponse(curResultsets, isPreparedStmt ? ReadPacketMode.PREPARED_STMT : ReadPacketMode.REGULAR);
				if (state == ProtocolState.IDLE)
				{	if (stmtId < 0)
					{	curResultsets.protocol = undefined;
					}
					curResultsets.hasMoreProtocol = false;
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
	async end(recycleConnection=false)
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
					{	console.error(e);
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
				{	debugAssert(curResultsets.hasMoreProtocol);
					state = await this.doDiscard(state);
					debugAssert(!curResultsets.hasMoreProtocol && !curResultsets.protocol);
					curResultsets.hasMoreProtocol = true; // mark this resultset as cancelled (hasMoreProtocol && !protocol)
				}
				catch (e)
				{	console.error(e);
					recycleConnection = false;
					this.curResultsets = undefined;
				}
				debugAssert(!this.curResultsets);
			}
			this.curLastColumnReader = undefined;
			this.onEndSession = undefined;
			const buffer = this.recycleBuffer();
			if (!recycleConnection || state!=ProtocolState.IDLE && state!=ProtocolState.IDLE_IN_POOL)
			{	// don't recycle connection (only buffer)
				if (state!=ProtocolState.ERROR && state!=ProtocolState.TERMINATED)
				{	try
					{	this.conn.close();
					}
					catch (e)
					{	console.error(e);
					}
				}
				return buffer;
			}
			else
			{	// recycle connection
				const protocol = new MyProtocol(this.conn, this.decoder, buffer);
				protocol.serverVersion = this.serverVersion;
				protocol.connectionId = this.connectionId;
				protocol.capabilityFlags = this.capabilityFlags;
				protocol.initSchema = this.initSchema;
				protocol.initSql = this.initSql;
				protocol.maxColumnLen = this.maxColumnLen;
				protocol.onloadfile = this.onloadfile;
				const {initSchema, initSql} = this;
				await protocol.sendComResetConnectionAndInitDb(initSchema);
				if (initSql)
				{	const resultsets = await protocol.sendComQuery(initSql, RowType.FIRST_COLUMN);
					await resultsets!.discard();
				}
				debugAssert(protocol.state == ProtocolState.IDLE);
				protocol.state = ProtocolState.IDLE_IN_POOL;
				return protocol;
			}
		}
	}
}
