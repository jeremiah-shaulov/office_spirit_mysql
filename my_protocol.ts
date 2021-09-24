import {debug_assert} from './debug_assert.ts';
import {realloc_append} from './realloc_append.ts';
import {CapabilityFlags, PacketType, StatusFlags, SessionTrack, Command, Charset, CursorType, FieldType} from './constants.ts';
import {SqlError} from './errors.ts';
import {Dsn} from './dsn.ts';
import {AuthPlugin} from './auth_plugins.ts';
import {MyProtocolReaderWriter, SqlSource} from './my_protocol_reader_writer.ts';
import {Column, ResultsetsDriver} from './resultsets.ts';
import type {Param, ColumnValue} from './resultsets.ts';
import {conv_column_value} from './conv_column_value.ts';

const DEFAULT_MAX_COLUMN_LEN = 10*1024*1024;
const BLOB_SENT_FLAG = 0x40000000; // flags are 16-bit, so i can exploit other bits for myself
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

export class MyProtocol extends MyProtocolReaderWriter
{	server_version = '';
	connection_id = 0;
	capability_flags = 0;
	status_flags = 0;
	schema = '';
	is_broken_connection = false; // set on i/o error

	// for connections pool:
	use_till = Number.MAX_SAFE_INTEGER; // if keepAliveTimeout specified
	use_n_times = Number.MAX_SAFE_INTEGER; // if keepAliveMax specified

	private warnings = 0;
	private affected_rows: number|bigint = 0;
	private last_insert_id: number|bigint = 0;
	private status_info = '';

	private max_column_len = DEFAULT_MAX_COLUMN_LEN;
	private onloadfile?: (filename: string) => Promise<(Deno.Reader & Deno.Closer) | undefined>;

