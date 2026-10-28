// Reads who is talking out of a meeting app's accessibility snapshot (emitted
// by resources/macos-meeting-speaker-listener.swift). Each adapter turns one
// app's windows into a roster plus the participants it shows as speaking;
// meetingSpeakerFusion.js matches those against the voices in the audio.
//
// Every rule here is checked against `--dump`s of real calls
// (test/helpers/fixtures/). No app marks the speaker on its tiles in a way
// accessibility can see, so two signals remain:
// - the speaker layout (Zoom's Speaker view, Meet's Spotlight, Teams'
//   Speaker view), which shows whoever is talking as one large tile; gallery
//   and tiled layouts say nothing about who talks
// - live captions in Meet and Teams, which start each block with the
//   speaker's name and work in any layout. The helper reports a caption line
//   only when it is at most 80 characters, and a line counts only when it is
//   a name on the roster
// Zoom's tile-status and "Talking:" rules were never seen in a real dump: they
// stay provisional and rank below the calibrated Speaker view. Meeting apps
// restyle their UI without notice, which is why the rules live here beside
// their tests rather than in the native helper.

const EMPTY_SPEAKER_STATE = Object.freeze({ participants: [], speakingIds: [], strategy: "none" });

const MAX_NAME_LENGTH = 80;
// Same thumbnail size as minTileWidth/minTileHeight in the helper.
const MIN_TILE_WIDTH = 120;
const MIN_TILE_HEIGHT = 68;
// A speaker layout shows the speaker at several times any other tile's size;
// equal tiles (gallery) name no one. Zoom keeps its own window-share rule,
// which was calibrated before this one.
const SPEAKER_TILE_MIN_RATIO = 4;
// When two meetings are read at once, the more direct signal wins.
const STRATEGY_RANK = { captions: 3, "speaker-view": 2, "tile-status": 1, "talking-label": 1 };

// Annotations meeting apps put after a display name: Zoom's "(Host, me)",
// Teams' "(Guest)".
const NAME_ANNOTATION =
  /\s*\((?:host|co-host|guest|me|external|unverified)(?:\s*,\s*(?:host|co-host|guest|me))*\)\s*$/i;

// Display names are the only identity the tree exposes. Known cost: two
// participants with the same name ("iPhone") read as one.
function participantIdForName(name) {
  return name.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

function nodeText(node) {
  return String(node?.description || node?.title || "").trim();
}

function nodeValue(node) {
  return typeof node?.value === "string" ? node.value : "";
}

// Splits "Gabe (Host, me), Computer audio muted" at top-level commas only, so
// the role annotation stays with the name.
function splitLabelParts(text) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current.trim());
  return parts;
}

// A given name after a "Last, First" comma: one or two words, each starting
// with a capital (or a letter of a script without case).
const GIVEN_NAME = /^[\p{Lu}\p{Lo}][\p{L}\p{M}'’.-]*(?: [\p{Lu}\p{Lo}][\p{L}\p{M}'’.-]*)?$/u;

// "Doe, Jane, Computer audio muted": the name keeps its comma when the part
// after it reads as a given name and a known status follows. Anything else
// ("Jane Doe, Raised hand, muted", a status in another language) leaves the
// first part as the name, as before. A one-word status missing from the list
// would join the name, so the lists carry every status seen or documented.
function splitNameFromStatus(parts, statusTokens) {
  const [first = "", second, third] = parts;
  if (
    second &&
    third &&
    GIVEN_NAME.test(second.replace(NAME_ANNOTATION, "")) &&
    !statusTokens.has(second.toLowerCase()) &&
    statusTokens.has(third.toLowerCase())
  ) {
    return { rawName: `${first}, ${second}`, tokens: parts.slice(2) };
  }
  return { rawName: first, tokens: parts.slice(1) };
}

function parseDisplayName(rawName) {
  const annotation = rawName.match(NAME_ANNOTATION);
  const name = (annotation ? rawName.slice(0, annotation.index) : rawName).trim();
  if (!name || name.length > MAX_NAME_LENGTH) return null;
  return { name, isSelf: !!annotation && /\bme\b/i.test(annotation[0]) };
}

