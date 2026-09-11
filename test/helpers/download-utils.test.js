const test = require("node:test");
const assert = require("node:assert/strict");

const {
  fetchLatestRelease,
  matchReleaseByPrefix,
  parseGithubNextLink,
} = require("../../scripts/lib/download-utils");

test("parseGithubNextLink reads rel=next and ignores last", () => {
  const link =
    '<https://api.github.com/repos/OpenWhispr/openwhispr/releases?page=2>; rel="next", ' +
    '<https://api.github.com/repos/OpenWhispr/openwhispr/releases?page=3>; rel="last"';

  assert.equal(
    parseGithubNextLink(link),
    "https://api.github.com/repos/OpenWhispr/openwhispr/releases?page=2"
  );
  assert.equal(parseGithubNextLink(undefined), null);
  assert.equal(parseGithubNextLink(""), null);
});

test("matchReleaseByPrefix skips drafts and prereleases unless asked", () => {
  const releases = [
    { tag_name: "windows-key-listener-v2.0.0-rc", prerelease: true },
    { tag_name: "windows-key-listener-v1.0.0-wip", draft: true },
    { tag_name: "v1.9.3" },
    { tag_name: "windows-key-listener-v1.0.0" },
  ];

  assert.equal(
    matchReleaseByPrefix(releases, "windows-key-listener-v", false).tag_name,
    "windows-key-listener-v1.0.0"
  );
  assert.equal(
    matchReleaseByPrefix(releases, "windows-key-listener-v", true).tag_name,
    "windows-key-listener-v2.0.0-rc"
  );
  assert.equal(matchReleaseByPrefix(releases, "linux-text-monitor-v", false), null);
  assert.equal(matchReleaseByPrefix(null, "windows-key-listener-v", false), null);
});

test("fetchLatestRelease walks past a first page that does not contain the prefix", async () => {
  const pages = {
    "https://api.github.com/repos/OpenWhispr/openwhispr/releases?per_page=100": {
      json: Array.from({ length: 50 }, (_, i) => ({ tag_name: `v1.9.${i}` })),
      link: '<https://api.github.com/repos/OpenWhispr/openwhispr/releases?page=2>; rel="next"',
    },
    "https://api.github.com/repos/OpenWhispr/openwhispr/releases?page=2": {
      json: [
        { tag_name: "v1.8.0" },
        {
          tag_name: "windows-key-listener-v1.0.0",
          html_url: "https://github.com/OpenWhispr/openwhispr/releases/tag/windows-key-listener-v1.0.0",
          assets: [{ name: "windows-key-listener-win32-x64.zip", browser_download_url: "https://example.test/key.zip" }],
        },
      ],
      link: "",
    },
  };

  const requested = [];
  const release = await fetchLatestRelease("OpenWhispr/openwhispr", {
    tagPrefix: "windows-key-listener-v",
    fetchPage: async (url) => {
      requested.push(url);
      return pages[url];
    },
  });

  assert.equal(release.tag, "windows-key-listener-v1.0.0");
  assert.equal(release.assets[0].name, "windows-key-listener-win32-x64.zip");
  assert.deepEqual(requested, [
    "https://api.github.com/repos/OpenWhispr/openwhispr/releases?per_page=100",
    "https://api.github.com/repos/OpenWhispr/openwhispr/releases?page=2",
  ]);
});

test("fetchLatestRelease returns null when no page matches the prefix", async () => {
  const release = await fetchLatestRelease("OpenWhispr/openwhispr", {
    tagPrefix: "windows-key-listener-v",
    fetchPage: async () => ({
      json: [{ tag_name: "v1.9.3" }],
      link: "",
    }),
  });

  assert.equal(release, null);
});