	static async inst
	(	dsn: Dsn,
		use_buffer?: Uint8Array,
		onloadfile?: (filename: string) => Promise<(Deno.Reader & Deno.Closer) | undefined>,
	): Promise<MyProtocol>
	{	let conn = await Deno.connect(dsn.addr);
		let protocol = new MyProtocol(conn, DEFAULT_TEXT_DECODER, use_buffer);
		if (dsn.maxColumnLen > 0)
		{	protocol.max_column_len = dsn.maxColumnLen;
		}
		protocol.onloadfile = onloadfile;
		try
		{	const auth_plugin = await protocol.read_handshake();
			let {username, password, schema} = dsn;
			await protocol.write_handshake_response(username, password, schema, auth_plugin, dsn.foundRows, dsn.ignoreSpace, dsn.multiStatements);
			const auth_plugin_2 = await protocol.read_auth_response(password, auth_plugin);
			if (auth_plugin_2)
			{	await protocol.write_auth_switch_response(password, auth_plugin_2);
				await protocol.read_auth_response(password, auth_plugin_2);
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
	private async read_handshake()
	{	// header
		this.read_packet_header() || await this.read_packet_header_async();
		// payload
		let protocol_version = this.read_uint8() ?? await this.read_uint8_async();
		if (protocol_version < 9)
		{	throw new Error(`Protocol version ${protocol_version} is not supported`);
		}
		let server_version = this.read_short_nul_string() ?? await this.read_short_nul_string_async();
		let connection_id = this.read_uint32() ?? await this.read_uint32_async();
		let auth_plugin_data = new Uint8Array(24).subarray(0, 0);
		let capability_flags = 0;
		let status_flags = 0;
		let auth_plugin_name = '';
		if (protocol_version == 9)
		{	auth_plugin_data = realloc_append(auth_plugin_data, this.read_short_nul_bytes() ?? await this.read_short_nul_bytes_async());
		}
		else
		{	auth_plugin_data = realloc_append(auth_plugin_data, this.read_short_bytes(8) ?? await this.read_short_bytes_async(8));
			this.read_void(1) || await this.read_void_async(1);
			capability_flags = this.read_uint16() ?? await this.read_uint16_async();
			if (!this.is_at_end_of_packet())
			{	this.read_uint8() ?? await this.read_uint8_async(); // lower 8 bits of the server-default charset (skip)
				status_flags = this.read_uint16() ?? await this.read_uint16_async();
				capability_flags |= (this.read_uint16() ?? await this.read_uint16_async()) << 16;
				let auth_plugin_data_len = 0;
				if (capability_flags & CapabilityFlags.CLIENT_PLUGIN_AUTH)
				{	auth_plugin_data_len = this.read_uint8() ?? await this.read_uint8_async();
					this.read_void(10) || await this.read_void_async(10);
				}
				else
				{	this.read_void(11) || await this.read_void_async(11);
				}
				if (capability_flags & CapabilityFlags.CLIENT_SECURE_CONNECTION)
				{	// read 2nd part of auth_plugin_data
					auth_plugin_data_len = Math.max(13, auth_plugin_data_len-8);
					let auth_plugin_data_2 = this.read_short_bytes(auth_plugin_data_len) ?? await this.read_short_bytes_async(auth_plugin_data_len);
					if (auth_plugin_data_2[auth_plugin_data_2.length - 1] == 0)
					{	auth_plugin_data_2 = auth_plugin_data_2.subarray(0, -1);
					}
					auth_plugin_data = realloc_append(auth_plugin_data, auth_plugin_data_2);
				}
				if (capability_flags & CapabilityFlags.CLIENT_PLUGIN_AUTH)
				{	auth_plugin_name = this.read_short_nul_string() ?? await this.read_short_nul_string_async();
				}
			}
		}
		// done
		this.go_to_end_of_packet() || await this.go_to_end_of_packet_async();
		this.server_version = server_version;
		this.connection_id = connection_id;
		this.capability_flags = capability_flags;
		this.status_flags = status_flags;
		return AuthPlugin.inst(auth_plugin_name, auth_plugin_data);
	}

	/**	Write client's response to initial server handshake packet.
	 **/
	private write_handshake_response(username: string, password: string, schema: string, auth_plugin: AuthPlugin, found_rows: boolean, ignore_space: boolean, multi_statements: boolean)
	{	// apply client capabilities
		this.capability_flags &=
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
			(found_rows ? CapabilityFlags.CLIENT_FOUND_ROWS : 0) |
			(ignore_space ? CapabilityFlags.CLIENT_IGNORE_SPACE : 0) |
			(multi_statements ? CapabilityFlags.CLIENT_MULTI_STATEMENTS : 0)
		);
		if (this.capability_flags & CapabilityFlags.CLIENT_SESSION_TRACK)
		{	this.schema = schema;
		}
		// send packet
		this.start_writing_new_packet();
		if (this.capability_flags & CapabilityFlags.CLIENT_PROTOCOL_41)
		{	this.write_uint32(this.capability_flags);
			this.write_uint32(0xFFFFFF); // max packet size
			this.write_uint8(DEFAULT_CHARACTER_SET_CLIENT);
			this.write_zero(23);
			this.write_nul_string(username);
			// auth
			if (!password)
			{	this.write_uint8(0);
			}
			else
			{	let auth = auth_plugin.quick_auth(password);
				if (this.capability_flags & CapabilityFlags.CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA)
				{	this.write_lenenc_int(auth.length);
					this.write_bytes(auth);
				}
				else if (this.capability_flags & CapabilityFlags.CLIENT_SECURE_CONNECTION)
				{	this.write_uint8(auth.length);
					this.write_bytes(auth);
				}
				else
				{	this.write_nul_bytes(auth);
				}
			}
			// schema
			if (this.capability_flags & CapabilityFlags.CLIENT_CONNECT_WITH_DB)
			{	this.write_nul_string(schema);
			}
			// auth_plugin_name
			if (this.capability_flags & CapabilityFlags.CLIENT_PLUGIN_AUTH)
			{	this.write_nul_string(auth_plugin.name);
			}
		}
		else
		{	this.write_uint16(this.capability_flags);
			this.write_uint32(0xFFFFFF); // max packet size
			this.write_nul_string(username);
			let auth = !password ? new Uint8Array : auth_plugin.quick_auth(password);
			if (this.capability_flags & CapabilityFlags.CLIENT_CONNECT_WITH_DB)
			{	this.write_nul_bytes(auth);
				this.write_nul_string(schema);
			}
			else
			{	this.write_bytes(auth);
			}
		}
		return this.send();
	}

	/**	If guessed auth method that was used during handshake was correct, just OK packet will be read on successful auth, and ERR if auth failed.
		But server can ask to switch auth method (EOF) or request plugin auth.
		This function returns different auth_plugin if auth switch required.
	 **/
	private async read_auth_response(password: string, auth_plugin: AuthPlugin)
	{	this.read_packet_header() || await this.read_packet_header_async();
		let type = this.read_uint8() ?? await this.read_uint8_async();
		switch (type)
		{	case PacketType.EOF: // AuthSwitchRequest
			{	let auth_plugin_name = this.read_short_nul_string() ?? await this.read_short_nul_string_async();
				let auth_plugin_data = (this.read_short_eof_bytes() ?? await this.read_short_eof_bytes_async()).slice();
				this.go_to_end_of_packet() || await this.go_to_end_of_packet_async();
				return AuthPlugin.inst(auth_plugin_name, auth_plugin_data);
			}
			case PacketType.OK:
			{	this.go_to_end_of_packet() || await this.go_to_end_of_packet_async();
				return;
			}
			case PacketType.ERR:
			{	let error_code = this.read_uint16() ?? await this.read_uint16_async();
				let sql_state = '';
				if (this.capability_flags & CapabilityFlags.CLIENT_PROTOCOL_41)
				{	sql_state = this.read_short_string(6) ?? await this.read_short_string_async(6);
				}
				let error_message = this.read_short_eof_string() ?? await this.read_short_eof_string_async();
				throw new SqlError(error_message, error_code, sql_state);
			}
			default: // Use plugin for authentication
			{	let data = this.read_short_eof_bytes() ?? await this.read_short_eof_bytes_async();
				while (!await auth_plugin.progress(password, type, data, this))
				{	type = await this.read_packet();
					if (type != PacketType.OK)
					{	data = this.read_short_eof_bytes() ?? await this.read_short_eof_bytes_async();
					}
				}
			}
		}
	}

	/**	Respond to second auth attempt, after got AuthSwitchRequest.
	 **/
	private write_auth_switch_response(password: string, auth_plugin: AuthPlugin)
	{	this.start_writing_new_packet();
		if (password)
		{	let auth = auth_plugin.quick_auth(password);
			this.write_bytes(auth);
		}
		return this.send();
	}

	/**	Reads packet header, and packet type (first byte of the packet).
		If the packet type was OK or EOF, and ReadPacketMode.REGULAR, reads it to the end, and returns OK.
		If it was ERR, reads it to the end, and throws SqlError.
		Else, returns the packet type, and leaves the caller responsible to read the packet to the end.
		In case of ReadPacketMode.PREPARED_STMT, an OK or an EOF packet must be read by the caller (because it has different format after COM_STMT_PREPARE).
	 **/
	private async read_packet(mode=ReadPacketMode.REGULAR)
	{	let type = 0;
		if (mode != ReadPacketMode.PREPARED_STMT_OK_CONTINUATION)
		{	debug_assert(this.is_at_end_of_packet());
			this.read_packet_header() || await this.read_packet_header_async();
			type = this.read_uint8() ?? await this.read_uint8_async();
		}
		switch (type)
		{	case PacketType.EOF:
			{	if (this.payload_length >= 9) // not a EOF packet. EOF packets are <9 bytes long, and if it's >=9, it's a lenenc int
				{	return type;
				}
				if (!(this.capability_flags & CapabilityFlags.CLIENT_DEPRECATE_EOF))
				{	if (this.capability_flags & CapabilityFlags.CLIENT_PROTOCOL_41)
					{	this.warnings = this.read_uint16() ?? await this.read_uint16_async();
						this.status_flags = this.read_uint16() ?? await this.read_uint16_async();
					}
					this.go_to_end_of_packet() || await this.go_to_end_of_packet_async();
					return mode==ReadPacketMode.REGULAR ? PacketType.OK : type;
				}
				// else fallthrough to OK
			}
			case PacketType.OK:
			{	if (mode!=ReadPacketMode.PREPARED_STMT || type==PacketType.EOF)
				{	this.affected_rows = this.read_lenenc_int() ?? await this.read_lenenc_int_async();
					this.last_insert_id = this.read_lenenc_int() ?? await this.read_lenenc_int_async();
					if (this.capability_flags & CapabilityFlags.CLIENT_PROTOCOL_41)
					{	this.status_flags = this.read_uint16() ?? await this.read_uint16_async();
						this.warnings = this.read_uint16() ?? await this.read_uint16_async();
					}
					else if (this.capability_flags & CapabilityFlags.CLIENT_TRANSACTIONS)
					{	this.status_flags = this.read_uint16() ?? await this.read_uint16_async();
					}
					if (!this.is_at_end_of_packet())
					{	if (this.capability_flags & CapabilityFlags.CLIENT_SESSION_TRACK)
						{	this.status_info = this.read_short_lenenc_string() ?? await this.read_short_lenenc_string_async();
							if (this.status_flags & StatusFlags.SERVER_SESSION_STATE_CHANGED)
							{	let session_state_changes_len = Number(this.read_lenenc_int() ?? await this.read_lenenc_int_async());
								let to = this.packet_offset + session_state_changes_len;
								while (this.packet_offset < to)
								{	let change_type = this.read_uint8() ?? await this.read_uint8_async();
									switch (change_type)
									{	case SessionTrack.SYSTEM_VARIABLES:
										{	this.read_lenenc_int() ?? await this.read_lenenc_int_async(); // skip
											let name = this.read_short_lenenc_string() ?? await this.read_short_lenenc_string_async();
											let value = this.read_short_lenenc_string() ?? await this.read_short_lenenc_string_async();
											if (name == 'character_set_client')
											{	this.set_character_set_client(value);
											}
											else if (name == 'character_set_results')
											{	this.set_character_set_results(value);
											}
											break;
										}
										case SessionTrack.SCHEMA:
											this.read_lenenc_int() ?? await this.read_lenenc_int_async(); // skip
											this.schema = this.read_short_lenenc_string() ?? await this.read_short_lenenc_string_async();
											break;
										default:
											this.read_short_lenenc_bytes() ?? await this.read_short_lenenc_bytes_async(); // skip
									}
								}
							}
						}
						else
						{	this.status_info = this.read_short_eof_string() ?? await this.read_short_eof_string_async();
						}
					}
					this.go_to_end_of_packet() || await this.go_to_end_of_packet_async();
				}
				return mode==ReadPacketMode.REGULAR ? PacketType.OK : type;
			}
			case PacketType.ERR:
			{	let error_code = this.read_uint16() ?? await this.read_uint16_async();
				let sql_state = '';
				if (this.capability_flags & CapabilityFlags.CLIENT_PROTOCOL_41)
				{	sql_state = this.read_short_string(6) ?? await this.read_short_string_async(6);
				}
				let error_message = this.read_short_eof_string() ?? await this.read_short_eof_string_async();
				this.go_to_end_of_packet() || await this.go_to_end_of_packet_async();
				throw new SqlError(error_message, error_code, sql_state);
			}
			default:
			{	return type;
			}
		}
	}

	private set_character_set_client(value: string)
	{	if (value.slice(0, 4) != 'utf8')
		{	throw new Error(`Cannot use this value for character_set_client: ${value}. Can only use utf8.`);
		}
	}

	private set_character_set_results(value: string)
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

	send_uint8_packet(value: number)
	{	this.start_writing_new_packet();
		this.write_uint8(value);
		return this.send();
	}

	send_bytes_packet(value: Uint8Array)
	{	this.start_writing_new_packet();
		this.write_bytes(value);
		return this.send();
	}

	private init_resultsets(resultsets: ResultsetsDriver<unknown>)
	{	resultsets.lastInsertId = this.last_insert_id;
		resultsets.warnings = this.warnings;
		resultsets.statusInfo = this.status_info;
		resultsets.noGoodIndexUsed = (this.status_flags & StatusFlags.SERVER_STATUS_NO_GOOD_INDEX_USED) != 0;
		resultsets.noIndexUsed = (this.status_flags & StatusFlags.SERVER_STATUS_NO_INDEX_USED) != 0;
		resultsets.isSlowQuery = (this.status_flags & StatusFlags.SERVER_QUERY_WAS_SLOW) != 0;
		if (this.capability_flags & CapabilityFlags.CLIENT_FOUND_ROWS)
		{	resultsets.foundRows = this.affected_rows;
		}
		else
		{	resultsets.affectedRows = this.affected_rows;
		}
	}

	private async read_query_response(resultsets: ResultsetsDriver<unknown>, mode: ReadPacketMode)
	{	debug_assert(mode==ReadPacketMode.REGULAR || mode==ReadPacketMode.PREPARED_STMT);
		debug_assert(resultsets.stmt_id == -1);
L:		while (true)
		{	let type = await this.read_packet(mode);
			let n_columns: number|bigint = 0;
			let n_placeholders = 0;
			switch (type)
			{	case PacketType.OK:
				{	if (mode == ReadPacketMode.REGULAR)
					{	this.init_resultsets(resultsets);
						n_columns = 0;
					}
					else
					{	resultsets.stmt_id = this.read_uint32() ?? await this.read_uint32_async();
						n_columns = this.read_uint16() ?? await this.read_uint16_async();
						n_placeholders = this.read_uint16() ?? await this.read_uint16_async();
						this.read_uint8() ?? await this.read_uint8_async(); // skip reserved_1
						this.warnings = this.read_uint16() ?? await this.read_uint16_async();
						this.go_to_end_of_packet() || await this.go_to_end_of_packet_async();
					}
					break;
				}
				case PacketType.NULL_OR_LOCAL_INFILE:
				{	let filename = this.read_short_eof_string() ?? await this.read_short_eof_string_async();
					this.go_to_end_of_packet() || await this.go_to_end_of_packet_async();
					if (!this.onloadfile)
					{	throw new Error(`LOCAL INFILE handler is not set. Requested file: ${filename}`);
					}
					let reader = await this.onloadfile(filename);
					if (!reader)
					{	throw new Error(`File is not accepted for LOCAL INFILE: ${filename}`);
					}
					try
					{	while (true)
						{	this.start_writing_new_packet();
							let n = await this.write_read_chunk(reader);
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
				{	n_columns = this.read_uint16() ?? await this.read_uint16_async();
					break;
				}
				case PacketType.UINT24:
				{	n_columns = this.read_uint24() ?? await this.read_uint24_async();
					break;
				}
				case PacketType.UINT64:
				{	n_columns = this.read_uint64() ?? await this.read_uint64_async();
					break;
				}
				default:
				{	n_columns = type;
				}
			}
			if (n_columns > Number.MAX_SAFE_INTEGER) // want cast bigint -> number
			{	throw new Error(`Can't handle so many columns: ${n_columns}`);
			}
			let n_columns_num = Number(n_columns);

			// Read sequence of ColumnDefinition packets
			await this.skip_column_definition_packets(n_placeholders);
			let columns = n_columns_num==0 ? [] : await this.read_column_definition_packets(n_columns_num);

			resultsets.nPlaceholders = n_placeholders;
			resultsets.columns = columns;
			resultsets.has_more_rows = mode==ReadPacketMode.REGULAR && n_columns_num!=0;
			resultsets.has_more = mode==ReadPacketMode.REGULAR && (n_columns_num != 0 || (this.status_flags & StatusFlags.SERVER_MORE_RESULTS_EXISTS) != 0);

			if (!resultsets.has_more)
			{	resultsets.fetch = () => Promise.resolve(undefined); // eof
				resultsets.next_resultset = () => Promise.resolve(false);
			}
			break;
		}
	}

	private async read_column_definition_packets(n_packets: number)
	{	let columns: Column[] = [];
		if (n_packets > 0)
		{	if (this.capability_flags & CapabilityFlags.CLIENT_PROTOCOL_41)
			{	for (let i=0; i<n_packets; i++)
				{	// Read ColumnDefinition41 packet
					this.read_packet_header() || await this.read_packet_header_async();
					let catalog = this.read_short_lenenc_string() ?? await this.read_short_lenenc_string_async();
					let schema = this.read_short_lenenc_string() ?? await this.read_short_lenenc_string_async();
					let table = this.read_short_lenenc_string() ?? await this.read_short_lenenc_string_async();
					let org_table = this.read_short_lenenc_string() ?? await this.read_short_lenenc_string_async();
					let name = this.read_short_lenenc_string() ?? await this.read_short_lenenc_string_async();
					let org_name = this.read_short_lenenc_string() ?? await this.read_short_lenenc_string_async();
					let block_len = Number(this.read_lenenc_int() ?? await this.read_lenenc_int_async());
					debug_assert(block_len >= 12);
					let block = this.read_short_bytes(block_len) ?? await this.read_short_bytes_async(block_len);
					let v = new DataView(block.buffer, block.byteOffset);
					let charset = v.getUint16(0, true);
					let column_len = v.getUint32(2, true);
					let column_type = v.getUint8(6);
					let flags = v.getUint16(7, true);
					let decimals = v.getUint8(9);
					this.go_to_end_of_packet() || await this.go_to_end_of_packet_async();
					columns[i] = new Column(catalog, schema, table, org_table, name, org_name, charset, column_len, column_type, flags, decimals);
				}
			}
			else
			{	for (let i=0; i<n_packets; i++)
				{	// Read ColumnDefinition320 packet
					this.read_packet_header() || await this.read_packet_header_async();
					let table = this.read_short_lenenc_string() ?? await this.read_short_lenenc_string_async();
					let name = this.read_short_lenenc_string() ?? await this.read_short_lenenc_string_async();
					let block_len = Number(this.read_lenenc_int() ?? await this.read_lenenc_int_async());
					let block = this.read_short_bytes(block_len) ?? await this.read_short_bytes_async(block_len);
					let v = new DataView(block.buffer, block.byteOffset);
					let column_len = v.getUint16(0, true) | (v.getUint8(2) << 16);
					block_len = Number(this.read_lenenc_int() ?? await this.read_lenenc_int_async());
					block = this.read_short_bytes(block_len) ?? await this.read_short_bytes_async(block_len);
					v = new DataView(block.buffer, block.byteOffset);
					let column_type = v.getUint8(0);
					block_len = Number(this.read_lenenc_int() ?? await this.read_lenenc_int_async());
					block = this.read_short_bytes(block_len) ?? await this.read_short_bytes_async(block_len);
					v = new DataView(block.buffer, block.byteOffset);
					let flags;
					let decimals;
					if (this.capability_flags & CapabilityFlags.CLIENT_LONG_FLAG)
					{	flags = v.getUint16(0, true);
						decimals = v.getUint8(2);
					}
					else
					{	flags = v.getUint8(0);
						decimals = v.getUint8(1);
					}
					this.go_to_end_of_packet() || await this.go_to_end_of_packet_async();
					columns[i] = new Column('', '', table, '', name, '', Charset.UNKNOWN, column_len, column_type, flags, decimals);
				}
			}
			if (!(this.capability_flags & CapabilityFlags.CLIENT_DEPRECATE_EOF))
			{	// Read EOF after columns list
				let type = await this.read_packet();
				debug_assert(type == PacketType.OK);
			}
		}
		return columns;
	}

	private async skip_column_definition_packets(n_packets: number)
	{	if (n_packets > 0)
		{	for (let i=0; i<n_packets; i++)
			{	// Read ColumnDefinition41 packet
				this.read_packet_header() || await this.read_packet_header_async();
				this.go_to_end_of_packet() || await this.go_to_end_of_packet_async();
			}
			if (!(this.capability_flags & CapabilityFlags.CLIENT_DEPRECATE_EOF))
			{	// Read EOF after columns list
				let type = await this.read_packet();
				debug_assert(type == PacketType.OK);
			}
		}
	}

	send_com_reset_connection()
	{	this.start_writing_new_packet(true);
		this.write_uint8(Command.COM_RESET_CONNECTION);
		return this.send();
	}

	send_com_query(sql: SqlSource)
	{	this.start_writing_new_packet(true);
		this.write_uint8(Command.COM_QUERY);
		return this.send_with_data(sql, (this.status_flags & StatusFlags.SERVER_STATUS_NO_BACKSLASH_ESCAPES) != 0);
	}

	send_com_stmt_prepare(sql: SqlSource, put_params_to?: any[])
	{	this.start_writing_new_packet(true);
		this.write_uint8(Command.COM_STMT_PREPARE);
		return this.send_with_data(sql, (this.status_flags & StatusFlags.SERVER_STATUS_NO_BACKSLASH_ESCAPES) != 0, false, put_params_to);
	}

	read_com_query_response(resultsets: ResultsetsDriver<unknown>)
	{	return this.read_query_response(resultsets, ReadPacketMode.REGULAR);
	}

	read_com_stmt_prepare_response(resultsets: ResultsetsDriver<unknown>)
	{	return this.read_query_response(resultsets, ReadPacketMode.PREPARED_STMT);
	}

	send_com_stmt_close(stmt_id: number)
	{	this.start_writing_new_packet(true);
		this.write_uint8(Command.COM_STMT_CLOSE);
		this.write_uint32(stmt_id);
		return this.send();
	}

	async send_com_stmt_execute(resultsets: ResultsetsDriver<unknown>, params: Param[])
	{	let {stmt_id, nPlaceholders} = resultsets;
		let max_expected_packet_size_including_header = 15 + nPlaceholders*16; // packet header (4-byte) + COM_STMT_EXECUTE (1-byte) + stmt_id (4-byte) + NO_CURSOR (1-byte) + iteration_count (4-byte) + new_params_bound_flag (1-byte) = 15; each placeholder can be Date (max 12 bytes) + param type (2-byte) + null mask (1-bit) <= 15
		let extra_space_for_params = Math.max(0, this.buffer.length - max_expected_packet_size_including_header);
		let packet_start = 0;
		let placeholdersSent = new Set<number>();
		// First send COM_STMT_SEND_LONG_DATA params, as they must be sent before COM_STMT_EXECUTE
		for (let i=0; i<nPlaceholders; i++)
		{	let param = params[i];
			if (param!=null && typeof(param)!='function' && typeof(param)!='symbol') // if is not NULL
			{	if (typeof(param) == 'string')
				{	let max_byte_len = param.length * 4;
					if (max_byte_len > extra_space_for_params)
					{	this.start_writing_new_packet(true, packet_start);
						this.write_uint8(Command.COM_STMT_SEND_LONG_DATA);
						this.write_uint32(stmt_id);
						this.write_uint16(i);
						packet_start = await this.send_with_data(param, false, true);
						placeholdersSent.add(i);
					}
					else
					{	extra_space_for_params -= max_byte_len;
					}
				}
				else if (typeof(param) == 'object')
				{	if (param instanceof Uint8Array)
					{	if (param.byteLength > extra_space_for_params)
						{	this.start_writing_new_packet(true, packet_start);
							this.write_uint8(Command.COM_STMT_SEND_LONG_DATA);
							this.write_uint32(stmt_id);
							this.write_uint16(i);
							packet_start = await this.send_with_data(param, false, true);
							placeholdersSent.add(i);
						}
						else
						{	extra_space_for_params -= param.byteLength;
						}
					}
					else if (param.buffer instanceof ArrayBuffer)
					{	if (param.byteLength > extra_space_for_params)
						{	this.start_writing_new_packet(true, packet_start);
							this.write_uint8(Command.COM_STMT_SEND_LONG_DATA);
							this.write_uint32(stmt_id);
							this.write_uint16(i);
							packet_start = await this.send_with_data(new Uint8Array(param.buffer, param.byteOffset, param.byteLength), false, true);
							placeholdersSent.add(i);
						}
						else
						{	extra_space_for_params -= param.byteLength;
						}
					}
					else if (typeof(param.read) == 'function')
					{	let is_empty = true;
						while (true)
						{	this.start_writing_new_packet(is_empty, packet_start);
							this.write_uint8(Command.COM_STMT_SEND_LONG_DATA);
							this.write_uint32(stmt_id);
							this.write_uint16(i);
							let n = await this.write_read_chunk(param);
							if (n == null)
							{	this.discard_packet();
								break;
							}
							await this.send();
							packet_start = 0;
							is_empty = false;
						}
						if (!is_empty)
						{	placeholdersSent.add(i);
						}
					}
					else if (!(param instanceof Date))
					{	this.start_writing_new_packet(true, packet_start);
						this.write_uint8(Command.COM_STMT_SEND_LONG_DATA);
						this.write_uint32(stmt_id);
						this.write_uint16(i);
						packet_start = await this.send_with_data(JSON.stringify(param), false, true);
						placeholdersSent.add(i);
					}
				}
			}
		}
		// Flush, if not enuogh space in buffer for the placeholders packet
		if (packet_start > 0 && packet_start + max_expected_packet_size_including_header > this.buffer.length)
		{	await this.send();
			packet_start = 0;
		}
		// Send params in binary protocol
		this.start_writing_new_packet(true, packet_start);
		this.write_uint8(Command.COM_STMT_EXECUTE);
		this.write_uint32(stmt_id);
		this.write_uint8(CursorType.NO_CURSOR);
		this.write_uint32(1); // iteration_count
		if (nPlaceholders > 0)
		{	// Send null-bitmap for each param
			this.ensure_room((nPlaceholders >> 3) + 2 + (nPlaceholders << 1)); // 1 bit per each placeholder (nPlaceholders/8 bytes) + partial byte (1 byte) + new_params_bound_flag (1 byte) + 2-byte type per each placeholder (nPlaceholders*2 bytes)
			let null_bits = 0;
			let null_bit_mask = 1;
			for (let i=0; i<nPlaceholders; i++)
			{	let param = params[i];
				if (param==null || typeof(param)=='function' || typeof(param)=='symbol') // if is NULL
				{	null_bits |= null_bit_mask;
				}
				if (null_bit_mask != 0x80)
				{	null_bit_mask <<= 1;
				}
				else
				{	this.write_uint8(null_bits);
					null_bits = 0;
					null_bit_mask = 1;
				}
			}
			if (null_bit_mask != 1)
			{	this.write_uint8(null_bits);
			}
			this.write_uint8(1); // new_params_bound_flag
			// Send type of each param
			let params_len = 0;
			for (let i=0; i<nPlaceholders; i++)
			{	let param = params[i];
				let type = FieldType.MYSQL_TYPE_STRING;
				if (param!=null && typeof(param)!='function' && typeof(param)!='symbol') // if is not NULL
				{	if (typeof(param) == 'boolean')
					{	type = FieldType.MYSQL_TYPE_TINY;
						params_len++;
					}
					else if (typeof(param) == 'number')
					{	if (Number.isInteger(param) && param>=-0x8000_0000 && param<=0x7FFF_FFFF)
						{	type = FieldType.MYSQL_TYPE_LONG;
							params_len += 4;
						}
						else
						{	type = FieldType.MYSQL_TYPE_DOUBLE;
							params_len+= 8;
						}
					}
					else if (typeof(param) == 'bigint')
					{	type = FieldType.MYSQL_TYPE_LONGLONG;
						params_len += 8;
					}
					else if (typeof(param) == 'object')
					{	if (param instanceof Date)
						{	type = FieldType.MYSQL_TYPE_DATETIME;
							params_len += 12;
						}
						else if (param.buffer instanceof ArrayBuffer)
						{	type = FieldType.MYSQL_TYPE_LONG_BLOB;
							params_len += param.byteLength;
						}
						else if (typeof(param.read) == 'function')
						{	type = FieldType.MYSQL_TYPE_LONG_BLOB;
							params_len++;
						}
					}
					else
					{	debug_assert(typeof(param) == 'string');
					}
				}
				this.write_uint16(type);
			}
			// Send value of each param
			this.ensure_room(params_len);
			for (let i=0; i<nPlaceholders; i++)
			{	let param = params[i];
				if (param!=null && typeof(param)!='function' && typeof(param)!='symbol' && !placeholdersSent.has(i)) // if is not NULL and not sent
				{	if (typeof(param) == 'boolean')
					{	this.write_uint8(param ? 1 : 0);
					}
					else if (typeof(param) == 'number')
					{	if (Number.isInteger(param) && param>=-0x8000_0000 && param<=0x7FFF_FFFF)
						{	this.write_uint32(param);
						}
						else
						{	this.write_double(param);
						}
					}
					else if (typeof(param) == 'bigint')
					{	this.write_uint64(param);
					}
					else if (typeof(param) == 'string')
					{	this.write_lenenc_string(param);
					}
					else if (param instanceof Date)
					{	let frac = param.getMilliseconds();
						this.write_uint8(frac ? 11 : 7); // length
						this.write_uint16(param.getFullYear());
						this.write_uint8(param.getMonth() + 1);
						this.write_uint8(param.getDate());
						this.write_uint8(param.getHours());
						this.write_uint8(param.getMinutes());
						this.write_uint8(param.getSeconds());
						if (frac)
						{	this.write_uint32(frac * 1000);
						}
					}
					else if (param instanceof Uint8Array)
					{	this.write_lenenc_bytes(param);
					}
					else if (param.buffer instanceof ArrayBuffer)
					{	this.write_lenenc_bytes(new Uint8Array(param.buffer, param.byteOffset, param.byteLength));
					}
					else
					{	debug_assert(typeof(param.read) == 'function');
						// nothing written for this param (as it's not marked with BLOB_SENT_FLAG), so write empty string
						this.write_uint8(0); // 0-length lenenc-string
					}
				}
			}
		}
		await this.send();
		// Read Binary Protocol Resultset
		let type = await this.read_packet(ReadPacketMode.PREPARED_STMT); // throw if ERR packet
		this.unput(type);
		let row_n_columns = this.read_lenenc_int() ?? await this.read_lenenc_int_async();
		if (row_n_columns > Number.MAX_SAFE_INTEGER) // want cast bigint -> number
		{	throw new Error(`Can't handle so many columns: ${row_n_columns}`);
		}
		row_n_columns = Number(row_n_columns);
		if (row_n_columns > 0)
		{	resultsets.columns = await this.read_column_definition_packets(row_n_columns);
			resultsets.has_more_rows = true;
			resultsets.has_more = true;
		}
		else
		{	resultsets.has_more_rows = false;
			resultsets.has_more = (this.status_flags & StatusFlags.SERVER_MORE_RESULTS_EXISTS) != 0;
			if (!resultsets.has_more)
			{	resultsets.fetch = () => Promise.resolve(undefined); // eof
				resultsets.next_resultset = () => Promise.resolve(false);
			}
			if (!this.is_at_end_of_packet())
			{	await this.read_packet(ReadPacketMode.PREPARED_STMT_OK_CONTINUATION);
				this.init_resultsets(resultsets);
			}
		}
	}

	async fetch<Row>(resultsets: ResultsetsDriver<Row>, row_type: RowType, onreadend?: () => Promise<void>): Promise<Row | undefined>
	{	debug_assert(resultsets.has_more_rows && resultsets.has_more);
		let {stmt_id, columns} = resultsets;
		let n_columns = columns.length;
		let type = await this.read_packet(stmt_id==-1 ? ReadPacketMode.REGULAR : ReadPacketMode.PREPARED_STMT);
		if (type == (stmt_id==-1 ? PacketType.OK : PacketType.EOF))
		{	resultsets.has_more_rows = false;
			resultsets.has_more = (this.status_flags & StatusFlags.SERVER_MORE_RESULTS_EXISTS) != 0;
			if (!resultsets.has_more)
			{	resultsets.fetch = () => Promise.resolve(undefined); // eof
				resultsets.next_resultset = () => Promise.resolve(false);
			}
			return undefined;
		}
		let buffer: Uint8Array|undefined;
		let row: any;
		switch (row_type)
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
				debug_assert(row_type == RowType.FIRST_COLUMN);
		}
		let last_column_reader_len = 0;
		if (stmt_id == -1)
		{	// Text protocol row
			this.unput(type);
			for (let i=0; i<n_columns; i++)
			{	let len = this.read_lenenc_int() ?? await this.read_lenenc_int_async();
				if (len > Number.MAX_SAFE_INTEGER)
				{	throw new Error(`Field is too long: ${len} bytes`);
				}
				len = Number(len);
				let value: ColumnValue = null;
				if (len != -1) // if not a null value
				{	if (row_type==RowType.LAST_COLUMN_READER && i+1==n_columns)
					{	last_column_reader_len = len;
					}
					else if (len > this.max_column_len)
					{	this.read_void(len) || this.read_void_async(len);
					}
					else if (len <= this.buffer.length)
					{	let v = this.read_short_bytes(len) ?? await this.read_short_bytes_async(len);
						value = conv_column_value(v, columns[i].type, this.decoder);
					}
					else
					{	if (!buffer || buffer.length<len)
						{	buffer = new Uint8Array(len);
						}
						let v = buffer.subarray(0, len);
						await this.read_bytes_to_buffer(v);
						value = conv_column_value(v, columns[i].type, this.decoder);
					}
				}
				switch (row_type)
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
						debug_assert(row_type == RowType.FIRST_COLUMN);
						if (i == 0)
						{	row = value;
						}
				}
			}
		}
		else
		{	// Binary protocol row
			let null_bits_len = (n_columns + 2 + 7) >> 3;
			let null_bits = (this.read_short_bytes(null_bits_len) ?? await this.read_short_bytes_async(null_bits_len)).slice();
			let null_bits_i = 0;
			let null_bit_mask = 4; // starts from bit offset 1 << 2, according to protocol definition
			for (let i=0; i<n_columns; i++)
			{	let value: ColumnValue = null;
				let is_null = null_bits[null_bits_i] & null_bit_mask;
				if (null_bit_mask != 0x80)
				{	null_bit_mask <<= 1;
				}
				else
				{	null_bits_i++;
					null_bit_mask = 1;
				}
				if (!is_null)
				{	switch (columns[i].type)
					{	case FieldType.MYSQL_TYPE_TINY:
							value = this.read_uint8() ?? await this.read_uint8_async();
							break;
						case FieldType.MYSQL_TYPE_SHORT:
						case FieldType.MYSQL_TYPE_YEAR:
							value = this.read_uint16() ?? await this.read_uint16_async();
							break;
						case FieldType.MYSQL_TYPE_LONG:
							value = this.read_uint32() ?? await this.read_uint32_async();
							break;
						case FieldType.MYSQL_TYPE_LONGLONG:
							value = this.read_uint64() ?? await this.read_uint64_async();
							break;
						case FieldType.MYSQL_TYPE_FLOAT:
							value = this.read_float() ?? await this.read_float_async();
							break;
						case FieldType.MYSQL_TYPE_DOUBLE:
							value = this.read_double() ?? await this.read_double_async();
							break;
						case FieldType.MYSQL_TYPE_DATE:
						case FieldType.MYSQL_TYPE_DATETIME:
						case FieldType.MYSQL_TYPE_TIMESTAMP:
						{	let len = this.read_uint8() ?? await this.read_uint8_async();
							if (len >= 4)
							{	let year = this.read_uint16() ?? await this.read_uint16_async();
								let month = this.read_uint8() ?? await this.read_uint8_async();
								let day = this.read_uint8() ?? await this.read_uint8_async();
								let hour=0, minute=0, second=0, micro=0;
								if (len >= 7)
								{	hour = this.read_uint8() ?? await this.read_uint8_async();
									minute = this.read_uint8() ?? await this.read_uint8_async();
									second = this.read_uint8() ?? await this.read_uint8_async();
									if (len >= 11)
									{	micro = this.read_uint32() ?? await this.read_uint32_async();
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
						{	let len = this.read_uint8() ?? await this.read_uint8_async();
							if (len >= 8)
							{	let is_negative = this.read_uint8() ?? await this.read_uint8_async();
								let days = this.read_uint32() ?? await this.read_uint32_async();
								let hours = this.read_uint8() ?? await this.read_uint8_async();
								let minutes = this.read_uint8() ?? await this.read_uint8_async();
								let seconds = this.read_uint8() ?? await this.read_uint8_async();
								hours += days * 24;
								minutes += hours * 60;
								seconds += minutes * 60;
								if (len >= 12)
								{	let micro = this.read_uint32() ?? await this.read_uint32_async();
									seconds += micro / 1_000_000;
								}
								value = is_negative ? -seconds : seconds;
							}
							else
							{	value = 0;
							}
							break;
						}
						default:
						{	let len = this.read_lenenc_int() ?? await this.read_lenenc_int_async();
							if (len > Number.MAX_SAFE_INTEGER)
							{	throw new Error(`Field is too long: ${len} bytes`);
							}
							len = Number(len);
							if (row_type==RowType.LAST_COLUMN_READER && i+1==n_columns)
							{	last_column_reader_len = len;
							}
							else if (len > this.max_column_len)
							{	this.read_void(len) || this.read_void_async(len);
							}
							else if (len <= this.buffer.length)
							{	value = this.read_short_string(len) ?? await this.read_short_string_async(len);
							}
							else
							{	if (!buffer || buffer.length<len)
								{	buffer = new Uint8Array(len);
								}
								let v = buffer.subarray(0, len);
								await this.read_bytes_to_buffer(v);
								value = this.decoder.decode(v);
							}
						}
					}
				}
				switch (row_type)
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
						debug_assert(row_type == RowType.FIRST_COLUMN);
						if (i == 0)
						{	row = value;
						}
				}
			}
		}
		if (row_type == RowType.LAST_COLUMN_READER)
		{	let that = this;
			let column_name = columns[columns.length - 1].name;
			let data_in_cur_packet_len = Math.min(last_column_reader_len, this.payload_length - this.packet_offset);
			row[column_name] =
			{	async read(dest: Uint8Array)
				{	if (last_column_reader_len <= 0)
					{	debug_assert(last_column_reader_len==0 && data_in_cur_packet_len==0);
						if (that.payload_length == 0xFFFFFF) // packet of 0xFFFFFF length must be followed by one empty packet
						{	that.read_packet_header() || await that.read_packet_header_async();
							debug_assert((that.payload_length as any) == 0);
						}
						await onreadend?.();
						return null;
					}
					if (data_in_cur_packet_len <= 0)
					{	debug_assert(data_in_cur_packet_len == 0);
						that.read_packet_header() || await that.read_packet_header_async();
						data_in_cur_packet_len = Math.min(last_column_reader_len, that.payload_length - that.packet_offset);
					}
					let n = Math.min(dest.length, data_in_cur_packet_len);
					await that.read_bytes_to_buffer(dest.subarray(0, n));
					data_in_cur_packet_len -= n;
					last_column_reader_len -= n;
					return n;
				}
			};
		}
		return row;
	}

	async next_resultset(resultsets: ResultsetsDriver<unknown>)
	{	let mode = resultsets.stmt_id==-1 ? ReadPacketMode.REGULAR : ReadPacketMode.PREPARED_STMT;
		if (resultsets.has_more_rows)
		{	while (true)
			{	let type = await this.read_packet(mode);
				this.go_to_end_of_packet() || await this.go_to_end_of_packet_async();
				if (type == (resultsets.stmt_id==-1 ? PacketType.OK : PacketType.EOF))
				{	resultsets.has_more_rows = false;
					resultsets.has_more = (this.status_flags & StatusFlags.SERVER_MORE_RESULTS_EXISTS) != 0;
					break;
				}
			}
		}
		if (!resultsets.has_more)
		{	resultsets.fetch = () => Promise.resolve(undefined); // eof
			resultsets.next_resultset = () => Promise.resolve(false);
		}
		else
		{	resultsets.reset_fields();
			await this.read_query_response(resultsets, mode);
		}
	}
}