function frameArea(frame) {
  const [, , width = 0, height = 0] = Array.isArray(frame) ? frame : [];
  return width > 0 && height > 0 ? width * height : 0;
}

function isTileSized(frame) {
  const [, , width = 0, height = 0] = Array.isArray(frame) ? frame : [];
  return width >= MIN_TILE_WIDTH && height >= MIN_TILE_HEIGHT;
}

function frameContains(outer, inner) {
  return (
    Array.isArray(outer) &&
    Array.isArray(inner) &&
    inner[0] >= outer[0] &&
    inner[1] >= outer[1] &&
    inner[0] + inner[2] <= outer[0] + outer[2] + 1 &&
    inner[1] + inner[3] <= outer[1] + outer[3] + 1
  );
}

// One person can show twice (speaker view's main video and its thumbnail);
// the larger tile keeps their name and state.
function addTile(tiles, { name, frame, isSelf = false, muted = false, speaking = false }) {
  const id = participantIdForName(name);
  const area = frameArea(frame);
  const existing = tiles.get(id);
  const larger = !existing || area > existing.area;
  tiles.set(id, {
    id,
    name: larger ? name : existing.name,
    isSelf: isSelf || !!existing?.isSelf,
    muted: larger ? muted : existing.muted,
    speaking: speaking || !!existing?.speaking,
    area: Math.max(area, existing?.area ?? 0),
  });
}

function speakerFromLayout(tiles) {
  const [main, runnerUp] = [...tiles.values()].sort((a, b) => b.area - a.area);
  if (!main || !runnerUp || main.muted) return null;
  return main.area >= runnerUp.area * SPEAKER_TILE_MIN_RATIO ? main.id : null;
}

// The newest caption block names who is talking. Returns { id } for a roster
// participant, { self: true } for the user's own captions ("You", or a name the
// session knows is theirs), { unknown: true } when the newest block is someone
// not on the roster, or null without a caption bar. A block's name line has
// its own height (Teams' is shorter than its text, Meet's taller than a
// wrapped line), so a newer name line that matches no one is caught rather
// than crediting an older block.
const HEADER_X_TOLERANCE_PX = 4;
const HEADER_HEIGHT_TOLERANCE_PX = 2;

function speakerFromCaptions(nodes, { regionLabel, regionSubrole, roster, selfIds }) {
  const region = nodes.find(
    (node) => nodeText(node) === regionLabel && (!regionSubrole || node.subrole === regionSubrole)
  )?.frame;
  if (!region) return null;

  const lines = nodes.filter(
    (node) => node?.role === "AXStaticText" && nodeValue(node) && frameContains(region, node.frame)
  );
  const matchLine = (line) => {
    if (line.value === "You") return { self: true };
    const parsed = parseDisplayName(line.value);
    const id = parsed ? participantIdForName(parsed.name) : null;
    if (selfIds?.has(id)) return { self: true };
    return roster.has(id) ? { id } : null;
  };

  let newest = null;
  for (const line of lines) {
    const match = matchLine(line);
    if (match && (!newest || line.frame[1] >= newest.line.frame[1])) newest = { line, match };
  }
  if (!newest) return lines.length ? { unknown: true } : null;

  // Lines below the newest match never match themselves (it is the lowest).
  const [x, y, , height] = newest.line.frame;
  const newerHeader = lines.some(
    (line) =>
      line.frame[1] > y &&
      Math.abs(line.frame[0] - x) <= HEADER_X_TOLERANCE_PX &&
      Math.abs(line.frame[3] - height) <= HEADER_HEIGHT_TOLERANCE_PX
  );
  return newerHeader ? { unknown: true } : newest.match;
}

