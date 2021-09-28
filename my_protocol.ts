import {debugAssert} from './debug_assert.ts';
import {reallocAppend} from './realloc_append.ts';
import {CapabilityFlags, PacketType, StatusFlags, SessionTrack, Command, Charset, CursorType, FieldType} from './constants.ts';
import {SqlError} from './errors.ts';
import {Dsn} from './dsn.ts';
import {AuthPlugin} from './auth_plugins.ts';
import {MyProtocolReaderWriter, SqlSource} from './my_protocol_reader_writer.ts';
import {Column, ResultsetsDriver} from './resultsets.ts';
import type {Param, ColumnValue} from './resultsets.ts';
import {convColumnValue} from './conv_column_value.ts';

const DEFAULT_MAX_COLUMN_LEN = 10*1024*1024;
const DEFAULT_CHARACTER_SET_CLIENT = Charset.UTF8_UNICODE_CI;
const DEFAULT_TEXT_DECODER = new TextDecoder('utf-8');

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

// deno-lint-ignore no-explicit-any
type Any = any;

export class MyProtocol extends MyProtocolReaderWriter
{	serverVersion = '';
	connectionId = 0;
	capabilityFlags = 0;
	statusFlags = 0;
	schema = '';
	isBrokenConnection = false; // set on i/o error

	// for connections pool:
	useTill = Number.MAX_SAFE_INTEGER; // if keepAliveTimeout specified
	useNTimes = Number.MAX_SAFE_INTEGER; // if keepAliveMax specified

	private warnings = 0;
	private affectedRows: number|bigint = 0;
	private lastInsertId: number|bigint = 0;
	private statusInfo = '';

	private maxColumnLen = DEFAULT_MAX_COLUMN_LEN;
	private onloadfile?: (filename: string) => Promise<(Deno.Reader & Deno.Closer) | undefined>;

