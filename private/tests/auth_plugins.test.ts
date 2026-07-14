import {AuthPlugin} from '../auth_plugins.ts';
import {Dsn} from '../dsn.ts';
import {ed25519PublicKey, ed25519Verify} from '../ed25519.ts';
import {assertEquals} from 'jsr:@std/assert@1.0.19/equals';
import {assert} from 'jsr:@std/assert@1.0.19/assert';

// deno-lint-ignore no-explicit-any
type Any = any;

const encoder = new TextEncoder;

/**	Captures packets that a plugin sends through `MyProtocol.authSendBytesPacket()` and `authSendUint8Packet()`.
 **/
class FakeWriter
{	sent = new Array<Uint8Array>;

	authSendBytesPacket(value: Uint8Array)
	{	this.sent.push(value.slice());
		return Promise.resolve();
	}

	authSendUint8Packet(value: number)
	{	this.sent.push(Uint8Array.of(value));
		return Promise.resolve();
	}
}

async function getError(fn: () => Promise<unknown>)
{	try
	{	await fn();
	}
	catch (e)
	{	return e instanceof Error ? e.message : e+'';
	}
	return '';
}

function xorWithScramble(data: Uint8Array, scramble: Uint8Array)
{	const result = data.slice();
	for (let i=0; i<result.length; i++)
	{	result[i] ^= scramble[i % scramble.length];
	}
	return result;
}

function randomScramble(len: number)
{	return crypto.getRandomValues(new Uint8Array(len));
}

const TCP_DSN = 'mysql://root@localhost/';
const PIPE_DSN = 'mysql://root@localhost/tmp/fake.sock/';

Deno.test
(	'Unknown plugin',
	() =>
	{	let error = '';
		try
		{	AuthPlugin.inst('mysql_old_password', randomScramble(20), new Dsn(TCP_DSN));
		}
		catch (e)
		{	error = e instanceof Error ? e.message : e+'';
		}
		assertEquals(error, 'Authentication plugin is not supported: mysql_old_password');
	}
);

Deno.test
(	'Empty password produces empty token in hash-based plugins',
	async () =>
	{	for (const name of ['mysql_native_password', 'caching_sha2_password'])
		{	const plugin = AuthPlugin.inst(name, randomScramble(20), new Dsn(TCP_DSN));
			assertEquals((await plugin.quickAuth('')).length, 0, name);
		}
	}
);

Deno.test
(	'mysql_clear_password',
	async () =>
	{	const scramble = randomScramble(20);
		// Refused through untrusted TCP
		let plugin = AuthPlugin.inst('mysql_clear_password', scramble, new Dsn(TCP_DSN));
		const error = await getError(() => plugin.quickAuth('pwd'));
		assert(error.includes('allowCleartextPasswords'), error);
		// Allowed with the opt-in parameter
		plugin = AuthPlugin.inst('mysql_clear_password', scramble, new Dsn(TCP_DSN+'?allowCleartextPasswords'));
		assertEquals(await plugin.quickAuth('pwd'), new Uint8Array([...encoder.encode('pwd'), 0]));
		// Allowed through Unix-domain socket without the parameter
		plugin = AuthPlugin.inst('mysql_clear_password', scramble, new Dsn(PIPE_DSN));
		assertEquals(await plugin.quickAuth('pwd'), new Uint8Array([...encoder.encode('pwd'), 0]));
		// Allowed through TLS without the parameter
		plugin = AuthPlugin.inst('mysql_clear_password', scramble, new Dsn(TCP_DSN+'?tls'));
		assertEquals(await plugin.quickAuth('pwd'), new Uint8Array([...encoder.encode('pwd'), 0]));
		// Empty password is only the nul terminator
		plugin = AuthPlugin.inst('mysql_clear_password', scramble, new Dsn(TCP_DSN+'?allowCleartextPasswords'));
		assertEquals(await plugin.quickAuth(''), new Uint8Array([0]));
	}
);

