const { readCatalog } = require("../lib/catalog.cjs");
const { checkCompatibility } = require("../lib/compat.cjs");

try {
  const tested = checkCompatibility(readCatalog());
  console.log(`Every app reader accepts this catalog (${tested.length} tested).`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