function stateFor(tiles, extraParticipants, captions, { truncated = false } = {}) {
  const participants = new Map();
  for (const { id, name, isSelf } of [...tiles.values(), ...extraParticipants]) {
    const known = participants.get(id);
    participants.set(id, { id, name: known?.name ?? name, isSelf: !!known?.isSelf || !!isSelf });
  }
  const roster = [...participants.values()];
  // A cut-off tree can be missing the newest caption or a tile, which would
  // read as a different speaker.
  if (truncated) return { participants: roster, speakingIds: [], strategy: "none" };
  if (captions) {
    const speakingIds = captions.id && !participants.get(captions.id)?.isSelf ? [captions.id] : [];
    return { participants: roster, speakingIds, strategy: "captions" };
  }
  const layoutSpeaker = speakerFromLayout(tiles);
  if (layoutSpeaker) {
    return { participants: roster, speakingIds: [layoutSpeaker], strategy: "speaker-view" };
  }
  return { participants: roster, speakingIds: [], strategy: "none" };
}

function rosterFor(tiles, extraParticipants, knownParticipants) {
  return new Set([
    ...tiles.keys(),
    ...extraParticipants.map((participant) => participant.id),
    ...(knownParticipants?.keys() ?? []),
  ]);
}

// Everyone this snapshot or the session marks as the user.
function selfIdsFor(tiles, knownSelfIds) {
  const ids = new Set(knownSelfIds ?? []);
  for (const tile of tiles.values()) if (tile.isSelf) ids.add(tile.id);
  return ids;
}

// Zoom desktop, checked against 7.2.2. Tiles are AXTabGroups labelled "Name,
// Computer audio muted, Video on"; matching the role keeps this independent of
// Zoom's UI language and rules out the home window's tile-sized web panels.
// The user is named by the home window's profile button ("Zoom, Jane Doe, In a
// Zoom Meeting, Basic account"), since tiles never mark them and the
// participants panel's "(Host, me)" is a value, which Zoom snapshots leave out.
const ZOOM_BUNDLE_IDS = ["us.zoom.xos"];
const ZOOM_TILE_ROLE = "AXTabGroup";
const ZOOM_SPEAKING_TOKENS = new Set(["talking", "speaking", "active speaker"]);
const ZOOM_MUTED_TOKENS = new Set([
  "muted",
  "audio muted",
  "computer audio muted",
  "microphone muted",
]);
const ZOOM_STATUS_TOKENS = new Set([
  ...ZOOM_SPEAKING_TOKENS,
  ...ZOOM_MUTED_TOKENS,
  "unmuted",
  "audio unmuted",
  "computer audio unmuted",
  "phone audio muted",
  "phone audio unmuted",
  "video on",
  "video off",
  "raised hand",
  "hand raised",
  "pinned",
  "spotlighted",
]);
// The header label Zoom shows over shared screens, where tiles shrink or vanish.
const ZOOM_TALKING_LABEL = /^talking:\s*(.+)$/i;
const ZOOM_SHARE_TILE = /screen shar|'s screen\b/i;
// Speaker view shows the active speaker over most of the window and everyone
// else as thumbnails. Known cost: a pinned or spotlighted video looks the
// same and is read as the speaker for as long as it stays pinned.
const ZOOM_SPEAKER_VIEW_MIN_SHARE = 0.4;
const ZOOM_THUMBNAIL_MAX_SHARE = 0.15;

function parseZoomTileText(text) {
  if (!text || ZOOM_SHARE_TILE.test(text)) return null;

  const { rawName, tokens } = splitNameFromStatus(splitLabelParts(text), ZOOM_STATUS_TOKENS);
  const parsedName = parseDisplayName(rawName);
  if (!parsedName) return null;

  const lowered = tokens.map((token) => token.toLowerCase());
  return {
    ...parsedName,
    speaking: lowered.some((token) => ZOOM_SPEAKING_TOKENS.has(token)),
    muted: lowered.some((token) => ZOOM_MUTED_TOKENS.has(token)),
  };
}

function collectZoomTiles(window) {
  const tiles = new Map();
  for (const node of window?.nodes || []) {
    if (node?.role !== ZOOM_TILE_ROLE || !isTileSized(node.frame)) continue;
    const parsed = parseZoomTileText(nodeText(node));
    if (parsed) addTile(tiles, { ...parsed, frame: node.frame });
  }
  return tiles;
}

