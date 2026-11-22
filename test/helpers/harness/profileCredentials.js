const { SECRET_ENV_NAMES, NON_REF_SECRET_ENV } = require("../../../src/config/secretKeys");

// Profile-write tests must never copy a developer's credentials to their fixtures.
function isolateProfileCredentials(t) {
  for (const name of [...SECRET_ENV_NAMES, ...NON_REF_SECRET_ENV]) {
    const original = process.env[name];
    delete process.env[name];
    t.after(() => {
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    });
  }
}

module.exports = { isolateProfileCredentials };
