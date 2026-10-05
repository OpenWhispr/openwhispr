const test = require("node:test");
const assert = require("node:assert/strict");

const load = async () => {
  const m = await import("../../src/utils/formatAmount.ts");
  return m.default || m;
};

// Reference formatting through the same Intl path, so expectations
// track the host locale instead of hardcoding "$1.00".
const usd = (n) => n.toLocaleString(undefined, { style: "currency", currency: "USD" });

test("formats a plain cents amount identically to direct toLocaleString", async () => {
  const { formatAmount } = await load();
  assert.equal(
    formatAmount(12345, "USD"),
    (12345 / 100).toLocaleString(undefined, { style: "currency", currency: "USD" })
  );
});

test("falls back to USD when currency is null instead of throwing RangeError", async () => {
  const { formatAmount } = await load();
  assert.equal(formatAmount(100, null), usd(1));
});

test("falls back to USD when currency is undefined instead of throwing RangeError", async () => {
  const { formatAmount } = await load();
  assert.equal(formatAmount(100, undefined), usd(1));
});

test("falls back to USD when currency is an empty string instead of throwing RangeError", async () => {
  const { formatAmount } = await load();
  assert.equal(formatAmount(100, ""), usd(1));
});

test("falls back to USD when currency is only whitespace", async () => {
  const { formatAmount } = await load();
  assert.equal(formatAmount(100, "   "), usd(1));
});

test("trims untrimmed currency codes like ' USD ' instead of throwing RangeError", async () => {
  const { formatAmount } = await load();
  assert.equal(formatAmount(100, " USD "), usd(1));
});

test("accepts lowercase currency codes by uppercasing them", async () => {
  const { formatAmount } = await load();
  assert.equal(formatAmount(100, "usd"), usd(1));
});

test("falls back to USD on malformed currency codes that make Intl throw", async () => {
  const { formatAmount } = await load();
  assert.equal(formatAmount(100, "AB"), usd(1));
  assert.equal(formatAmount(100, "TOOLONG"), usd(1));
  assert.equal(formatAmount(100, "$$$"), usd(1));
});

test("keeps well-formed but unrecognized codes, which Intl formats without throwing", async () => {
  const { formatAmount } = await load();
  assert.equal(
    formatAmount(100, "XYZ"),
    (1).toLocaleString(undefined, { style: "currency", currency: "XYZ" })
  );
});

test("treats NaN cents as zero instead of rendering '$NaN'", async () => {
  const { formatAmount } = await load();
  assert.equal(formatAmount(NaN, "USD"), usd(0));
});

test("treats Infinity and -Infinity cents as zero instead of rendering '$∞'", async () => {
  const { formatAmount } = await load();
  assert.equal(formatAmount(Infinity, "USD"), usd(0));
  assert.equal(formatAmount(-Infinity, "USD"), usd(0));
});

test("treats nullish cents as zero", async () => {
  const { formatAmount } = await load();
  assert.equal(formatAmount(null, "USD"), usd(0));
  assert.equal(formatAmount(undefined, "USD"), usd(0));
});

test("formats negative cents amounts", async () => {
  const { formatAmount } = await load();
  assert.equal(
    formatAmount(-12345, "USD"),
    (-123.45).toLocaleString(undefined, { style: "currency", currency: "USD" })
  );
});
