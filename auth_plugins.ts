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

	quick_auth(password: string): Uint8Array
	{	throw new Error('Not implemented');
	}

	progress(password: string, packet_type: number, packet_data: Uint8Array, writer: MyProtocol): Promise<boolean>
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
{	quick_auth(password: string)
	{	const pwd_1 = hash('sha1', encoder.encode(password));
		const pwd_2 = hash('sha1', pwd_1);

		let seed_and_pwd_2 = new Uint8Array(this.scramble.length + pwd_2.length);
		seed_and_pwd_2.set(this.scramble);
		seed_and_pwd_2.set(pwd_2, this.scramble.length);
		seed_and_pwd_2 = hash('sha1', seed_and_pwd_2);

		return xor(seed_and_pwd_2, pwd_1);
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

	quick_auth(password: string)
	{	const stage_1 = hash('sha256', encoder.encode(password));
		const stage_2 = hash('sha256', stage_1);
		const buffer = new Uint8Array(stage_2.length + this.scramble.length);
		buffer.set(stage_2);
		buffer.set(this.scramble, stage_2.length);
		const stage_3 = hash('sha256', buffer);

		return xor(stage_1, stage_3);
	}

	async progress(password: string, packet_type: number, packet_data: Uint8Array, writer: MyProtocol)
	{	switch (this.state)
		{	case State.Initial:
			{	let status_flag = packet_data[0];
				if (status_flag == AuthStatusFlags.FastPath)
				{	this.state = State.Done;
					return false;
				}
				else if (status_flag == AuthStatusFlags.FullAuth)
				{	await writer.send_uint8_packet(REQUEST_PUBLIC_KEY);
					this.state = State.Encrypt;
					return false;
				}
				else
				{	throw new Error(`Couldn't authenticate with this method`);
				}
			}
			case State.Encrypt:
			{	let public_key = decoder.decode(packet_data);
				const stage_1 = xor(encoder.encode(password), this.scramble);
				let encrypted_password = RSA.encrypt(stage_1, RSA.parseKey(public_key));
				await writer.send_bytes_packet(encrypted_password);
				this.state = State.Done;
				return false;
			}
			case State.Done:
			{	return true;
			}
		}
	}
}
