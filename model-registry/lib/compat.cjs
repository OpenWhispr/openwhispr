const fs = require("node:fs");
const path = require("node:path");
const { contractId, PROVIDER_SECTIONS, MAP_SECTIONS, isActive } = require("./schema.cjs");
const { readerHashes } = require("./publication.cjs");
const { isModelSupported } = require("./registrySelection.js");
const seed = require("../test/seed.json");

const COMPAT_DIR = path.join(__dirname, "..", "compat");
const CLIENTS_DIR = path.join(COMPAT_DIR, "clients");

function entries(catalog) {
  const result = [];
  for (const section of PROVIDER_SECTIONS)
    for (const provider of catalog[section] || [])
      for (const model of provider.models || [])
        result.push({ key: `${section}/${provider.id}/${model.id}`, model });
  for (const section of MAP_SECTIONS)
    for (const [id, model] of Object.entries(catalog[section] || {}))
      result.push({ key: `${section}/${id}`, model });
  return result;
}

// Every app reader the registry still serves: the vendored copies of released readers,
// plus this repository's own, which the next app release vendors. The own reader runs
// at a high version so it must read every entry, gated or not.
function listClients() {
  const clients = [
    {
      id: contractId(readerHashes()),
      dir: __dirname,
      appVersion: "9999.0.0",
      floor: seed,
      own: true,
    },
  ];
  if (!fs.existsSync(CLIENTS_DIR)) return clients;
  for (const id of fs.readdirSync(CLIENTS_DIR).sort()) {
    const dir = path.join(CLIENTS_DIR, id);
    const actual = contractId(readerHashes(dir));
    if (actual !== id) throw new Error(`compat/clients/${id} does not match its files (${actual})`);
    const client = JSON.parse(fs.readFileSync(path.join(dir, "client.json"), "utf8"));
    clients.push({
      id,
      dir,
      appVersion: client.appVersion,
      floor: JSON.parse(fs.readFileSync(path.join(dir, "floor.json"), "utf8")),
    });
  }
  return clients;
}

function droppedClients() {
  const file = path.join(COMPAT_DIR, "dropped-clients.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
}

// Problems a released reader would have with this catalog. An entry may only be
// unreadable to a reader that its minAppVersion already excludes.
function checkClient(client, catalog) {
  const { acceptCatalog } = require(path.join(client.dir, "schema.cjs"));
  const problems = [];
  let accepted;
  try {
    accepted = acceptCatalog(catalog, client.floor, client.appVersion);
  } catch (error) {
    return [`reader threw: ${error.message}`];
  }
  const kept = new Set(entries(accepted).map((entry) => entry.key));
  for (const { key } of entries(client.floor))
    if (!kept.has(key)) problems.push(`loses bundled model ${key}`);
  for (const { key, model } of entries(catalog))
    if (!kept.has(key) && isModelSupported(model, client.appVersion))
      problems.push(`cannot read ${key}; give it a minAppVersion above ${client.appVersion}`);
  for (const section of PROVIDER_SECTIONS)
    for (const provider of accepted[section] || []) {
      const active = provider.models.filter(isActive);
      if (active.length && !active.some((model) => model.id === provider.defaultModel))
        problems.push(`${section}/${provider.id} has no usable default`);
    }
  return problems;
}

function checkCompatibility(catalog, clients = listClients()) {
  const failures = [];
  for (const client of clients)
    for (const problem of checkClient(client, catalog))
      failures.push(`${client.own ? "this repository" : `client ${client.id}`}: ${problem}`);
  if (failures.length) throw new Error(`Older app readers would break:\n${failures.join("\n")}`);
  return [...new Set(clients.map((client) => client.id))];
}

module.exports = { listClients, checkClient, checkCompatibility, droppedClients };
