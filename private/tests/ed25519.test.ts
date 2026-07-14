import {ed25519PublicKey, ed25519Sign, ed25519Verify} from '../ed25519.ts';
import {assertEquals} from 'jsr:@std/assert@1.0.19/equals';

const encoder = new TextEncoder;

function hexToBytes(hex: string)
{	const result = new Uint8Array(hex.length / 2);
	for (let i=0; i<result.length; i++)
	{	result[i] = parseInt(hex.slice(i*2, i*2+2), 16);
	}
	return result;
}

function bytesToHex(data: Uint8Array)
{	let result = '';
	for (const byte of data)
	{	result += byte.toString(16).padStart(2, '0');
	}
	return result;
}

function base64ToBytes(base64: string)
{	const str = atob(base64);
	const result = new Uint8Array(str.length);
	for (let i=0; i<str.length; i++)
	{	result[i] = str.charCodeAt(i);
	}
	return result;
}

/**	Test vectors from RFC 8032 section 7.1.
 **/
const RFC_8032_VECTORS =
[	{	name: 'TEST 1',
		seed: '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
		publicKey: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
		message: '',
		signature: 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
	},
	{	name: 'TEST 2',
		seed: '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb',
		publicKey: '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
		message: '72',
		signature: '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00',
	},
	{	name: 'TEST 3',
		seed: 'c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7',
		publicKey: 'fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025',
		message: 'af82',
		signature: '6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a',
	},
	{	name: 'TEST SHA(abc)',
		seed: '833fe62409237b9d62ec77587520911e9a759cec1d19755b7da901b96dca3d42',
		publicKey: 'ec172b93ad5e563bf4932c70e1245034c35467ef2efd4d64ebf819683467e2bf',
		message: 'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f',
		signature: 'dc2a4459e7369633a52b1bf277839a00201009a3efbf3ecb69bea2186c26b58909351fc9ac90b3ecfdfbc7c66431e0303dca179c138ac17ad9bef1177331a704',
	},
];

/**	Password to public key pairs produced by MariaDB's `ed25519_password()` function (from the server test suite, `mysql-test/suite/plugins/r/auth_ed25519.result`).
	These exercise the arbitrary-length seed path that MariaDB's `client_ed25519` authentication relies upon.
 **/
const MARIADB_VECTORS =
[	{	password: 'foo',
		publicKeyBase64: 'vubFBzIrapbfHct1/J72dnUryz5VS7lA6XHH8sIx4TI',
	},
	{	password: 'foobar',
		publicKeyBase64: 'qv2mG6HWCuy32Slb5xhV4THStewNz2VINVPbgk+XAJ8',
	},
	{	password: 'foo bar',
		publicKeyBase64: 'Y5fV74JAVRMOK2cdnUsYS+WW9sXaaL/o+6WGKOgqnzc',
	},
];

Deno.test
(	'RFC 8032 vectors',
	async () =>
	{	for (const {name, seed, publicKey, message, signature} of RFC_8032_VECTORS)
		{	const seedBytes = hexToBytes(seed);
			const messageBytes = hexToBytes(message);
			assertEquals(bytesToHex(await ed25519PublicKey(seedBytes)), publicKey, `${name}: public key`);
			const sig = await ed25519Sign(seedBytes, messageBytes);
			assertEquals(bytesToHex(sig), signature, `${name}: signature`);
			assertEquals(await ed25519Verify(hexToBytes(publicKey), messageBytes, sig), true, `${name}: verify`);
			// tampered message must not verify
			const tampered = new Uint8Array([...messageBytes, 0]);
			assertEquals(await ed25519Verify(hexToBytes(publicKey), tampered, sig), false, `${name}: tampered`);
		}
	}
);

Deno.test
(	'MariaDB password vectors',
	async () =>
	{	for (const {password, publicKeyBase64} of MARIADB_VECTORS)
		{	const publicKey = await ed25519PublicKey(encoder.encode(password));
			assertEquals(bytesToHex(publicKey), bytesToHex(base64ToBytes(publicKeyBase64)), `password: ${password}`);
		}
	}
);

Deno.test
(	'Sign and verify with arbitrary-length seeds',
	async () =>
	{	const message = encoder.encode('The quick brown fox');
		for (const seedLen of [0, 1, 20, 32, 33, 100])
		{	const seed = new Uint8Array(seedLen);
			crypto.getRandomValues(seed);
			const publicKey = await ed25519PublicKey(seed);
			const sig = await ed25519Sign(seed, message);
			assertEquals(await ed25519Verify(publicKey, message, sig), true, `seed length ${seedLen}`);
			assertEquals(await ed25519Verify(publicKey, encoder.encode('The quick brown fux'), sig), false, `seed length ${seedLen}: tampered`);
		}
	}
);

Deno.test
(	'Verify rejects malformed inputs',
	async () =>
	{	const seed = encoder.encode('secret');
		const message = encoder.encode('msg');
		const publicKey = await ed25519PublicKey(seed);
		const sig = await ed25519Sign(seed, message);
		assertEquals(await ed25519Verify(publicKey, message, sig.subarray(0, 63)), false, 'short signature');
		assertEquals(await ed25519Verify(publicKey.subarray(0, 31), message, sig), false, 'short public key');
		const badS = sig.slice();
		badS.set(new Uint8Array(32).fill(0xFF), 32); // S >= L
		assertEquals(await ed25519Verify(publicKey, message, badS), false, 'non-canonical S');
	}
);
