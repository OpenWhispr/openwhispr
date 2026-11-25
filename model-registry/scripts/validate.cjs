const { readCatalog, assertCompatibleCatalog } = require("../lib/catalog.cjs");
const baseline = require("../test/seed.json");
assertCompatibleCatalog(readCatalog(), baseline, { floor: baseline });
console.log("Catalog is valid and preserves the shipping desktop contract.");
