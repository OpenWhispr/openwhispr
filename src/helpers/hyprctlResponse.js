// hyprctl exits 0 even when the compositor rejects the command, reporting the
// failure only in its response text — e.g. under the Lua config provider,
// `hyprctl keyword bind` prints "keyword can't work with non-legacy parsers.
// Use eval." and the bind never registers (#1675). A successful keyword
// command answers "ok" (one per request); anything else is a rejection. Empty
// output is tolerated so a hyprctl build that prints nothing on success does
// not regress to a permanently failing bind.
function isHyprctlResponseOk(output) {
  const lines = String(output ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.every((line) => line.toLowerCase() === "ok");
}

module.exports = { isHyprctlResponseOk };