// "Zoom, Doe, Jane, In a Zoom Meeting, …": the name may hold a comma too. The
// joined name counts when a tile carries it, otherwise the first part (so with
// the user's tile hidden, a remote called just "Doe" would read as the user).
function collectZoomSelfIds(windows, tiles) {
  const ids = new Set();
  for (const window of windows) {
    for (const node of window?.nodes || []) {
      if (node?.role !== "AXButton") continue;
      const [brand, rawName, ...status] = splitLabelParts(nodeText(node));
      if (brand !== "Zoom" || !rawName || !status.length) continue;
      const joined = GIVEN_NAME.test(status[0])
        ? parseDisplayName(`${rawName}, ${status[0]}`)
        : null;
      const joinedId = joined ? participantIdForName(joined.name) : null;
      const parsed = parseDisplayName(rawName);
      if (joinedId && tiles.has(joinedId)) ids.add(joinedId);
      else if (parsed) ids.add(participantIdForName(parsed.name));
    }
  }
  return ids;
}

function collectZoomTalkingNames(windows) {
  const names = [];
  for (const window of windows) {
    for (const node of window?.nodes || []) {
      const match = nodeText(node).match(ZOOM_TALKING_LABEL);
      if (!match) continue;
      for (const rawName of splitLabelParts(match[1])) {
        const parsed = parseDisplayName(rawName);
        if (parsed) names.push(parsed);
      }
    }
  }
  return names;
}

function interpretZoomWindows(windows) {
  // The meeting window is the one showing the most participant tiles; this
  // avoids matching window titles, which Zoom localizes.
  let meeting = null;
  for (const window of windows) {
    const tiles = collectZoomTiles(window);
    if (!meeting || tiles.size > meeting.tiles.size) meeting = { window, tiles };
  }
  const tiles = meeting?.tiles ?? new Map();
  const selfIds = collectZoomSelfIds(windows, tiles);
  for (const tile of tiles.values()) {
    if (selfIds.has(tile.id)) tile.isSelf = true;
  }
  // A cut-off Zoom tree still holds Speaker view's main tile, which comes early
  // in the helper's breadth-first read; a missing thumbnail only weakens the
  // rule's runner-up check, so truncation isn't held against Zoom.
  const participants = [...tiles.values()].map(({ id, name, isSelf }) => ({ id, name, isSelf }));

  const windowArea = frameArea(meeting?.window?.frame);
  const [main, runnerUp] = [...tiles.values()].sort((a, b) => b.area - a.area);
  if (
    main &&
    windowArea > 0 &&
    !main.muted &&
    main.area / windowArea >= ZOOM_SPEAKER_VIEW_MIN_SHARE &&
    (!runnerUp || runnerUp.area / windowArea <= ZOOM_THUMBNAIL_MAX_SHARE)
  ) {
    return { participants, speakingIds: [main.id], strategy: "speaker-view" };
  }

  const flagged = [...tiles.values()].filter((tile) => tile.speaking && !tile.muted);
  if (flagged.length) {
    return { participants, speakingIds: flagged.map((tile) => tile.id), strategy: "tile-status" };
  }

  const talking = collectZoomTalkingNames(windows);
  if (talking.length) {
    const speakingIds = [];
    for (const { name, isSelf } of talking) {
      const id = participantIdForName(name);
      if (tiles.get(id)?.muted || speakingIds.includes(id)) continue;
      if (!tiles.has(id)) participants.push({ id, name, isSelf: isSelf || selfIds.has(id) });
      speakingIds.push(id);
    }
    return { participants, speakingIds, strategy: "talking-label" };
  }

  return { participants, speakingIds: [], strategy: "none" };
}

// Browser meetings: only Chrome is checked so far, and only English labels.
// The helper reads a window only while its front tab's title matches the
// adapter's page title, only the page inside it, and only while the page
// carries the adapter's call control (page marker), so a Teams chat or
// calendar page is never read.
const BROWSER_BUNDLE_IDS = ["com.google.Chrome"];

