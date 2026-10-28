const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const i18next = require("i18next");
const { initReactI18next } = require("react-i18next");

globalThis.React = require("react");

const ENGINEERING = "11111111-1111-4111-8111-111111111111";
const SALES = "22222222-2222-4222-8222-222222222222";

const SCOPES = [
  { space_id: null, name: "Acme", member_count: 42, word_count: 84 },
  { space_id: ENGINEERING, name: "Engineering", member_count: 14, word_count: 31 },
  { space_id: SALES, name: "Sales", member_count: 1, word_count: 12 },
];

async function initializeI18n() {
  if (i18next.isInitialized) return;
  const en = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../../src/locales/en/translation.json"), "utf8")
  );
  await i18next.use(initReactI18next).init({
    lng: "en",
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  });
}

async function load(relativePath) {
  await initializeI18n();
  return import(`../../src/components/dictionary/${relativePath}.tsx`);
}

// The visible text, with React's attribute/text escaping undone.
const textOf = (markup) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

const count = (markup, pattern) => (markup.match(pattern) ?? []).length;

async function renderLocked(props) {
  const { SharedDictionaryLocked } = await load("SharedDictionaryLocked");
  return renderToStaticMarkup(
    createElement(SharedDictionaryLocked, {
      workspaceName: "Acme",
      scopes: SCOPES,
      canManage: true,
      onUpgrade() {},
      ...props,
    })
  );
}

test("noWorkspace describes what Business adds, with View Plans", async () => {
  const markup = await renderLocked({ access: "noWorkspace", workspaceName: "", scopes: [] });
  const text = textOf(markup);
  assert.ok(
    text.includes(
      "Shared dictionaries are included with Business. Share your team's jargon, product names and acronyms with everyone."
    )
  );
  assert.ok(text.includes("Everyone in your workspace Words for the whole company"));
  assert.ok(text.includes("A list per space Words only one team needs"));
  assert.ok(text.includes("View Plans"));
  assert.equal(count(markup, /opacity-60/g), 2);
});

test("upgradeAdmin shows the real lists with member counts, with View Plans", async () => {
  const markup = await renderLocked({ access: "upgradeAdmin" });
  const text = textOf(markup);
  assert.ok(
    text.includes(
      "Shared dictionaries are included with Business. Upgrade Acme so everyone gets the same words."
    )
  );
  assert.ok(text.includes("Everyone at Acme 42 members"));
  assert.ok(text.includes("Engineering 14 members"));
  assert.ok(text.includes("Sales 1 member"));
  assert.ok(text.includes("View Plans"));
  assert.equal(count(markup, /opacity-60/g), 3);
});

test("upgradeMember asks an admin and has no button", async () => {
  const markup = await renderLocked({ access: "upgradeMember" });
  const text = textOf(markup);
  assert.ok(
    text.includes("Shared dictionaries are included with Business. Ask an admin to upgrade Acme.")
  );
  assert.ok(text.includes("Everyone at Acme 42 members"));
  assert.ok(text.includes("Engineering 14 members"));
  assert.ok(!text.includes("View Plans"));
  assert.equal(count(markup, /<button/g), 0);
  assert.equal(count(markup, /opacity-60/g), 3);
});

test("a locked workspace with no lists read yet still names it", async () => {
  const markup = await renderLocked({ access: "upgradeAdmin", scopes: [] });
  const text = textOf(markup);
  assert.ok(text.includes("Everyone at Acme Words for the whole company"));
  assert.ok(text.includes("A list per space Words only one team needs"));
  assert.equal(count(markup, /opacity-60/g), 2);
});

test("paused counts the kept words, per list and in total, with View Plans", async () => {
  const markup = await renderLocked({ access: "paused" });
  const text = textOf(markup);
  assert.ok(
    text.includes(
      "Acme's 127 shared words are paused. Upgrade to Business to use them in dictation again."
    )
  );
  assert.ok(text.includes("Everyone at Acme 84 words"));
  assert.ok(text.includes("Engineering 31 words"));
  assert.ok(text.includes("Sales 12 words"));
  assert.ok(text.includes("View Plans"));
  assert.equal(count(markup, /opacity-60/g), 3);
});

test("paused bar alone is the same bar a read-only list shows above its words", async () => {
  const { SharedDictionaryUpsell } = await load("SharedDictionaryLocked");
  const markup = renderToStaticMarkup(
    createElement(SharedDictionaryUpsell, {
      access: "paused",
      workspaceName: "Acme",
      scopes: [{ space_id: null, name: "Acme", member_count: 3, word_count: 1 }],
      canManage: true,
      onUpgrade() {},
    })
  );
  const text = textOf(markup);
  assert.ok(text.includes("Acme's 1 shared word is paused."));
  assert.ok(text.includes("View Plans"));
  assert.equal(count(markup, /opacity-60/g), 0);
});

test("a paused workspace asks a member to contact an admin or owner, with no button", async () => {
  const markup = await renderLocked({ access: "paused", canManage: false });
  const text = textOf(markup);
  assert.ok(
    text.includes(
      "Acme's 127 shared words are paused. Ask an admin or owner to upgrade to Business to use them in dictation again."
    )
  );
  assert.ok(text.includes("Engineering 31 words"));
  assert.equal(count(markup, /<button/g), 0);
});

test("SSO and lost access explain themselves, with no lists and no button", async () => {
  const sso = textOf(await renderLocked({ access: "ssoRequired" }));
  assert.ok(sso.includes("Acme requires company SSO. Sign out, then sign in with SSO"));
  assert.ok(!sso.includes("Engineering"));
  assert.ok(!sso.includes("View Plans"));

  const lost = await renderLocked({ access: "noAccess" });
  assert.ok(textOf(lost).includes("You no longer have access to Acme's shared words."));
  assert.equal(count(lost, /<button/g), 0);
  assert.equal(count(lost, /opacity-60/g), 0);
});

test("an empty list names the list and its members, with both buttons", async () => {
  const { SharedListEmpty } = await load("SharedListEmpty");
  const markup = renderToStaticMarkup(
    createElement(SharedListEmpty, {
      listName: "Engineering",
      memberCount: 14,
      onImport() {},
      onShareFromPersonal() {},
    })
  );
  const text = textOf(markup);
  assert.ok(text.includes("No words in Engineering yet"));
  assert.ok(
    text.includes(
      "Add the terms this team uses, or share some from your personal list. Everyone in Engineering (14) will get them."
    )
  );
  assert.ok(text.includes("Import a list"));
  assert.ok(text.includes("Share from Personal"));
  assert.equal(count(markup, /<button/g), 2);
});
