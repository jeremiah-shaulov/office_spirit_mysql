export const enum CapabilityFlags
{	CLIENT_LONG_PASSWORD					= 1,		// new more secure passwords
	CLIENT_FOUND_ROWS						= 2,		// Found instead of affected rows
	CLIENT_LONG_FLAG						= 4,		// Get all column flags
	CLIENT_CONNECT_WITH_DB					= 8,		// One can specify db on connect
	CLIENT_NO_SCHEMA						= 16,		// Don't allow database.table.column
	CLIENT_COMPRESS							= 32,		// Can use compression protocol
	CLIENT_ODBC								= 64,		// Odbc client
	CLIENT_LOCAL_FILES						= 128,		// Can use LOAD DATA LOCAL
	CLIENT_IGNORE_SPACE						= 256,		// Ignore spaces before '('
	CLIENT_PROTOCOL_41						= 512,		// New 4.1 protocol
	CLIENT_INTERACTIVE						= 1024,		// This is an interactive client
	CLIENT_SSL								= 2048,		// Switch to SSL after handshake
	CLIENT_IGNORE_SIGPIPE					= 4096,		// IGNORE sigpipes
	CLIENT_TRANSACTIONS						= 8192,		// Client knows about transactions
	CLIENT_RESERVED							= 16384,	// Old flag for 4.1 protocol
	CLIENT_SECURE_CONNECTION				= 32768,	// New 4.1 authentication
	CLIENT_MULTI_STATEMENTS					= 1 << 16,	// Enable/disable multi-stmt support
	CLIENT_MULTI_RESULTS					= 1 << 17,	// Enable/disable multi-results
	CLIENT_PS_MULTI_RESULTS					= 1 << 18,	// Multi-results in PS-protocol
	CLIENT_PLUGIN_AUTH						= 1 << 19,	// Client supports plugin authentication
	CLIENT_CONNECT_ATTRS					= 1 << 20,	// Client supports connection attributes
	CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA	= 1 << 21,	// Enable authentication response packet to be larger than 255 bytes.
	CLIENT_CAN_HANDLE_EXPIRED_PASSWORDS		= 1 << 22,	// Don't close the connection for a connection with expired password.
	CLIENT_SESSION_TRACK					= 1 << 23,	// Extended OK
	CLIENT_DEPRECATE_EOF					= 1 << 24,
}

export const enum StatusFlags
{	SERVER_STATUS_IN_TRANS				= 0x0001, // a transaction is active
	SERVER_STATUS_AUTOCOMMIT			= 0x0002, // auto-commit is enabled
	SERVER_MORE_RESULTS_EXISTS			= 0x0008,
	SERVER_STATUS_NO_GOOD_INDEX_USED	= 0x0010,
	SERVER_STATUS_NO_INDEX_USED			= 0x0020,
	SERVER_STATUS_CURSOR_EXISTS			= 0x0040, // Used by Binary Protocol Resultset to signal that COM_STMT_FETCH must be used to fetch the row-data.
	SERVER_STATUS_LAST_ROW_SENT			= 0x0080,
	SERVER_STATUS_DB_DROPPED			= 0x0100,
	SERVER_STATUS_NO_BACKSLASH_ESCAPES	= 0x0200,
	SERVER_STATUS_METADATA_CHANGED		= 0x0400,
	SERVER_QUERY_WAS_SLOW				= 0x0800,
	SERVER_PS_OUT_PARAMS				= 0x1000,
	SERVER_STATUS_IN_TRANS_READONLY		= 0x2000, // in a read-only transaction
	SERVER_SESSION_STATE_CHANGED		= 0x4000, // connection state information has changed
}

export const enum PacketType
{	OK = 0x00,
	EOF = 0xFE,
	ERR = 0xFF,
	NULL_OR_LOCAL_INFILE = 0xFB,
	UINT16 = 0xFC,
	UINT24 = 0xFD,
	UINT64 = 0xFE,
}

