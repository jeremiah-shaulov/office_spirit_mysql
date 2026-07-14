/**	Pure-Typescript Ed25519 signing (RFC 8032), with one deviation: the secret seed can be of any length, not only 32 bytes.
	MariaDB's `client_ed25519` authentication uses the raw password bytes as the seed, and Web Crypto refuses to import such keys,
	so this library implements the algorithm itself. The `parsec` authentication uses a 32-byte PBKDF2-derived seed, which is the standard case.
	SHA-512 is taken from Web Crypto, the elliptic-curve math is done on Javascript bigints.

	Caution: bigint arithmetic is not constant-time, so this code leaks timing information about the secrets.
	This is acceptable for a client-side signer (the secret is the local user's own password, that is anyway being used to authenticate on the observable channel),
	but this module must not be reused for server-side or multi-tenant secret handling.
 **/

const P = 2n**255n - 19n;
const L = 2n**252n + 27742317777372353535851937790883648493n;
const D = mod(-121665n * modPow(121666n, P-2n, P)); // -121665/121666 mod P
const SQRT_M1 = modPow(2n, (P-1n) / 4n, P); // sqrt(-1) mod P

/**	Point on edwards25519 in extended homogeneous coordinates: x = X/Z, y = Y/Z, T = XY/Z.
 **/
type Point = [bigint, bigint, bigint, bigint];

const BASE_X = 15112221349535400772501151409588531511454012693041857206046113283949847762202n;
const BASE_Y = 46316835694926478169428394003475163141307993866256225615783033603165251855960n;
const BASE: Point = [BASE_X, BASE_Y, 1n, mod(BASE_X * BASE_Y)];
const IDENTITY: Point = [0n, 1n, 1n, 0n];

function mod(a: bigint)
{	const result = a % P;
	return result<0n ? result+P : result;
}

function modL(a: bigint)
{	const result = a % L;
	return result<0n ? result+L : result;
}

function modPow(base: bigint, exponent: bigint, modulus: bigint)
{	let result = 1n;
	let b = base % modulus;
	if (b < 0n)
	{	b += modulus;
	}
	let e = exponent;
	while (e > 0n)
	{	if (e & 1n)
		{	result = result * b % modulus;
		}
		b = b * b % modulus;
		e >>= 1n;
	}
	return result;
}

/**	Add 2 points using the "add-2008-hwcd-3" formulas, that are strongly unified (also work when the points are equal), so the same function does the doubling.
 **/
function pointAdd(p: Point, q: Point): Point
{	const [x1, y1, z1, t1] = p;
	const [x2, y2, z2, t2] = q;
	const a = mod((y1 - x1) * (y2 - x2));
	const b = mod((y1 + x1) * (y2 + x2));
	const c = mod(t1 * 2n * D * t2);
	const d = mod(z1 * 2n * z2);
	const e = b - a;
	const f = d - c;
	const g = d + c;
	const h = b + a;
	return [mod(e * f), mod(g * h), mod(f * g), mod(e * h)];
}

function pointMul(scalar: bigint, p: Point)
{	let result = IDENTITY;
	let addend = p;
	let s = scalar;
	while (s > 0n)
	{	if (s & 1n)
		{	result = pointAdd(result, addend);
		}
		addend = pointAdd(addend, addend);
		s >>= 1n;
	}
	return result;
}

function encodePoint(p: Point)
{	const [x, y, z] = p;
	const zInv = modPow(z, P-2n, P);
	const xAffine = mod(x * zInv);
	const yAffine = mod(y * zInv);
	const result = bigIntToBytes32LE(yAffine);
	if (xAffine & 1n)
	{	result[31] |= 0x80;
	}
	return result;
}

/**	Decodes 32 bytes to a curve point, or returns undefined if they don't represent a valid point.
 **/
