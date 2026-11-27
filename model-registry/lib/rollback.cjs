const { PROVIDER_SECTIONS, MAP_SECTIONS, settleReferences } = require("./schema.cjs");

function retire(model, replacement) {
  model.retired = true;
  delete model.legacy;
  if (replacement) model.replacement = replacement;
  else delete model.replacement;
}

// Hidden from new choices but reversible: the fix on main can bring it back.
function shelve(model) {
  if (!model.retired) model.legacy = true;
}

// The data of an earlier publication, made valid to publish again. A rollback never
// revives a retired model and never drops an ID: models retired since the target stay
// retired, and models added since come back as legacy, so main can restore them. A
// provider added since comes back too, at the end, with its models shelved the same way.
function rollbackCatalog(target, current) {
  const data = structuredClone(target);
  for (const section of PROVIDER_SECTIONS)
    for (const provider of current[section]) {
      let into = data[section].find((item) => item.id === provider.id);
      if (!into) {
        into = { ...structuredClone(provider), models: [] };
        data[section].push(into);
      }
      for (const model of provider.models) {
        const existing = into.models.find((item) => item.id === model.id);
        if (!existing) {
          const copy = structuredClone(model);
          shelve(copy);
          into.models.push(copy);
        } else if (model.retired) retire(existing, model.replacement);
      }
    }
  for (const section of MAP_SECTIONS)
    for (const [id, model] of Object.entries(current[section])) {
      if (!Object.hasOwn(data[section], id)) {
        data[section][id] = structuredClone(model);
        shelve(data[section][id]);
      } else if (model.retired) retire(data[section][id], model.replacement);
    }
  // Drops replacements that point at a model no longer active and repairs defaults.
  return settleReferences(data);
}

module.exports = { rollbackCatalog };
