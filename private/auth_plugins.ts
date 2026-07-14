import {Dsn, publicKeyToBase64} from "./dsn.ts";
import {MyProtocol} from "./my_protocol.ts";
import {ed25519Sign} from "./ed25519.ts";

const encoder = new TextEncoder;
const decoder = new TextDecoder;

export class AuthPlugin
{	protected constructor(public name: string, protected scramble: Uint8Array, protected dsn: Dsn)
	{
	}

	static inst(name: string, scramble: Uint8Array, dsn: Dsn): AuthPlugin
	{	switch (name)
		{	case 'mysql_native_password': return new AuthPluginMysqlNativePassword(name, scramble, dsn);
			case 'caching_sha2_password': return new AuthPluginCachingSha2Password(name, scramble, dsn);
			case 'sha256_password': return new AuthPluginSha256Password(name, scramble, dsn);
			case 'mysql_clear_password': return new AuthPluginMysqlClearPassword(name, scramble, dsn);
			case 'client_ed25519': return new AuthPluginClientEd25519(name, scramble, dsn);
			case 'parsec': return new AuthPluginParsec(name, scramble, dsn);
		}
		throw new Error(`Authentication plugin is not supported: ${name}`);
	}

	/**	True when the transport cannot be eavesdropped: currently only Unix-domain socket.
		When TLS support is added, this is the single place that must recognize it.
	 **/
	protected get isConnectionTrusted()
	{	return !!this.dsn.pipe;
	}

	quickAuth(_password: string): Promise<Uint8Array>
	{	throw new Error('Not implemented');
	}

	progress(_password: string, _packetType: number, _packetData: Uint8Array, _writer: MyProtocol): Promise<boolean>
	{	throw new Error('Not implemented');
	}
}

async function hash(algorithm: AlgorithmIdentifier, data: Uint8Array<ArrayBuffer>)
{	return new Uint8Array(await crypto.subtle.digest(algorithm, data));
}

function appendZeroByte(data: Uint8Array)
{	const result = new Uint8Array(data.length + 1);
	result.set(data);
	return result;
}

function xor(a: Uint8Array, b: Uint8Array)
{	// The MySQL caching_sha2_password full-auth flow XORs the password with the scramble, repeating the scramble as needed (passwords longer than the scramble would otherwise leave their tail un-XORed).
	const bLen = b.length;
	for (let i=0, iEnd=a.length; i<iEnd; i++)
	{	a[i] ^= b[i % bLen];
	}
}

function strToBytes(str: string)
{	const bufView = new Uint8Array(str.length);
	for (let i=0, iEnd=str.length; i<iEnd; i++)
	{	bufView[i] = str.charCodeAt(i);
	}
	return bufView;
}

/**	Encrypts `password + "\0"` XORed with the scramble, using the server RSA public key (RSA-OAEP SHA-1).
	`publicKeyBase64` is the key in SPKI DER form, base64-encoded (PEM without the armor).
	This is how both `caching_sha2_password` and `sha256_password` protect the password on an unencrypted connection.
 **/
async function encryptPassword(password: string, scramble: Uint8Array, publicKeyBase64: string)
{	const stage1 = appendZeroByte(encoder.encode(password));
	xor(stage1, scramble);
	const publicKeyObj = await crypto.subtle.importKey('spki', strToBytes(atob(publicKeyBase64)), {name: 'RSA-OAEP', hash: 'SHA-1'}, true, ['encrypt']);
	return new Uint8Array(await crypto.subtle.encrypt({name: 'RSA-OAEP'}, publicKeyObj, stage1));
}

class AuthPluginMysqlNativePassword extends AuthPlugin
{	override async quickAuth(password: string)
	{	if (!password)
		{	return new Uint8Array;
		}
		const pwd1 = new Uint8Array(await crypto.subtle.digest('SHA-1', encoder.encode(password)));
		const pwd2 = new Uint8Array(await crypto.subtle.digest('SHA-1', pwd1));

		let seedAndPwd2 = new Uint8Array(this.scramble.length + pwd2.length);
		seedAndPwd2.set(this.scramble);
		seedAndPwd2.set(pwd2, this.scramble.length);
		seedAndPwd2 = new Uint8Array(await crypto.subtle.digest('SHA-1', seedAndPwd2));

		xor(seedAndPwd2, pwd1);

		return seedAndPwd2;
	}
}

