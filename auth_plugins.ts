import {MyProtocol} from "./my_protocol.ts";
import {createHash, SupportedAlgorithm, RSA} from './deps.ts';

const encoder = new TextEncoder;
const decoder = new TextDecoder;

export class AuthPlugin
{	constructor(public name: string, protected scramble: Uint8Array)
	{
	}

	static inst(name: string, scramble: Uint8Array): AuthPlugin
	{	switch (name)
		{	case 'mysql_native_password': return new AuthPluginMysqlNativePassword(name, scramble);
			case 'caching_sha2_password': return new AuthPluginCachingSha2Password(name, scramble);
		}
		throw new Error(`Authentication plugin is not supported: ${name}`);
	}

	quickAuth(_password: string): Uint8Array
	{	throw new Error('Not implemented');
	}

	progress(_password: string, _packetType: number, _packetData: Uint8Array, _writer: MyProtocol): Promise<boolean>
	{	throw new Error('Not implemented');
	}
}

function hash(algorithm: SupportedAlgorithm, data: Uint8Array)
{	return new Uint8Array(createHash(algorithm).update(data).digest());
}

function xor(a: Uint8Array, b: Uint8Array)
{	return a.map((byte, index) => byte ^ b[index]);
}

class AuthPluginMysqlNativePassword extends AuthPlugin
{	quickAuth(password: string)
	{	const pwd1 = hash('sha1', encoder.encode(password));
		const pwd2 = hash('sha1', pwd1);

		let seedAndPwd2 = new Uint8Array(this.scramble.length + pwd2.length);
		seedAndPwd2.set(this.scramble);
		seedAndPwd2.set(pwd2, this.scramble.length);
		seedAndPwd2 = hash('sha1', seedAndPwd2);

		return xor(seedAndPwd2, pwd1);
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
const REQUEST_PUBLIC_KEY = 0x02;

class AuthPluginCachingSha2Password extends AuthPlugin
{	private state = State.Initial;

	quickAuth(password: string)
	{	const stage1 = hash('sha256', encoder.encode(password));
		const stage2 = hash('sha256', stage1);
		const buffer = new Uint8Array(stage2.length + this.scramble.length);
		buffer.set(stage2);
		buffer.set(this.scramble, stage2.length);
		const stage3 = hash('sha256', buffer);

		return xor(stage1, stage3);
	}

	async progress(password: string, _packetType: number, packetData: Uint8Array, writer: MyProtocol)
	{	switch (this.state)
		{	case State.Initial:
			{	const statusFlag = packetData[0];
				if (statusFlag == AuthStatusFlags.FastPath)
				{	this.state = State.Done;
					return false;
				}
				else if (statusFlag == AuthStatusFlags.FullAuth)
				{	await writer.sendUint8Packet(REQUEST_PUBLIC_KEY);
					this.state = State.Encrypt;
					return false;
				}
				else
				{	throw new Error(`Couldn't authenticate with this method`);
				}
			}
			case State.Encrypt:
			{	const publicKey = decoder.decode(packetData);
				const stage1 = xor(encoder.encode(password), this.scramble);
				const encryptedPassword = RSA.encrypt(stage1, RSA.parseKey(publicKey));
				await writer.sendBytesPacket(encryptedPassword);
				this.state = State.Done;
				return false;
			}
			case State.Done:
			{	return true;
			}
		}
	}
}
