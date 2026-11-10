import { generateKeyPairSync, sign } from 'node:crypto';

// Minimal synthetic self-signed certificate for loopback TLS tests only. No
// fixture keys on disk, openssl executable, user CA/private key or extra package.
function der(tag: number, body: Buffer): Buffer {
  const hex = body.length.toString(16).padStart(Math.ceil(body.length.toString(16).length / 2) * 2, '0');
  const length = body.length < 128 ? Buffer.from([body.length]) : Buffer.concat([Buffer.from([0x80 | hex.length / 2]), Buffer.from(hex, 'hex')]);
  return Buffer.concat([Buffer.from([tag]), length, body]);
}
const sequence = (...parts: Buffer[]) => der(0x30, Buffer.concat(parts));
const oid = (hex: string) => der(6, Buffer.from(hex, 'hex'));
export function tlsProxyFixture(ipLastByte = 1): { key: string; cert: string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const algorithm = sequence(oid('2a864886f70d01010b'), der(5, Buffer.alloc(0)));
  const name = sequence(der(0x31, sequence(oid('550403'), der(0x0c, Buffer.from('CloudHelm synthetic loopback')))));
  const validity = sequence(der(0x17, Buffer.from('240101000000Z')), der(0x17, Buffer.from('491231235959Z')));
  const extensions = der(0xa3, sequence(
    sequence(oid('551d13'), der(1, Buffer.from([0xff])), der(4, sequence(der(1, Buffer.from([0xff]))))),
    sequence(oid('551d11'), der(4, sequence(der(0x87, Buffer.from([127, 0, 0, ipLastByte])))))
  ));
  const body = sequence(der(0xa0, der(2, Buffer.from([2]))), der(2, Buffer.from([1])), algorithm, name, validity, name,
    publicKey.export({ type: 'spki', format: 'der' }), extensions);
  const certificate = sequence(body, algorithm, der(3, Buffer.concat([Buffer.from([0]), sign('sha256', body, privateKey)])));
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    cert: `-----BEGIN CERTIFICATE-----\n${certificate.toString('base64').match(/.{1,64}/gu)!.join('\n')}\n-----END CERTIFICATE-----\n` };
}