const enum State
{	Initial,
	Encrypt,
	Done,
}
const enum AuthStatusFlags
{	FastPath = 3,
	FullAuth = 4,
}
const REQUEST_PUBLIC_KEY = 2;

class AuthPluginCachingSha2Password extends AuthPlugin
{	#state = State.Initial;

	override async quickAuth(password: string)
	{	if (!password)
		{	return new Uint8Array;
		}
		const stage1 = await hash('SHA-256', encoder.encode(password));
		const stage2 = await hash('SHA-256', stage1);
		const buffer = new Uint8Array(stage2.length + this.scramble.length);
		buffer.set(stage2);
		buffer.set(this.scramble, stage2.length);
		const stage3 = await hash('SHA-256', buffer);

		xor(stage1, stage3);

		return stage1;
	}

	override async progress(password: string, _packetType: number, packetData: Uint8Array, writer: MyProtocol)
	{	switch (this.#state)
		{	case State.Initial:
			{	const statusFlag = packetData[0];
				if (statusFlag == AuthStatusFlags.FastPath)
				{	this.#state = State.Done;
					return false;
				}
				else if (statusFlag == AuthStatusFlags.FullAuth)
				{	if (this.dsn.serverPublicKey)
					{	// The user pinned the trusted server public key, so no need to request it from the server
						await writer.authSendBytesPacket(await encryptPassword(password, this.scramble, this.dsn.serverPublicKey));
						this.#state = State.Done;
						return false;
					}
					if (!this.isConnectionTrusted && !this.dsn.allowPublicKeyRetrieval)
					{	// Requesting the key through untrusted TCP connection allows an active MITM to substitute the key, and to decrypt the password
						throw new Error
						(	`The server requested 'caching_sha2_password' full authentication, that requires the server RSA public key, but the connection is not secure (TCP without TLS). Options: `+
							`1) add 'allowPublicKeyRetrieval' parameter to the DSN to retrieve the key from the server (vulnerable to man-in-the-middle attacks); `+
							`2) pin the trusted key in 'serverPublicKey' DSN parameter (you can get the key by executing: SHOW STATUS LIKE 'Caching_sha2_password_rsa_public_key'); `+
							`3) connect through Unix-domain socket.`
						);
					}
					await writer.authSendUint8Packet(REQUEST_PUBLIC_KEY);
					this.#state = State.Encrypt;
					return false;
				}
				else
				{	throw new Error(`Couldn't authenticate with this method`);
				}
			}
			case State.Encrypt:
			{	const publicKey = publicKeyToBase64(decoder.decode(packetData));
				await writer.authSendBytesPacket(await encryptPassword(password, this.scramble, publicKey));
				this.#state = State.Done;
				return false;
			}
			case State.Done:
			{	return true;
			}
		}
	}
}

const REQUEST_PUBLIC_KEY_SHA256 = 1;

/**	Legacy MySQL plugin (5.6 to 8.x), predecessor of `caching_sha2_password`.
	There's no fast path: on an untrusted connection the password is always RSA-encrypted with the server public key,
	and on a trusted one it's sent in clear text (nul-terminated).
 **/
class AuthPluginSha256Password extends AuthPlugin
{	#state = State.Initial;

	override async quickAuth(password: string)
	{	if (!password)
		{	this.#state = State.Done;
			return new Uint8Array;
		}
		if (this.isConnectionTrusted)
		{	this.#state = State.Done;
			return appendZeroByte(encoder.encode(password));
		}
		if (this.dsn.serverPublicKey)
		{	this.#state = State.Done;
			return await encryptPassword(password, this.scramble, this.dsn.serverPublicKey);
		}
		if (!this.dsn.allowPublicKeyRetrieval)
		{	throw new Error
			(	`The server requested 'sha256_password' authentication, that requires the server RSA public key, but the connection is not secure (TCP without TLS). Options: `+
				`1) add 'allowPublicKeyRetrieval' parameter to the DSN to retrieve the key from the server (vulnerable to man-in-the-middle attacks); `+
				`2) pin the trusted key in 'serverPublicKey' DSN parameter (you can get the key by executing: SHOW STATUS LIKE 'Rsa_public_key'); `+
				`3) connect through Unix-domain socket.`
			);
		}
		// Request the public key from the server (the server will send it, and `progress()` will do the encryption)
		this.#state = State.Encrypt;
		return Uint8Array.of(REQUEST_PUBLIC_KEY_SHA256);
	}