	static async inst
	(	dsn: Dsn,
		useBuffer?: Uint8Array,
		onloadfile?: (filename: string) => Promise<(Deno.Reader & Deno.Closer) | undefined>,
	): Promise<MyProtocol>
	{	const conn = await Deno.connect(dsn.addr);
		const protocol = new MyProtocol(conn, DEFAULT_TEXT_DECODER, useBuffer);
		if (dsn.maxColumnLen > 0)
		{	protocol.maxColumnLen = dsn.maxColumnLen;
		}
		protocol.onloadfile = onloadfile;
		try
		{	const authPlugin = await protocol.readHandshake();
			const {username, password, schema} = dsn;
			await protocol.writeHandshakeResponse(username, password, schema, authPlugin, dsn.foundRows, dsn.ignoreSpace, dsn.multiStatements);
			const authPlugin2 = await protocol.readAuthResponse(password, authPlugin);
			if (authPlugin2)
			{	await protocol.writeAuthSwitchResponse(password, authPlugin2);
				await protocol.readAuthResponse(password, authPlugin2);
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
	private writeHandshakeResponse(username: string, password: string, schema: string, authPlugin: AuthPlugin, foundRows: boolean, ignoreSpace: boolean, multiStatements: boolean)
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
			{	const auth = authPlugin.quickAuth(password);
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
			const auth = !password ? new Uint8Array : authPlugin.quickAuth(password);
			if (this.capabilityFlags & CapabilityFlags.CLIENT_CONNECT_WITH_DB)
			{	this.writeNulBytes(auth);
				this.writeNulString(schema);
			}
			else
			{	this.writeBytes(auth);
			}
		}
		return this.send();
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
	private writeAuthSwitchResponse(password: string, authPlugin: AuthPlugin)
	{	this.startWritingNewPacket();
		if (password)
		{	const auth = authPlugin.quickAuth(password);
			this.writeBytes(auth);
		}
		return this.send();
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
						}
						else
						{	this.statusInfo = this.readShortEofString() ?? await this.readShortEofStringAsync();
						}
					}
					this.gotoEndOfPacket() || await this.gotoEndOfPacketAsync();
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

	sendUint8Packet(value: number)
	{	this.startWritingNewPacket();
		this.writeUint8(value);
		return this.send();
	}

	sendBytesPacket(value: Uint8Array)
	{	this.startWritingNewPacket();
		this.writeBytes(value);
		return this.send();
	}

	private initResultsets(resultsets: ResultsetsDriver<unknown>)
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

	private async readQueryResponse(resultsets: ResultsetsDriver<unknown>, mode: ReadPacketMode)
	{	debugAssert(mode==ReadPacketMode.REGULAR || mode==ReadPacketMode.PREPARED_STMT);
		debugAssert(resultsets.stmtId == -1);
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
					{	resultsets.stmtId = this.readUint32() ?? await this.readUint32Async();
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
			await this.skipColumnDefinitionPackets(nPlaceholders);
			const columns = nColumnsNum==0 ? [] : await this.readColumnDefinitionPackets(nColumnsNum);

			resultsets.nPlaceholders = nPlaceholders;
			resultsets.columns = columns;
			resultsets.hasMoreRows = mode==ReadPacketMode.REGULAR && nColumnsNum!=0;
			resultsets.hasMoreSomething = mode==ReadPacketMode.REGULAR && (nColumnsNum != 0 || (this.statusFlags & StatusFlags.SERVER_MORE_RESULTS_EXISTS) != 0);

			if (!resultsets.hasMoreSomething)
			{	resultsets.fetch = () => Promise.resolve(undefined); // eof
				resultsets.gotoNextResultset = () => Promise.resolve(false);
			}
			break;
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

	private async skipColumnDefinitionPackets(nPackets: number)
	{	if (nPackets > 0)
		{	for (let i=0; i<nPackets; i++)
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
	}

	sendComResetConnection()
	{	this.startWritingNewPacket(true);
		this.writeUint8(Command.COM_RESET_CONNECTION);
		return this.send();
	}

	sendComQuery(sql: SqlSource)
	{	this.startWritingNewPacket(true);
		this.writeUint8(Command.COM_QUERY);
		return this.sendWithData(sql, (this.statusFlags & StatusFlags.SERVER_STATUS_NO_BACKSLASH_ESCAPES) != 0);
	}

	sendComStmtPrepare(sql: SqlSource, putParamsTo?: Any[])
	{	this.startWritingNewPacket(true);
		this.writeUint8(Command.COM_STMT_PREPARE);
		return this.sendWithData(sql, (this.statusFlags & StatusFlags.SERVER_STATUS_NO_BACKSLASH_ESCAPES) != 0, false, putParamsTo);
	}

	readComQueryResponse(resultsets: ResultsetsDriver<unknown>)
	{	return this.readQueryResponse(resultsets, ReadPacketMode.REGULAR);
	}

	readComStmtPrepareResponse(resultsets: ResultsetsDriver<unknown>)
	{	return this.readQueryResponse(resultsets, ReadPacketMode.PREPARED_STMT);
	}

	sendComStmtClose(stmtId: number)
	{	this.startWritingNewPacket(true);
		this.writeUint8(Command.COM_STMT_CLOSE);
		this.writeUint32(stmtId);
		return this.send();
	}

	async sendComStmtExecute(resultsets: ResultsetsDriver<unknown>, params: Param[])
	{	const {stmtId, nPlaceholders} = resultsets;
		const maxExpectedPacketSizeIncludingHeader = 15 + nPlaceholders*16; // packet header (4-byte) + COM_STMT_EXECUTE (1-byte) + stmt_id (4-byte) + NO_CURSOR (1-byte) + iteration_count (4-byte) + new_params_bound_flag (1-byte) = 15; each placeholder can be Date (max 12 bytes) + param type (2-byte) + null mask (1-bit) <= 15
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
			resultsets.hasMoreRows = true;
			resultsets.hasMoreSomething = true;
		}
		else
		{	resultsets.hasMoreRows = false;
			resultsets.hasMoreSomething = (this.statusFlags & StatusFlags.SERVER_MORE_RESULTS_EXISTS) != 0;
			if (!resultsets.hasMoreSomething)
			{	resultsets.fetch = () => Promise.resolve(undefined); // eof
				resultsets.gotoNextResultset = () => Promise.resolve(false);
			}
			if (!this.isAtEndOfPacket())
			{	await this.readPacket(ReadPacketMode.PREPARED_STMT_OK_CONTINUATION);
				this.initResultsets(resultsets);
			}
		}
	}

	async fetch<Row>(resultsets: ResultsetsDriver<Row>, rowType: RowType, onreadend?: () => Promise<void>): Promise<Row | undefined>
	{	debugAssert(resultsets.hasMoreRows && resultsets.hasMoreSomething);
		const {stmtId, columns} = resultsets;
		const nColumns = columns.length;
		const type = await this.readPacket(stmtId==-1 ? ReadPacketMode.REGULAR : ReadPacketMode.PREPARED_STMT);
		if (type == (stmtId==-1 ? PacketType.OK : PacketType.EOF))
		{	resultsets.hasMoreRows = false;
			resultsets.hasMoreSomething = (this.statusFlags & StatusFlags.SERVER_MORE_RESULTS_EXISTS) != 0;
			if (!resultsets.hasMoreSomething)
			{	resultsets.fetch = () => Promise.resolve(undefined); // eof
				resultsets.gotoNextResultset = () => Promise.resolve(false);
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
		if (stmtId == -1)
		{	// Text protocol row
			this.unput(type);
			for (let i=0; i<nColumns; i++)
			{	let len = this.readLenencInt() ?? await this.readLenencIntAsync();
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
						value = convColumnValue(v, columns[i].type, this.decoder);
					}
					else
					{	if (!buffer || buffer.length<len)
						{	buffer = new Uint8Array(len);
						}
						const v = buffer.subarray(0, len);
						await this.readBytesToBuffer(v);
						value = convColumnValue(v, columns[i].type, this.decoder);
					}
				}
				switch (rowType)
				{	case RowType.ARRAY:
						row[i] = value;
						break;
					case RowType.OBJECT:
					case RowType.LAST_COLUMN_READER:
						row[columns[i].name] = value;
						break;
					case RowType.MAP:
						row.set(columns[i].name, value);
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
				if (!isNull)
				{	switch (columns[i].type)
					{	case FieldType.MYSQL_TYPE_TINY:
							value = this.readUint8() ?? await this.readUint8Async();
							break;
						case FieldType.MYSQL_TYPE_SHORT:
						case FieldType.MYSQL_TYPE_YEAR:
							value = this.readUint16() ?? await this.readUint16Async();
							break;
						case FieldType.MYSQL_TYPE_LONG:
							value = this.readUint32() ?? await this.readUint32Async();
							break;
						case FieldType.MYSQL_TYPE_LONGLONG:
							value = this.readUint64() ?? await this.readUint64Async();
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
							else if (len <= this.buffer.length)
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
						}
					}
				}
				switch (rowType)
				{	case RowType.ARRAY:
						row[i] = value;
						break;
					case RowType.OBJECT:
					case RowType.LAST_COLUMN_READER:
						row[columns[i].name] = value;
						break;
					case RowType.MAP:
						row.set(columns[i].name, value);
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
			const columnName = columns[columns.length - 1].name;
			let dataInCurPacketLen = Math.min(lastColumnReaderLen, this.payloadLength - this.packetOffset);
			row[columnName] =
			{	async read(dest: Uint8Array)
				{	if (lastColumnReaderLen <= 0)
					{	debugAssert(lastColumnReaderLen==0 && dataInCurPacketLen==0);
						if (that.payloadLength == 0xFFFFFF) // packet of 0xFFFFFF length must be followed by one empty packet
						{	that.readPacketHeader() || await that.readPacketHeaderAsync();
							debugAssert((that.payloadLength as Any) == 0);
						}
						await onreadend?.();
						return null;
					}
					if (dataInCurPacketLen <= 0)
					{	debugAssert(dataInCurPacketLen == 0);
						that.readPacketHeader() || await that.readPacketHeaderAsync();
						dataInCurPacketLen = Math.min(lastColumnReaderLen, that.payloadLength - that.packetOffset);
					}
					const n = Math.min(dest.length, dataInCurPacketLen);
					await that.readBytesToBuffer(dest.subarray(0, n));
					dataInCurPacketLen -= n;
					lastColumnReaderLen -= n;
					return n;
				}
			};
		}
		return row;
	}

	async nextResultset(resultsets: ResultsetsDriver<unknown>)
	{	const mode = resultsets.stmtId==-1 ? ReadPacketMode.REGULAR : ReadPacketMode.PREPARED_STMT;
		if (resultsets.hasMoreRows)
		{	while (true)
			{	const type = await this.readPacket(mode);
				this.gotoEndOfPacket() || await this.gotoEndOfPacketAsync();
				if (type == (resultsets.stmtId==-1 ? PacketType.OK : PacketType.EOF))
				{	resultsets.hasMoreRows = false;
					resultsets.hasMoreSomething = (this.statusFlags & StatusFlags.SERVER_MORE_RESULTS_EXISTS) != 0;
					break;
				}
			}
		}
		if (!resultsets.hasMoreSomething)
		{	resultsets.fetch = () => Promise.resolve(undefined); // eof
			resultsets.gotoNextResultset = () => Promise.resolve(false);
		}
		else
		{	resultsets.resetFields();
			await this.readQueryResponse(resultsets, mode);
		}
	}
}
