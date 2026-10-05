const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const i18next = require("i18next");
const { initReactI18next } = require("react-i18next");

// tsx resolves tsconfig from the cwd, where none sets the automatic JSX runtime,
// so compiled .tsx uses the classic transform and needs a global React.
globalThis.React = require("react");

const MEMBERS = [
  {
    user_id: "u1",
    role: "member",
    joined_at: "2026-01-01T00:00:00Z",
    email: "ada@example.com",
    name: "Ada Lovelace",
    image: null,
  },
];

async function renderPickList(props) {
  if (!i18next.isInitialized) {
    const en = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../../src/locales/en/translation.json"), "utf8")
    );
    await i18next.use(initReactI18next).init({
      lng: "en",
      resources: { en: { translation: en } },
      interpolation: { escapeValue: false },
    });
  }
  // tsx compiles the .tsx module to CJS, so its default lands one level deeper.
  const mod = await import("../../src/components/MemberPickList.tsx");
  const MemberPickList = mod.default.default ?? mod.default;
  return renderToStaticMarkup(
    createElement(MemberPickList, {
      members: MEMBERS,
      search: "",
      onSearchChange: () => {},
      onSelect: () => {},
      ...props,
    })
  );
}

test("a people filter with no matches says no people were found", async () => {
  const html = await renderPickList({ search: "zzz-no-such-person" });

  assert.ok(html.includes("No people found"));
  assert.ok(!html.includes("No folders found"));
});

test("matching members render instead of the no-results row", async () => {
  const html = await renderPickList({ search: "ada" });

  assert.ok(html.includes("Ada Lovelace"));
  assert.ok(!html.includes("No people found"));
});

test("a provided footer suppresses the built-in no-results row", async () => {
  const footer = createElement("div", null, "Invite by email");
  const html = await renderPickList({ search: "zzz-no-such-person", footer });

  assert.ok(html.includes("Invite by email"));
  assert.ok(!html.includes("No people found"));
});