	override async progress(password: string, _packetType: number, packetData: Uint8Array, writer: MyProtocol)
	{	switch (this.#state)
		{	case State.Encrypt:
			{	const publicKey = publicKeyToBase64(decoder.decode(packetData));
				await writer.authSendBytesPacket(await encryptPassword(password, this.scramble, publicKey));
				this.#state = State.Done;
				return false;
			}
			case State.Done:
			{	return true;
			}
			default:
			{	throw new Error(`Couldn't authenticate with this method`);
			}
		}
	}
}

/**	Sends the password in clear text (nul-terminated).
	The server side uses this when the actual password check is delegated, like PAM or LDAP.
 **/
class AuthPluginMysqlClearPassword extends AuthPlugin
{	override quickAuth(password: string)
	{	if (!this.isConnectionTrusted && !this.dsn.allowCleartextPasswords)
		{	throw new Error
			(	`The server requested 'mysql_clear_password' authentication, that sends the password in clear text, but the connection is not secure (TCP without TLS). Options: `+
				`1) add 'allowCleartextPasswords' parameter to the DSN, if the network path to the server is trusted; `+
				`2) connect through Unix-domain socket.`
			);
		}
		return Promise.resolve(appendZeroByte(encoder.encode(password)));
	}
}

/**	MariaDB Ed25519 authentication: the server sends a 32-byte nonce, and the client signs it, using the password bytes as the Ed25519 seed.
 **/
class AuthPluginClientEd25519 extends AuthPlugin
{	override async quickAuth(password: string)
	{	// Sign exactly 32 bytes (a trailing nul byte can follow the nonce in the auth switch packet)
		return await ed25519Sign(encoder.encode(password), this.scramble.subarray(0, 32));
	}
}

const PARSEC_EXT_SALT_PREFIX = 0x50; // 'P'
const PARSEC_ITER_FACTOR_MAX = 20;

/**	MariaDB PARSEC authentication (MariaDB 11.6+).
	The server sends a 32-byte scramble. The client answers with an empty packet, asking for the extended salt,
	that comes as `'P' + iterations factor + salt`. The password is then stretched with PBKDF2-HMAC-SHA512 to get a 32-byte Ed25519 seed,
	and the client signs `server scramble + client scramble`, sending back `client scramble + signature`.
	Verified against the reference implementation: https://github.com/mariadb-corporation/mariadb-connector-c/blob/master/plugins/auth/parsec.c
 **/
class AuthPluginParsec extends AuthPlugin
{	#state = State.Initial;

	override quickAuth(_password: string)
	{	// Empty response asks the server to send the extended salt
		return Promise.resolve(new Uint8Array);
	}

	override async progress(password: string, _packetType: number, packetData: Uint8Array, writer: MyProtocol)
	{	switch (this.#state)
		{	case State.Initial:
			{	if (packetData.length<3 || packetData[0]!=PARSEC_EXT_SALT_PREFIX)
				{	throw new Error(`Server sent invalid extended salt during 'parsec' authentication`);
				}
				const iterFactor = packetData[1];
				if (iterFactor > PARSEC_ITER_FACTOR_MAX)
				{	throw new Error(`Server requested too many PBKDF2 iterations during 'parsec' authentication`);
				}
				const iterations = 1024 << iterFactor;
				const salt = packetData.slice(2);
				const passwordKey = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
				const seed = new Uint8Array(await crypto.subtle.deriveBits({name: 'PBKDF2', hash: 'SHA-512', salt, iterations}, passwordKey, 256));
				const clientScramble = crypto.getRandomValues(new Uint8Array(32));
				const message = new Uint8Array(64);
				message.set(this.scramble.subarray(0, 32));
				message.set(clientScramble, 32);
				const signature = await ed25519Sign(seed, message);
				const response = new Uint8Array(96);
				response.set(clientScramble);
				response.set(signature, 32);
				await writer.authSendBytesPacket(response);
				this.#state = State.Done;
				return false;
			}
			case State.Done:
			{	return true;
			}
			default:
			{	throw new Error(`Couldn't authenticate with this method`);
			}
		}
	}
}
