import { execFileSync } from 'node:child_process';
import path from 'node:path';

it('preserves Android identity through gateway HTML using the actual auth SDK and Expo cache', () => {
  // A separate Node process loads the real ESM SDKs. The harness replaces only
  // native services and HTTP, and asserts cache, rejection and iOS boundaries.
  const output = execFileSync(
    process.execPath,
    [path.resolve(__dirname, '../../../scripts/auth-session-test/run.js')],
    { encoding: 'utf8', timeout: 20_000 },
  );
  expect(JSON.parse(output).passed).toBe(31);
}, 25_000);