Deno.test
(	'caching_sha2_password full auth',
	async () =>
	{	const scramble = randomScramble(20);
		const password = 'pwd @אя';
		const fullAuthRequest = Uint8Array.of(4); // AuthStatusFlags.FullAuth

		// Refused through untrusted TCP without opt-in
		{	const plugin = AuthPlugin.inst('caching_sha2_password', scramble, new Dsn(TCP_DSN));
			const error = await getError(() => plugin.progress(password, 1, fullAuthRequest, new FakeWriter as Any));
			assert(error.includes('allowPublicKeyRetrieval'), error);
		}

		// Through trusted transport (pipe or TLS) the plain password is sent (nul-terminated)
		for (const dsnStr of [PIPE_DSN, TCP_DSN+'?tls'])
		{	const plugin = AuthPlugin.inst('caching_sha2_password', scramble, new Dsn(dsnStr));
			const writer = new FakeWriter;
			assertEquals(await plugin.progress(password, 1, fullAuthRequest, writer as Any), false);
			assertEquals(writer.sent, [new Uint8Array([...encoder.encode(password), 0])]);
			assertEquals(await plugin.progress(password, 0, new Uint8Array, writer as Any), true); // OK packet ends the flow
		}

		// Through untrusted TCP with the opt-in parameter the server public key is requested
		{	const plugin = AuthPlugin.inst('caching_sha2_password', scramble, new Dsn(TCP_DSN+'?allowPublicKeyRetrieval'));
			const writer = new FakeWriter;
			assertEquals(await plugin.progress(password, 1, fullAuthRequest, writer as Any), false);
			assertEquals(writer.sent, [Uint8Array.of(2)]); // REQUEST_PUBLIC_KEY
		}
	}
);