// Teams on the web, checked against teams.live.com (Oct 2026). Tiles are
// AXMenuItems labelled "Jane Doe (Guest), video is on, muted, Context menu is
// available"; the user's own tile reads "Myself video, Jane Doe, Muted, …" (an
// AXImage in Speaker view). Participant rows: "Jane Doe (Guest), Meeting
// guest, Unmuted". Caption blocks sit in a "Live Captions" group, each name
// line shorter than its text.
const TEAMS_PAGE_TITLE = "\\| Microsoft Teams\\b";
// A call's video tile: a chat or calendar page, even one showing the compact
// call bar, has none.
const TEAMS_PAGE_MARKER = "(?:Context menu is available|Has context menu)$";
const TEAMS_TILE_ROLES = new Set(["AXMenuItem", "AXImage"]);
const TEAMS_SELF_PREFIX = "myself video";
const TEAMS_STATUS_TOKENS = new Set([
  "muted",
  "unmuted",
  "raised hand",
  "hand raised",
  "pinned",
  "spotlighted",
  "presenting",
  "video is on",
  "video is off",
  "context menu is available",
  "has context menu",
  "meeting guest",
  "organizer",
  "co-organizer",
  "presenter",
  "attendee",
]);
// Not seen in a dump yet: what Teams calls a shared screen or presentation.
const TEAMS_SHARE_TILE = /\bshared (?:screen|content)\b|'s screen\b|\bpresent(?:ing|ation)\b/i;
const TEAMS_CAPTIONS_LABEL = "Live Captions";

function parseTeamsLabel(text) {
  const parts = splitLabelParts(text);
  const isSelf = parts[0]?.toLowerCase() === TEAMS_SELF_PREFIX;
  const { rawName, tokens } = splitNameFromStatus(
    isSelf ? parts.slice(1) : parts,
    TEAMS_STATUS_TOKENS
  );
  const parsed = parseDisplayName(rawName);
  if (!parsed) return null;
  return { name: parsed.name, isSelf, tokens: tokens.map((token) => token.toLowerCase()) };
}

function interpretTeamsWebWindows(windows, { knownParticipants, knownSelfIds } = {}) {
  const tiles = new Map();
  const rows = [];
  const nodes = windows.flatMap((window) => window?.nodes || []);
  for (const node of nodes) {
    const text = nodeText(node);
    if (TEAMS_TILE_ROLES.has(node?.role) && isTileSized(node.frame)) {
      if (TEAMS_SHARE_TILE.test(text)) continue;
      const parsed = parseTeamsLabel(text);
      // A tile's label always carries a status part; a bare image doesn't.
      if (parsed && (parsed.isSelf || parsed.tokens.length)) {
        addTile(tiles, { ...parsed, muted: parsed.tokens.includes("muted"), frame: node.frame });
      }
    } else if (node?.role === "AXRow" && node.subrole === "AXOutlineRow") {
      // A participant's row ends with their mic state; the list's own header
      // row ("In this meeting, 3 total Mute all") doesn't.
      const parsed = parseTeamsLabel(text);
      const micState = parsed?.tokens.at(-1);
      if (micState === "muted" || micState === "unmuted") {
        rows.push({ id: participantIdForName(parsed.name), name: parsed.name, isSelf: false });
      }
    }
  }
  const captions = speakerFromCaptions(nodes, {
    regionLabel: TEAMS_CAPTIONS_LABEL,
    roster: rosterFor(tiles, rows, knownParticipants),
    selfIds: selfIdsFor(tiles, knownSelfIds),
  });
  return stateFor(tiles, rows, captions, {
    truncated: windows.some((window) => window?.truncated),
  });
}