function decodePoint(data: Uint8Array): Point|undefined
{	if (data.length != 32)
	{	return;
	}
	const xSign = BigInt(data[31] >> 7);
	let y = bytesToBigIntLE(data);
	y &= (1n << 255n) - 1n; // clear the sign bit
	if (y >= P)
	{	return;
	}
	// recover x from y: x^2 = (y^2 - 1) / (D*y^2 + 1)
	const y2 = mod(y * y);
	const u = mod(y2 - 1n);
	const v = mod(D * y2 + 1n);
	// candidate root: x = u * v^3 * (u * v^7)^((P-5)/8)
	const v3 = mod(v * v * v);
	const v7 = mod(v3 * v3 * v);
	let x = mod(u * v3 * modPow(mod(u * v7), (P-5n) / 8n, P));
	const vx2 = mod(v * x * x);
	if (vx2 == mod(-u))
	{	x = mod(x * SQRT_M1);
	}
	else if (vx2 != u)
	{	return;
	}
	if (x==0n && xSign==1n)
	{	return;
	}
	if ((x & 1n) != xSign)
	{	x = P - x;
	}
	return [x, y, 1n, mod(x * y)];
}

function bytesToBigIntLE(data: Uint8Array)
{	let result = 0n;
	for (let i=data.length-1; i>=0; i--)
	{	result = (result << 8n) | BigInt(data[i]);
	}
	return result;
}

function bigIntToBytes32LE(value: bigint)
{	const result = new Uint8Array(32);
	let v = value;
	for (let i=0; i<32; i++)
	{	result[i] = Number(v & 0xFFn);
		v >>= 8n;
	}
	return result;
}

async function sha512(data: Uint8Array<ArrayBuffer>)
{	return new Uint8Array(await crypto.subtle.digest('SHA-512', data));
}

function concatBytes(...parts: Uint8Array[])
{	let len = 0;
	for (const part of parts)
	{	len += part.length;
	}
	const result = new Uint8Array(len);
	let offset = 0;
	for (const part of parts)
	{	result.set(part, offset);
		offset += part.length;
	}
	return result;
}

/**	`az = SHA-512(seed)`, with the first half clamped as the secret scalar, per RFC 8032 section 5.1.5.
	Returns the scalar and the second half of `az` (the nonce prefix).
 **/
async function expandSeed(seed: Uint8Array)
{	const az = await sha512(concatBytes(seed));
	az[0] &= 0xF8;
	az[31] &= 0x7F;
	az[31] |= 0x40;
	return {scalar: bytesToBigIntLE(az.subarray(0, 32)), prefix: az.subarray(32)};
}

/**	Returns the 32-byte public key that corresponds to the seed (of any length).
 **/
export async function ed25519PublicKey(seed: Uint8Array)
{	const {scalar} = await expandSeed(seed);
	return encodePoint(pointMul(scalar, BASE));
}

/**	Signs the message with the seed (of any length), and returns the 64-byte signature (`R || S`).
 **/
export async function ed25519Sign(seed: Uint8Array, message: Uint8Array)
{	const {scalar, prefix} = await expandSeed(seed);
	const publicKey = encodePoint(pointMul(scalar, BASE));
	const r = modL(bytesToBigIntLE(await sha512(concatBytes(prefix, message))));
	const rPoint = encodePoint(pointMul(r, BASE));
	const k = modL(bytesToBigIntLE(await sha512(concatBytes(rPoint, publicKey, message))));
	const s = modL(r + k*scalar);
	return concatBytes(rPoint, bigIntToBytes32LE(s));
}

/**	Verifies the signature: checks that `S*B == R + k*A`.
 **/
export async function ed25519Verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array)
{	if (signature.length!=64 || publicKey.length!=32)
	{	return false;
	}
	const rBytes = signature.subarray(0, 32);
	const s = bytesToBigIntLE(signature.subarray(32));
	if (s >= L)
	{	return false;
	}
	const aPoint = decodePoint(publicKey);
	const rPoint = decodePoint(rBytes);
	if (!aPoint || !rPoint)
	{	return false;
	}
	const k = modL(bytesToBigIntLE(await sha512(concatBytes(rBytes, publicKey, message))));
	const lhs = encodePoint(pointMul(s, BASE));
	const rhs = encodePoint(pointAdd(rPoint, pointMul(k, aPoint)));
	return lhs.every((byte, i) => byte == rhs[i]);
}
