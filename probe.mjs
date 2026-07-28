import { isSecureEndpoint } from "./src/utils/urlUtils.ts";
const cases = [
  // must be REJECTED (public hosts that used to sneak through)
  ["http://127.example.com/v1", false],
  ["http://10.example.com/v1", false],
  ["http://192.168.example.com/v1", false],
  ["http://172.16.example.com/v1", false],
  ["http://100.64.example.com/v1", false],
  ["http://169.254.example.com/v1", false],
  ["http://127.0.0.1.nip.io/v1", false],
  ["http://0.0.0.0.evil.com/v1", false],
  // must stay ALLOWED
  ["http://127.0.0.1:5000", true],
  ["http://localhost:8080", true],
  ["http://0.0.0.0:1234", true],
  ["http://10.0.0.5:8080", true],
  ["http://192.168.1.10:1234", true],
  ["http://172.16.0.1:1234", true],
  ["http://172.31.255.255:1234", true],
  ["http://100.64.0.1:8080", true],
  ["http://169.254.1.1:80", true],
  ["http://myhost.local:1234", true],
  ["http://[::1]:8080", true],
  ["http://[fd00::1]:8080", true],
  ["http://[fe80::1]:8080", true],
  ["https://api.openai.com/v1", true],
  // boundary: NOT private, must require https
  ["http://172.15.0.1:1234", false],
  ["http://172.32.0.1:1234", false],
  ["http://100.63.0.1:1234", false],
  ["http://100.128.0.1:1234", false],
  ["http://11.0.0.1:1234", false],
  ["http://126.0.0.1:1234", false],
  ["http://128.0.0.1:1234", false],
  // abbreviated / alternate literals WHATWG normalises
  ["http://127.1", true],
  ["http://2130706433", true],
  ["http://0x7f000001", true],
  ["http://010.0.0.1", true],
];
let bad = 0;
for (const [url, want] of cases) {
  let got;
  try { got = isSecureEndpoint(url); } catch (e) { got = "THREW " + e.message; }
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${String(got).padEnd(5)} (want ${want})  ${url}`);
}
console.log(bad ? `\n${bad} MISMATCHES` : "\nall as expected");