Deno.test
(	'sha256_password',
	async () =>
	{	const scramble = randomScramble(20);
		const password = '@אя pwd longer than the scramble to exercise the repeating XOR';
		const {publicKey, privateKey} = await crypto.subtle.generateKey({name: 'RSA-OAEP', hash: 'SHA-1', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1])}, true, ['encrypt', 'decrypt']);
		const publicKeyDer = new Uint8Array(await crypto.subtle.exportKey('spki', publicKey));
		const publicKeyBase64 = btoa(String.fromCharCode(...publicKeyDer));
		const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${publicKeyBase64}\n-----END PUBLIC KEY-----\n\0`; // MySQL terminates the key with a nul byte

		async function decryptToken(token: Uint8Array)
		{	const decrypted = new Uint8Array(await crypto.subtle.decrypt({name: 'RSA-OAEP'}, privateKey, token.slice()));
			return xorWithScramble(decrypted, scramble); // un-XOR back to `password + "\0"`
		}
		const passwordWithNul = new Uint8Array([...encoder.encode(password), 0]);

		// Refused through untrusted TCP without opt-in
		let plugin = AuthPlugin.inst('sha256_password', scramble, new Dsn(TCP_DSN));
		const error = await getError(() => plugin.quickAuth(password));
		assert(error.includes('allowPublicKeyRetrieval'), error);
		assert(error.includes("SHOW STATUS LIKE 'Rsa_public_key'"), error);

		// Empty password: empty token, done
		plugin = AuthPlugin.inst('sha256_password', scramble, new Dsn(TCP_DSN));
		assertEquals((await plugin.quickAuth('')).length, 0);

		// Trusted transport (pipe): clear text password + nul
		plugin = AuthPlugin.inst('sha256_password', scramble, new Dsn(PIPE_DSN));
		assertEquals(await plugin.quickAuth(password), passwordWithNul);

		// Trusted transport (TLS): clear text password + nul
		plugin = AuthPlugin.inst('sha256_password', scramble, new Dsn(TCP_DSN+'?tls'));
		assertEquals(await plugin.quickAuth(password), passwordWithNul);

		// Pinned public key: encrypted immediately
		{	const dsn = new Dsn(TCP_DSN);
			dsn.serverPublicKey = publicKeyPem;
			plugin = AuthPlugin.inst('sha256_password', scramble, dsn);
			const token = await plugin.quickAuth(password);
			assertEquals(await decryptToken(token), passwordWithNul);
		}

		// Public key retrieval: request byte, then encrypt what the server sends
		{	plugin = AuthPlugin.inst('sha256_password', scramble, new Dsn(TCP_DSN+'?allowPublicKeyRetrieval'));
			assertEquals(await plugin.quickAuth(password), Uint8Array.of(1));
			const writer = new FakeWriter;
			assertEquals(await plugin.progress(password, 1, encoder.encode(publicKeyPem), writer as Any), false);
			assertEquals(writer.sent.length, 1);
			assertEquals(await decryptToken(writer.sent[0]), passwordWithNul);
			assertEquals(await plugin.progress(password, 0, new Uint8Array, writer as Any), true); // OK packet ends the flow
		}
	}
);

Deno.test
(	'client_ed25519',
	async () =>
	{	const password = 'The pass @אя';
		const publicKey = await ed25519PublicKey(encoder.encode(password));
		// Signs the 32-byte nonce
		const scramble = randomScramble(32);
		let plugin = AuthPlugin.inst('client_ed25519', scramble, new Dsn(TCP_DSN));
		let token = await plugin.quickAuth(password);
		assertEquals(token.length, 64);
		assertEquals(await ed25519Verify(publicKey, scramble, token), true);
		// A trailing nul byte after the nonce must be ignored
		const scrambleWithNul = new Uint8Array([...scramble, 0]);
		plugin = AuthPlugin.inst('client_ed25519', scrambleWithNul, new Dsn(TCP_DSN));
		token = await plugin.quickAuth(password);
		assertEquals(await ed25519Verify(publicKey, scramble, token), true);
	}
);

Deno.test
(	'parsec',
	async () =>
	{	const password = 'The pass @אя';
		const serverScramble = randomScramble(32);
		const salt = randomScramble(18);
		const extSalt = new Uint8Array([0x50, 0, ...salt]); // 'P', iteration factor 0 (1024 iterations)

		const plugin = AuthPlugin.inst('parsec', serverScramble, new Dsn(TCP_DSN));
		// First response is empty: it asks for the extended salt
		assertEquals((await plugin.quickAuth(password)).length, 0);
		// Then the client scramble and the signature are sent
		const writer = new FakeWriter;
		assertEquals(await plugin.progress(password, 1, extSalt, writer as Any), false);
		assertEquals(writer.sent.length, 1);
		const response = writer.sent[0];
		assertEquals(response.length, 96);
		const clientScramble = response.subarray(0, 32);
		const signature = response.subarray(32);
		// Derive the same seed, and verify the signature over `server scramble + client scramble`
		const passwordKey = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
		const seed = new Uint8Array(await crypto.subtle.deriveBits({name: 'PBKDF2', hash: 'SHA-512', salt, iterations: 1024}, passwordKey, 256));
		const publicKey = await ed25519PublicKey(seed);
		const message = new Uint8Array([...serverScramble, ...clientScramble]);
		assertEquals(await ed25519Verify(publicKey, message, signature), true);
		assertEquals(await plugin.progress(password, 0, new Uint8Array, writer as Any), true); // OK packet ends the flow

		// Invalid extended salt
		{	const plugin2 = AuthPlugin.inst('parsec', serverScramble, new Dsn(TCP_DSN));
			await plugin2.quickAuth(password);
			const error = await getError(() => plugin2.progress(password, 1, new Uint8Array([0x51, 0, ...salt]), writer as Any));
			assert(error.includes('invalid extended salt'), error);
		}
		// Absurd iteration count from a rogue server
		{	const plugin2 = AuthPlugin.inst('parsec', serverScramble, new Dsn(TCP_DSN));
			await plugin2.quickAuth(password);
			const error = await getError(() => plugin2.progress(password, 1, new Uint8Array([0x50, 21, ...salt]), writer as Any));
			assert(error.includes('iterations'), error);
		}
	}
);