export const enum FieldType
{	MYSQL_TYPE_DECIMAL		= 0, // decimal, numeric
	MYSQL_TYPE_TINY			= 1, // tinyint
	MYSQL_TYPE_SHORT		= 2, // smallint
	MYSQL_TYPE_LONG			= 3, // integer
	MYSQL_TYPE_FLOAT		= 4, // float
	MYSQL_TYPE_DOUBLE		= 5, // double, real
	MYSQL_TYPE_NULL			= 6, // NULL
	MYSQL_TYPE_TIMESTAMP	= 7, // timestamp
	MYSQL_TYPE_LONGLONG		= 8, // bigint
	MYSQL_TYPE_INT24		= 9, // mediumint
	MYSQL_TYPE_DATE			= 10, // date
	MYSQL_TYPE_TIME			= 11, // time
	MYSQL_TYPE_DATETIME		= 12, // datetime
	MYSQL_TYPE_YEAR			= 13, // year
	//MYSQL_TYPE_NEWDATE	= 14, // Internal to MySQL Server. Not used in ProtocolBinary::* nor ProtocolText::*.
	MYSQL_TYPE_VARCHAR		= 15,
	MYSQL_TYPE_BIT			= 16, // bit
	//MYSQL_TYPE_TIMESTAMP2	= 17, // Internal to MySQL Server. Not used in ProtocolBinary::* nor ProtocolText::*.
	//MYSQL_TYPE_DATETIME2	= 18, // Internal to MySQL Server. Not used in ProtocolBinary::* nor ProtocolText::*.
	//MYSQL_TYPE_TIME2		= 19, // Internal to MySQL Server. Not used in ProtocolBinary::* nor ProtocolText::*.
	MYSQL_TYPE_JSON			= 245, // json
	MYSQL_TYPE_NEWDECIMAL	= 246,
	MYSQL_TYPE_ENUM			= 247, // enum
	MYSQL_TYPE_SET			= 248, // set
	MYSQL_TYPE_TINY_BLOB	= 249, // tinyblob, tinytext
	MYSQL_TYPE_MEDIUM_BLOB	= 250, // mediumblob, mediumtext
	MYSQL_TYPE_LONG_BLOB	= 251, // longblob, longtext
	MYSQL_TYPE_BLOB			= 252, // blob, text
	MYSQL_TYPE_VAR_STRING	= 253, // varchar, varbinary
	MYSQL_TYPE_STRING		= 254, // char, binary
	MYSQL_TYPE_GEOMETRY		= 255,
}

export const enum ColumnFlags
{	NOT_NULL = 1, // Field can't be NULL
	PRI_KEY = 2, // Field is part of a primary key
	UNIQUE_KEY = 4, // Field is part of a unique key
	MULTIPLE_KEY = 8, // Field is part of a key
	BLOB = 16, // Field is a blob
	UNSIGNED = 32, // Field is unsigned
	ZEROFILL = 64, // Field is zerofill
	BINARY = 128, // Field is binary
	ENUM = 256, // Field is an enum
	AUTO_INCREMENT = 512, // Field is a autoincrement field
	TIMESTAMP = 1024, // Field is a timestamp
	SET = 2048, // Field is a set
	NO_DEFAULT_VALUE = 4096, // Field doesn't have default value
	ON_UPDATE_NOW = 8192, // Field is set to NOW on UPDATE
	NUM = 32768, // Field is num (for clients)
	PART_KEY = 16384, // Intern; Part of some key
	GROUP = 32768, // Intern: Group field
	UNIQUE = 65536, // Intern: Used by sql_yacc
	BINCMP = 131072, // Intern: Used by sql_yacc
	GET_FIXED_FIELDS = 1 << 18, // Used to get fields in item tree
	FIELD_IN_PART_FUNC = 1 << 19, // Field part of partition func
	FIELD_IN_ADD_INDEX = 1 << 20, // Intern: Field in TABLE object for new version of altered table, which participates in a newly added index
	FIELD_IS_RENAMED = 1 << 21, // Intern: Field is being renamed
	STORAGE_MEDIA = 3 << 22, // Field storage media
	COLUMN_FORMAT = 3 << 24, // Field column format
	FIELD_IS_DROPPED = 1 << 26, // Intern: Field is being dropped
	EXPLICIT_NULL = 1 << 27, // Field is explicitly specified as NULL by the user
	NOT_SECONDARY = 1 << 29, // Field will not be loaded in secondary engine
	FIELD_IS_INVISIBLE = 1 << 30, // Field is explicitly marked as invisible by the user
}