// Google Meet in Chrome, checked against meet.google.com (Oct 2026). Tiles are
// unlabelled groups with the participant's name in a static text at their
// bottom-left corner; a tile's own inner groups can contain the name too, so
// the tile is the largest group whose corner sits at the label. Text inside a
// landmark region (the caption bar, notifications) is never a tile's name,
// whatever the UI language. Meet marks neither the user's tile (its hover
// controls sit inside whatever tile holds the self view, a spotlit remote's
// included, so they can't say whose tile it is) nor a muted mic; the user's
// own captions read "You". Caption blocks sit in a "Captions"
// landmark region. A Meet tab's title only reads "Meet – <code>" in a call
// (or its waiting room, which has no tiles), so the page's own title is its
// marker, whatever the UI language.
const MEET_PAGE_TITLE = "^Meet [–-] ";
const MEET_PAGE_MARKER = MEET_PAGE_TITLE;
const MEET_LABEL_CORNER_PX = 40;
const MEET_CAPTIONS_LABEL = "Captions";
const MEET_MORE_OPTIONS = /^More options for (.+)$/;
// Not seen in a dump yet: Meet's label for a presented screen.
const MEET_SHARE_TILE = /\(presentation\)|\bpresenting\b/i;

// Names don't read like sentences; caption lines that escape the caption bar
// usually do. A final period counts only after a full word, so "Jane Doe Jr."
// and "Dr. A. B." stay names.
function looksLikeSentence(text) {
  const words = text.split(/\s+/);
  const lastWord = words.at(-1).replace(/\.$/, "");
  return (
    words.length > 7 ||
    /[!?…]$/.test(text) ||
    (text.endsWith(".") && words.length >= 3 && lastWord.length > 3)
  );
}

function interpretMeetWindows(windows, { knownParticipants, knownSelfIds } = {}) {
  const tiles = new Map();
  const extra = [];
  const nodes = windows.flatMap((window) => window?.nodes || []);
  const regions = nodes
    .filter((node) => node?.subrole === "AXLandmarkRegion" && node.frame)
    .map((node) => node.frame);
  const groups = nodes.filter(
    (node) => node?.role === "AXGroup" && !nodeText(node) && isTileSized(node.frame)
  );

  for (const node of nodes) {
    const optionsFor = nodeText(node).match(MEET_MORE_OPTIONS);
    if (optionsFor) {
      const parsed = parseDisplayName(optionsFor[1]);
      if (parsed)
        extra.push({ id: participantIdForName(parsed.name), name: parsed.name, isSelf: false });
      continue;
    }
    const value = nodeValue(node);
    if (node?.role !== "AXStaticText" || !value || !Array.isArray(node.frame)) continue;
    if (regions.some((region) => frameContains(region, node.frame))) continue;
    if (MEET_SHARE_TILE.test(value) || looksLikeSentence(value)) continue;

    const [labelX, labelY, , labelHeight] = node.frame;
    let tile = null;
    for (const group of groups) {
      const [x, y, , height] = group.frame;
      if (!frameContains(group.frame, node.frame)) continue;
      if (labelX - x > MEET_LABEL_CORNER_PX) continue;
      if (y + height - (labelY + labelHeight) > MEET_LABEL_CORNER_PX) continue;
      if (!tile || frameArea(group.frame) > frameArea(tile.frame)) tile = group;
    }
    const parsed = tile ? parseDisplayName(value) : null;
    if (parsed) addTile(tiles, { name: parsed.name, frame: tile.frame });
  }

  const captions = speakerFromCaptions(nodes, {
    regionLabel: MEET_CAPTIONS_LABEL,
    regionSubrole: "AXLandmarkRegion",
    roster: rosterFor(tiles, extra, knownParticipants),
    selfIds: selfIdsFor(tiles, knownSelfIds),
  });
  return stateFor(tiles, extra, captions, {
    truncated: windows.some((window) => window?.truncated),
  });
}

