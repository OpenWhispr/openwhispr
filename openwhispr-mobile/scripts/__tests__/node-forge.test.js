const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const { spawnSync } = require('node:child_process');
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

// Exercise every locked copy: a nested, vulnerable dependency must also block CI.
for (const forgePath of forgePaths) {
  const resolved = path.resolve(__dirname, '../..', forgePath);
  const forge = require(resolved);
  const privateKey = forge.pki.privateKeyFromPem(privatePem);
  const publicKey = forge.pki.setRsaPublicKey(privateKey.n, privateKey.e);
  const { asn1 } = forge;
  const digest = forge.md.sha256.create().update('OpenWhispr update manifest').digest().getBytes();

  test(`${forgePath}: accepts private keys as both string and Buffer PEM input`, () => {
    const bufferedKey = forge.pki.privateKeyFromPem(Buffer.from(privatePem));
    assert.equal(bufferedKey.n.toString(16), privateKey.n.toString(16));
    assert.equal(bufferedKey.d.toString(16), privateKey.d.toString(16));
  });

  test(`${forgePath}: rejects the published malformed PEM payload within the subprocess deadline`, () => {
    // GHSA-7wch-p9px-956x blocks the event loop; a subprocess bounds a regression.
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `
      const assert = require('node:assert/strict');
      const forge = require(${JSON.stringify(resolved)});
      const pem = ' -----BEGIN I-----G-----END B'.repeat(1000) + '\\x00';
      assert.throws(() => forge.pki.certificateFromPem(pem), /Invalid PEM formatted message/);
    `,
      ],
      { timeout: 5000, encoding: 'utf8' },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  });

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
