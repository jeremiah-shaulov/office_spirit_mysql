import {MyProtocol} from "./my_protocol.ts";
import {RSA} from './deps.ts';

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

	quickAuth(_password: string): Promise<Uint8Array>
	{	throw new Error('Not implemented');
	}

	progress(_password: string, _packetType: number, _packetData: Uint8Array, _writer: MyProtocol): Promise<boolean>
	{	throw new Error('Not implemented');
	}
}

async function hash(algorithm: AlgorithmIdentifier, data: Uint8Array)
{	return new Uint8Array(await crypto.subtle.digest(algorithm, data));
}

function appendZeroByte(data: Uint8Array)
{	const result = new Uint8Array(data.length + 1);
	result.set(data);
	return result;
}

function xor(a: Uint8Array, b: Uint8Array)
{	for (let i=0, iEnd=a.length; i<iEnd; i++)
	{	a[i] ^= b[i];
	}
}

class AuthPluginMysqlNativePassword extends AuthPlugin
{	async quickAuth(password: string)
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
{	private state = State.Initial;

	async quickAuth(password: string)
	{	const stage1 = await hash('SHA-256', encoder.encode(password));
		const stage2 = await hash('SHA-256', stage1);
		const buffer = new Uint8Array(stage2.length + this.scramble.length);
		buffer.set(stage2);
		buffer.set(this.scramble, stage2.length);
		const stage3 = await hash('SHA-256', buffer);

		xor(stage1, stage3);

		return stage1;
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
				{	await writer.authSendUint8Packet(REQUEST_PUBLIC_KEY);
					this.state = State.Encrypt;
					return false;
				}
				else
				{	throw new Error(`Couldn't authenticate with this method`);
				}
			}
			case State.Encrypt:
			{	const publicKey = decoder.decode(packetData);
				const stage1 = appendZeroByte(encoder.encode(password));
				xor(stage1, this.scramble);
				const encryptedPassword = RSA.encrypt(stage1, RSA.parseKey(publicKey));
				await writer.authSendBytesPacket(encryptedPassword);
				this.state = State.Done;
				return false;
			}
			case State.Done:
			{	return true;
			}
		}
	}
}