export const enum Command
{	COM_SLEEP = 0,
	COM_QUIT,
	COM_INIT_DB,
	COM_QUERY,
	COM_FIELD_LIST,
	COM_CREATE_DB,
	COM_DROP_DB,
	COM_REFRESH,
	COM_SHUTDOWN,
	COM_STATISTICS,
	COM_PROCESS_INFO,
	COM_CONNECT,
	COM_PROCESS_KILL,
	COM_DEBUG,
	COM_PING,
	COM_TIME,
	COM_DELAYED_INSERT,
	COM_CHANGE_USER,
	COM_BINLOG_DUMP,
	COM_TABLE_DUMP,
	COM_CONNECT_OUT,
	COM_REGISTER_SLAVE,
	COM_STMT_PREPARE,
	COM_STMT_EXECUTE,
	COM_STMT_SEND_LONG_DATA,
	COM_STMT_CLOSE,
	COM_STMT_RESET,
	COM_SET_OPTION,
	COM_STMT_FETCH,
	COM_DAEMON,
	COM_BINLOG_DUMP_GTID,
	COM_RESET_CONNECTION,
	COM_STMT_EXECUTE_BATCH,
	COM_END,
}

export const enum CursorType
{	NO_CURSOR = 0,
	READ_ONLY = 1,
	FOR_UPDATE = 2,
	SCROLLABLE = 4,
}

export const enum SessionTrack
{	SYSTEM_VARIABLES,
	SCHEMA,
	STATE_CHANGE,
	GTIDS,
}

