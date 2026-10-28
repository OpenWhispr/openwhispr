const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const { generateKeyPairSync } = require('node:crypto');
const path = require('node:path');
const { test } = require('node:test');
const lockfile = require('../../package-lock.json');

const forgePaths = Object.keys(lockfile.packages).filter((entry) =>
  entry.endsWith('node_modules/node-forge'),
);
assert.ok(forgePaths.length > 0, 'Expected the Expo signing dependency in the lockfile');

const { privateKey: privatePem } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicExponent: 3,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

// Exercise every locked copy: a nested, unpatched dependency must also block CI.
for (const forgePath of forgePaths) {
  const forge = require(path.resolve(__dirname, '../..', forgePath));
  const privateKey = forge.pki.privateKeyFromPem(privatePem);
  const publicKey = forge.pki.setRsaPublicKey(privateKey.n, privateKey.e);
  const { asn1 } = forge;
  const digest = forge.md.sha256.create().update('OpenWhispr update manifest').digest().getBytes();

  for (const includeNull of [false, true]) {
    for (const extraElements of [0, 1, 2]) {
      test(`${forgePath}: ${extraElements} extra elements, NULL=${includeNull}`, () => {
        const algorithm = [
          asn1.create(
            asn1.Class.UNIVERSAL,
            asn1.Type.OID,
            false,
            asn1.oidToDer(forge.oids.sha256).getBytes(),
          ),
        ];
        if (includeNull) {
          algorithm.push(asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, false, ''));
        }
        for (let index = 0; index < extraElements; index++) {
          algorithm.push(
            asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, 'garbage'),
          );
        }
        const digestInfo = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
          asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, algorithm),
          asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, digest),
        ]);
        // Sign a deliberately malformed DigestInfo to isolate the parser flaw in CVE-2026-85393.
        const signature = privateKey.sign(asn1.toDer(digestInfo).getBytes(), 'NONE');
        if (extraElements > 0) {
          assert.throws(() => publicKey.verify(digest, signature), /DigestInfo/);
        } else {
          assert.equal(publicKey.verify(digest, signature), true);
          assert.equal(publicKey.verify('different digest', signature), false);
        }
      });
    }
  }
}

test('Expo can still sign and verify an update with its code-signing certificate', () => {
  const signing = require('@expo/code-signing-certificates');
  const keyPair = signing.generateKeyPair();
  const certificate = signing.generateSelfSignedCodeSigningCertificate({
    keyPair,
    validityNotBefore: new Date('2026-01-01T00:00:00Z'),
    validityNotAfter: new Date('2030-01-01T00:00:00Z'),
    commonName: 'OpenWhispr security regression test',
  });
  assert.doesNotThrow(() =>
    signing.signBufferRSASHA256AndVerify(
      keyPair.privateKey,
      certificate,
      Buffer.from('test update'),
    ),
  );
});
