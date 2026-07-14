import {publicKeyToBase64} from "./dsn.ts";
import {MyProtocol} from "./my_protocol.ts";

const encoder = new TextEncoder;
const decoder = new TextDecoder;

export class AuthPlugin
{	protected constructor(public name: string, protected scramble: Uint8Array)
	{
	}

	static inst(name: string, scramble: Uint8Array): AuthPlugin
	{	switch (name)
		{	case 'mysql_native_password': return new AuthPluginMysqlNativePassword(name, scramble);
			case 'caching_sha2_password': return new AuthPluginCachingSha2Password(name, scramble);
		}
		throw new Error(`Authentication plugin is not supported: ${name}`);
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

class AuthPluginMysqlNativePassword extends AuthPlugin
{	override async quickAuth(password: string)
	{	const pwd1 = new Uint8Array(await crypto.subtle.digest('SHA-1', encoder.encode(password)));
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
	{	const stage1 = await hash('SHA-256', encoder.encode(password));
		const stage2 = await hash('SHA-256', stage1);
		const buffer = new Uint8Array(stage2.length + this.scramble.length);
		buffer.set(stage2);
		buffer.set(this.scramble, stage2.length);
		const stage3 = await hash('SHA-256', buffer);

		xor(stage1, stage3);

		return stage1;
	}

	/**	Encrypts `password + "\0"` XORed with the scramble, using the server RSA public key (RSA-OAEP SHA-1).
		`publicKeyBase64` is the key in SPKI DER form, base64-encoded (PEM without the armor).
	 **/
	async #encryptPassword(password: string, publicKeyBase64: string)
	{	const stage1 = appendZeroByte(encoder.encode(password));
		xor(stage1, this.scramble);
		const publicKeyObj = await crypto.subtle.importKey('spki', strToBytes(atob(publicKeyBase64)), {name: 'RSA-OAEP', hash: 'SHA-1'}, true, ['encrypt']);
		return new Uint8Array(await crypto.subtle.encrypt({name: 'RSA-OAEP'}, publicKeyObj, stage1));
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
				{	const {dsn} = writer;
					if (dsn.serverPublicKey)
					{	// The user pinned the trusted server public key, so no need to request it from the server
						await writer.authSendBytesPacket(await this.#encryptPassword(password, dsn.serverPublicKey));
						this.#state = State.Done;
						return false;
					}
					if (!dsn.pipe && !dsn.allowPublicKeyRetrieval)
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
				await writer.authSendBytesPacket(await this.#encryptPassword(password, publicKey));
				this.#state = State.Done;
				return false;
			}
			case State.Done:
			{	return true;
			}
		}
	}
}
