const test = require("node:test");
const assert = require("node:assert/strict");
const https = require("https");
const { EventEmitter } = require("events");
const { Readable } = require("stream");

const { fetchLatestRelease } = require("../../scripts/lib/download-utils");

const REPO = "OpenWhispr/openwhispr";
const FIRST_PAGE = `https://api.github.com/repos/${REPO}/releases?per_page=100`;
const SECOND_PAGE = `${FIRST_PAGE}&page=2`;
const LAST_PAGE = `${FIRST_PAGE}&page=3`;

// Answer https.get the way the GitHub API does: a JSON page and, when more
// pages follow, a `link` header (Node lower-cases header names).
function serveReleasePages(t, pages) {
  const requested = [];
  t.mock.method(https, "get", (url, _options, onResponse) => {
    requested.push(url);
    const { releases, link } = pages[url];
    const response = Readable.from([Buffer.from(JSON.stringify(releases))]);
    response.statusCode = 200;
    response.headers = link ? { link } : {};
    setImmediate(() => onResponse(response));
    return new EventEmitter();
  });
  return requested;
}

test("follows rel=next past a first page without the prefix", async (t) => {
  const requested = serveReleasePages(t, {
    [FIRST_PAGE]: {
      releases: Array.from({ length: 100 }, (_, i) => ({ tag_name: `v1.${i}.0` })),
      link: `<${LAST_PAGE}>; rel="last", <${SECOND_PAGE}>; rel="next"`,
    },
    [SECOND_PAGE]: {
      releases: [
        { tag_name: "v0.9.0" },
        {
          tag_name: "windows-key-listener-v1.0.0",
          html_url: `https://github.com/${REPO}/releases/tag/windows-key-listener-v1.0.0`,
          assets: [
            {
              name: "windows-key-listener-win32-x64.zip",
              browser_download_url: "https://example.test/key.zip",
            },
          ],
        },
      ],
    },
  });

  const release = await fetchLatestRelease(REPO, { tagPrefix: "windows-key-listener-v" });

  assert.deepEqual(release, {
    tag: "windows-key-listener-v1.0.0",
    url: `https://github.com/${REPO}/releases/tag/windows-key-listener-v1.0.0`,
    assets: [{ name: "windows-key-listener-win32-x64.zip", url: "https://example.test/key.zip" }],
  });
  assert.deepEqual(requested, [FIRST_PAGE, SECOND_PAGE]);
});

test("skips drafts, and prereleases unless asked for", async (t) => {
  serveReleasePages(t, {
    [FIRST_PAGE]: {
      releases: [
        { tag_name: "windows-key-listener-v1.2.0", draft: true },
        { tag_name: "windows-key-listener-v1.1.0-rc", prerelease: true },
        { tag_name: "windows-key-listener-v1.0.0" },
      ],
    },
  });
  const options = { tagPrefix: "windows-key-listener-v" };

  assert.equal((await fetchLatestRelease(REPO, options)).tag, "windows-key-listener-v1.0.0");
  assert.equal(
    (await fetchLatestRelease(REPO, { ...options, includePrerelease: true })).tag,
    "windows-key-listener-v1.1.0-rc"
  );
});

test("returns null once the last page has no match", async (t) => {
  const requested = serveReleasePages(t, {
    [FIRST_PAGE]: { releases: [{ tag_name: "v1.9.3" }] },
  });

  assert.equal(await fetchLatestRelease(REPO, { tagPrefix: "windows-key-listener-v" }), null);
  assert.deepEqual(requested, [FIRST_PAGE]);
});