export const enum Charset
{	UNKNOWN					= 0,
	BIG5_CHINESE_CI			= 1,
	LATIN2_CZECH_CS			= 2,
	DEC8_SWEDISH_CI			= 3,
	CP850_GENERAL_CI		= 4,
	LATIN1_GERMAN1_CI		= 5,
	HP8_ENGLISH_CI			= 6,
	KOI8R_GENERAL_CI		= 7,
	LATIN1_SWEDISH_CI		= 8,
	LATIN2_GENERAL_CI		= 9,
	SWE7_SWEDISH_CI			= 10,
	ASCII_GENERAL_CI		= 11,
	UJIS_JAPANESE_CI		= 12,
	SJIS_JAPANESE_CI		= 13,
	CP1251_BULGARIAN_CI		= 14,
	LATIN1_DANISH_CI		= 15,
	HEBREW_GENERAL_CI		= 16,
	TIS620_THAI_CI			= 18,
	EUCKR_KOREAN_CI			= 19,
	LATIN7_ESTONIAN_CS		= 20,
	LATIN2_HUNGARIAN_CI		= 21,
	KOI8U_GENERAL_CI		= 22,
	CP1251_UKRAINIAN_CI		= 23,
	GB2312_CHINESE_CI		= 24,
	GREEK_GENERAL_CI		= 25,
	CP1250_GENERAL_CI		= 26,
	LATIN2_CROATIAN_CI		= 27,
	GBK_CHINESE_CI			= 28,
	CP1257_LITHUANIAN_CI	= 29,
	LATIN5_TURKISH_CI		= 30,
	LATIN1_GERMAN2_CI		= 31,
	ARMSCII8_GENERAL_CI		= 32,
	UTF8_GENERAL_CI			= 33,
	CP1250_CZECH_CS			= 34,
	UCS2_GENERAL_CI			= 35,
	CP866_GENERAL_CI		= 36,
	KEYBCS2_GENERAL_CI		= 37,
	MACCE_GENERAL_CI		= 38,
	MACROMAN_GENERAL_CI		= 39,
	CP852_GENERAL_CI		= 40,
	LATIN7_GENERAL_CI		= 41,
	LATIN7_GENERAL_CS		= 42,
	MACCE_BIN				= 43,
	CP1250_CROATIAN_CI		= 44,
	UTF8MB4_GENERAL_CI		= 45,
	UTF8MB4_BIN				= 46,
	LATIN1_BIN				= 47,
	LATIN1_GENERAL_CI		= 48,
	LATIN1_GENERAL_CS		= 49,
	CP1251_BIN				= 50,
	CP1251_GENERAL_CI		= 51,
	CP1251_GENERAL_CS		= 52,
	MACROMAN_BIN			= 53,
	UTF16_GENERAL_CI		= 54,
	UTF16_BIN				= 55,
	UTF16LE_GENERAL_CI		= 56,
	CP1256_GENERAL_CI		= 57,
	CP1257_BIN				= 58,
	CP1257_GENERAL_CI		= 59,
	UTF32_GENERAL_CI		= 60,
	UTF32_BIN				= 61,
	UTF16LE_BIN				= 62,
	BINARY					= 63,
	ARMSCII8_BIN			= 64,
	ASCII_BIN				= 65,
	CP1250_BIN				= 66,
	CP1256_BIN				= 67,
	CP866_BIN				= 68,
	DEC8_BIN				= 69,
	GREEK_BIN				= 70,
	HEBREW_BIN				= 71,
	HP8_BIN					= 72,
	KEYBCS2_BIN				= 73,
	KOI8R_BIN				= 74,
	KOI8U_BIN				= 75,
	UTF8_TOLOWER_CI			= 76,
	LATIN2_BIN				= 77,
	LATIN5_BIN				= 78,
	LATIN7_BIN				= 79,
	CP850_BIN				= 80,
	CP852_BIN				= 81,
	SWE7_BIN				= 82,
	UTF8_BIN				= 83,
	BIG5_BIN				= 84,
	EUCKR_BIN				= 85,
	GB2312_BIN				= 86,
	GBK_BIN					= 87,
	SJIS_BIN				= 88,
	TIS620_BIN				= 89,
	UCS2_BIN				= 90,
	UJIS_BIN				= 91,
	GEOSTD8_GENERAL_CI		= 92,
	GEOSTD8_BIN				= 93,
	LATIN1_SPANISH_CI		= 94,
	CP932_JAPANESE_CI		= 95,
	CP932_BIN				= 96,
	EUCJPMS_JAPANESE_CI		= 97,
	EUCJPMS_BIN				= 98,
	CP1250_POLISH_CI		= 99,
	UTF16_UNICODE_CI		= 101,
	UTF16_ICELANDIC_CI		= 102,
	UTF16_LATVIAN_CI		= 103,
	UTF16_ROMANIAN_CI		= 104,
	UTF16_SLOVENIAN_CI		= 105,
	UTF16_POLISH_CI			= 106,
	UTF16_ESTONIAN_CI		= 107,
	UTF16_SPANISH_CI		= 108,
	UTF16_SWEDISH_CI		= 109,
	UTF16_TURKISH_CI		= 110,
	UTF16_CZECH_CI			= 111,
	UTF16_DANISH_CI			= 112,
	UTF16_LITHUANIAN_CI		= 113,
	UTF16_SLOVAK_CI			= 114,
	UTF16_SPANISH2_CI		= 115,
	UTF16_ROMAN_CI			= 116,
	UTF16_PERSIAN_CI		= 117,
	UTF16_ESPERANTO_CI		= 118,
	UTF16_HUNGARIAN_CI		= 119,
	UTF16_SINHALA_CI		= 120,
	UTF16_GERMAN2_CI		= 121,
	UTF16_CROATIAN_CI		= 122,
	UTF16_UNICODE_520_CI	= 123,
	UTF16_VIETNAMESE_CI		= 124,
	UCS2_UNICODE_CI			= 128,
	UCS2_ICELANDIC_CI		= 129,
	UCS2_LATVIAN_CI			= 130,
	UCS2_ROMANIAN_CI		= 131,
	UCS2_SLOVENIAN_CI		= 132,
	UCS2_POLISH_CI			= 133,
	UCS2_ESTONIAN_CI		= 134,
	UCS2_SPANISH_CI			= 135,
	UCS2_SWEDISH_CI			= 136,
	UCS2_TURKISH_CI			= 137,
	UCS2_CZECH_CI			= 138,
	UCS2_DANISH_CI			= 139,
	UCS2_LITHUANIAN_CI		= 140,
	UCS2_SLOVAK_CI			= 141,
	UCS2_SPANISH2_CI		= 142,
	UCS2_ROMAN_CI			= 143,
	UCS2_PERSIAN_CI			= 144,
	UCS2_ESPERANTO_CI		= 145,
	UCS2_HUNGARIAN_CI		= 146,
	UCS2_SINHALA_CI			= 147,
	UCS2_GERMAN2_CI			= 148,
	UCS2_CROATIAN_CI		= 149,
	UCS2_UNICODE_520_CI		= 150,
	UCS2_VIETNAMESE_CI		= 151,
	UCS2_GENERAL_MYSQL500_CI= 159,
	UTF32_UNICODE_CI		= 160,
	UTF32_ICELANDIC_CI		= 161,
	UTF32_LATVIAN_CI		= 162,
	UTF32_ROMANIAN_CI		= 163,
	UTF32_SLOVENIAN_CI		= 164,
	UTF32_POLISH_CI			= 165,
	UTF32_ESTONIAN_CI		= 166,
	UTF32_SPANISH_CI		= 167,
	UTF32_SWEDISH_CI		= 168,
	UTF32_TURKISH_CI		= 169,
	UTF32_CZECH_CI			= 170,
	UTF32_DANISH_CI			= 171,
	UTF32_LITHUANIAN_CI		= 172,
	UTF32_SLOVAK_CI			= 173,
	UTF32_SPANISH2_CI		= 174,
	UTF32_ROMAN_CI			= 175,
	UTF32_PERSIAN_CI		= 176,
	UTF32_ESPERANTO_CI		= 177,
	UTF32_HUNGARIAN_CI		= 178,
	UTF32_SINHALA_CI		= 179,
	UTF32_GERMAN2_CI		= 180,
	UTF32_CROATIAN_CI		= 181,
	UTF32_UNICODE_520_CI	= 182,
	UTF32_VIETNAMESE_CI		= 183,
	UTF8_UNICODE_CI			= 192,
	UTF8_ICELANDIC_CI		= 193,
	UTF8_LATVIAN_CI			= 194,
	UTF8_ROMANIAN_CI		= 195,
	UTF8_SLOVENIAN_CI		= 196,
	UTF8_POLISH_CI			= 197,
	UTF8_ESTONIAN_CI		= 198,
	UTF8_SPANISH_CI			= 199,
	UTF8_SWEDISH_CI			= 200,
	UTF8_TURKISH_CI			= 201,
	UTF8_CZECH_CI			= 202,
	UTF8_DANISH_CI			= 203,
	UTF8_LITHUANIAN_CI		= 204,
	UTF8_SLOVAK_CI			= 205,
	UTF8_SPANISH2_CI		= 206,
	UTF8_ROMAN_CI			= 207,
	UTF8_PERSIAN_CI			= 208,
	UTF8_ESPERANTO_CI		= 209,
	UTF8_HUNGARIAN_CI		= 210,
	UTF8_SINHALA_CI			= 211,
	UTF8_GERMAN2_CI			= 212,
	UTF8_CROATIAN_CI		= 213,
	UTF8_UNICODE_520_CI		= 214,
	UTF8_VIETNAMESE_CI		= 215,
	UTF8_GENERAL_MYSQL500_CI= 223,
	UTF8MB4_UNICODE_CI		= 224,
	UTF8MB4_ICELANDIC_CI	= 225,
	UTF8MB4_LATVIAN_CI		= 226,
	UTF8MB4_ROMANIAN_CI		= 227,
	UTF8MB4_SLOVENIAN_CI	= 228,
	UTF8MB4_POLISH_CI		= 229,
	UTF8MB4_ESTONIAN_CI		= 230,
	UTF8MB4_SPANISH_CI		= 231,
	UTF8MB4_SWEDISH_CI		= 232,
	UTF8MB4_TURKISH_CI		= 233,
	UTF8MB4_CZECH_CI		= 234,
	UTF8MB4_DANISH_CI		= 235,
	UTF8MB4_LITHUANIAN_CI	= 236,
	UTF8MB4_SLOVAK_CI		= 237,
	UTF8MB4_SPANISH2_CI		= 238,
	UTF8MB4_ROMAN_CI		= 239,
	UTF8MB4_PERSIAN_CI		= 240,
	UTF8MB4_ESPERANTO_CI	= 241,
	UTF8MB4_HUNGARIAN_CI	= 242,
	UTF8MB4_SINHALA_CI		= 243,
	UTF8MB4_GERMAN2_CI		= 244,
	UTF8MB4_CROATIAN_CI		= 245,
	UTF8MB4_UNICODE_520_CI	= 246,
	UTF8MB4_VIETNAMESE_CI	= 247,
	GB18030_CHINESE_CI		= 248,
	GB18030_BIN				= 249,
	GB18030_UNICODE_520_CI	= 250,
	UTF8MB4_0900_AI_CI		= 255,
	UTF8MB4_DE_PB_0900_AI_CI= 256,
	UTF8MB4_IS_0900_AI_CI	= 257,
	UTF8MB4_LV_0900_AI_CI	= 258,
	UTF8MB4_RO_0900_AI_CI	= 259,
	UTF8MB4_SL_0900_AI_CI	= 260,
	UTF8MB4_PL_0900_AI_CI	= 261,
	UTF8MB4_ET_0900_AI_CI	= 262,
	UTF8MB4_ES_0900_AI_CI	= 263,
	UTF8MB4_SV_0900_AI_CI	= 264,
	UTF8MB4_TR_0900_AI_CI	= 265,
	UTF8MB4_CS_0900_AI_CI	= 266,
	UTF8MB4_DA_0900_AI_CI	= 267,
	UTF8MB4_LT_0900_AI_CI	= 268,
	UTF8MB4_SK_0900_AI_CI	= 269,
	UTF8MB4_ES_TRAD_0900_AI_CI= 270,
	UTF8MB4_LA_0900_AI_CI	= 271,
	UTF8MB4_EO_0900_AI_CI	= 273,
	UTF8MB4_HU_0900_AI_CI	= 274,
	UTF8MB4_HR_0900_AI_CI	= 275,
	UTF8MB4_VI_0900_AI_CI	= 277,
	UTF8MB4_0900_AS_CS		= 278,
	UTF8MB4_DE_PB_0900_AS_CS= 279,
	UTF8MB4_IS_0900_AS_CS	= 280,
	UTF8MB4_LV_0900_AS_CS	= 281,
	UTF8MB4_RO_0900_AS_CS	= 282,
	UTF8MB4_SL_0900_AS_CS	= 283,
	UTF8MB4_PL_0900_AS_CS	= 284,
	UTF8MB4_ET_0900_AS_CS	= 285,
	UTF8MB4_ES_0900_AS_CS	= 286,
	UTF8MB4_SV_0900_AS_CS	= 287,
	UTF8MB4_TR_0900_AS_CS	= 288,
	UTF8MB4_CS_0900_AS_CS	= 289,
	UTF8MB4_DA_0900_AS_CS	= 290,
	UTF8MB4_LT_0900_AS_CS	= 291,
	UTF8MB4_SK_0900_AS_CS	= 292,
	UTF8MB4_ES_TRAD_0900_AS_CS= 293,
	UTF8MB4_LA_0900_AS_CS	= 294,
	UTF8MB4_EO_0900_AS_CS	= 296,
	UTF8MB4_HU_0900_AS_CS	= 297,
	UTF8MB4_HR_0900_AS_CS	= 298,
	UTF8MB4_VI_0900_AS_CS	= 300,
	UTF8MB4_JA_0900_AS_CS	= 303,
	UTF8MB4_JA_0900_AS_CS_KS= 304,
	UTF8MB4_0900_AS_CI		= 305,
	UTF8MB4_RU_0900_AI_CI	= 306,
	UTF8MB4_RU_0900_AS_CS	= 307,
	UTF8MB4_ZH_0900_AS_CS	= 308,
	UTF8MB4_0900_BIN		= 309
}
