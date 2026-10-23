const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { installElectronStub } = require("../harness/electronStub.js");

installElectronStub();
const { SkillLibrary } = require("../../../src/helpers/skills/skillLibrary");

const RECOMMENDED_DIR = path.join(__dirname, "../../../src/helpers/skills/recommended");

const skillText = (name, description = "Does it.", body = "Steps\n") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;

// The five state methods of DatabaseManager, kept in memory so these tests run under any
// Node. test/helpers/skillsDatabase.test.js pins the real ones to the same contract.
function fakeDatabase() {
  const rows = new Map();
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 9, 20, 9, 0, tick++)).toISOString();
  return {
    rows,
    getSkillStates: () => [...rows.values()].reverse().map((row) => ({ ...row })),
    upsertSkillState(name, { enabled, contentHash } = {}) {
      const row = rows.get(name);
      if (!row) {
        const at = now();
        rows.set(name, {
          name,
          enabled: enabled ?? true,
          contentHash: contentHash ?? null,
          lastUsedAt: null,
          createdAt: at,
          updatedAt: at,
        });
        return;
      }
      if (enabled !== undefined) row.enabled = enabled;
      if (contentHash !== undefined && contentHash !== row.contentHash) {
        row.contentHash = contentHash;
        row.updatedAt = now();
      }
    },
    setSkillEnabled(name, enabled) {
      const row = rows.get(name);
      if (!row) return false;
      row.enabled = enabled;
      return true;
    },
    markSkillUsed(name) {
      const row = rows.get(name);
      if (row) row.lastUsedAt = now();
    },
    deleteSkillState(name) {
      rows.delete(name);
    },
  };
}

function setup(t) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-skill-library-"));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const database = fakeDatabase();
  const library = new SkillLibrary({ userDataDir, database, recommendedDir: RECOMMENDED_DIR });
  return { library, database, userDataDir, skillsDir: path.join(userDataDir, "skills") };
}

function writeFolder(skillsDir, name, files) {
  for (const [relPath, data] of Object.entries(files)) {
    const filePath = path.join(skillsDir, name, ...relPath.split("/"));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, data);
  }
}

const listDir = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);
const readSkill = (skillsDir, name) =>
  fs.readFileSync(path.join(skillsDir, name, "SKILL.md"), "utf8");

module.exports = { RECOMMENDED_DIR, skillText, setup, writeFolder, listDir, readSkill };