const MEETING_APP_SPEAKER_ADAPTERS = [
  { app: "zoom", bundleIds: ZOOM_BUNDLE_IDS, interpret: interpretZoomWindows },
  {
    app: "meet",
    bundleIds: BROWSER_BUNDLE_IDS,
    pageTitle: MEET_PAGE_TITLE,
    pageMarker: MEET_PAGE_MARKER,
    interpret: interpretMeetWindows,
  },
  {
    app: "teams-web",
    bundleIds: BROWSER_BUNDLE_IDS,
    pageTitle: TEAMS_PAGE_TITLE,
    pageMarker: TEAMS_PAGE_MARKER,
    interpret: interpretTeamsWebWindows,
  },
];

for (const adapter of MEETING_APP_SPEAKER_ADAPTERS) {
  if (adapter.pageTitle) adapter.pageTitleRegex = new RegExp(adapter.pageTitle);
}

// The helper's targets: each bundle id once, with the page title and marker
// of every adapter that reads it through a browser tab.
const MEETING_APP_SPEAKER_TARGETS = (() => {
  const targets = new Map();
  for (const adapter of MEETING_APP_SPEAKER_ADAPTERS) {
    for (const bundleId of adapter.bundleIds) {
      const target = targets.get(bundleId) ?? { bundleId, pages: [] };
      if (adapter.pageTitle) {
        target.pages.push({ pageTitle: adapter.pageTitle, pageMarker: adapter.pageMarker });
      }
      targets.set(bundleId, target);
    }
  }
  return [...targets.values()];
})();

// The helper tags a browser window with the index of the page kind it matched
// (in MEETING_APP_SPEAKER_TARGETS order); a window without one (a native app,
// an older snapshot) is matched by its title.
function adapterForWindow(window) {
  const candidates = MEETING_APP_SPEAKER_ADAPTERS.filter((adapter) =>
    adapter.bundleIds.includes(window?.bundleId)
  );
  if (Number.isInteger(window?.page)) {
    return candidates.filter((adapter) => adapter.pageTitle)[window.page];
  }
  return candidates.find(
    (adapter) => !adapter.pageTitleRegex || adapter.pageTitleRegex.test(window?.title || "")
  );
}

// snapshot: { windows: [{ bundleId, title, frame, truncated, nodes: [{ role,
// subrole, title, description, value, frame }] }] }. knownParticipants and
// knownSelfIds are who the session has seen and who it knows is the user, so
// a caption from someone whose tile is off screen still matches, and one
// with the user's name never names a remote voice. Each app's windows go to its adapter; when
// several meetings are open, the most direct signal wins and every roster is
// kept. Returns { participants, speakingIds, strategy }.
function interpretMeetingAppSnapshot(snapshot, context = {}) {
  const windows = Array.isArray(snapshot?.windows) ? snapshot.windows : [];
  const byAdapter = new Map();
  for (const window of windows) {
    const adapter = adapterForWindow(window);
    if (!adapter) continue;
    if (!byAdapter.has(adapter)) byAdapter.set(adapter, []);
    byAdapter.get(adapter).push(window);
  }

  const states = [...byAdapter].map(([adapter, adapterWindows]) =>
    adapter.interpret(adapterWindows, context)
  );
  if (!states.length) return EMPTY_SPEAKER_STATE;
  const byRank = (a, b) => (STRATEGY_RANK[b.strategy] ?? 0) - (STRATEGY_RANK[a.strategy] ?? 0);
  // With nobody speaking, the strategy still says which signal said so.
  const speaking =
    states.filter((state) => state.speakingIds.length).sort(byRank)[0] ??
    [...states].sort(byRank)[0];
  const participants = new Map();
  for (const participant of states.flatMap((state) => state.participants)) {
    const known = participants.get(participant.id);
    participants.set(participant.id, {
      ...participant,
      isSelf: participant.isSelf || !!known?.isSelf,
    });
  }
  return {
    participants: [...participants.values()],
    speakingIds: speaking?.speakingIds ?? [],
    strategy: speaking?.strategy ?? "none",
  };
}

module.exports = {
  EMPTY_SPEAKER_STATE,
  MEETING_APP_SPEAKER_TARGETS,
  interpretMeetingAppSnapshot,
  parseTeamsLabel,
  parseZoomTileText,
  participantIdForName,
};
