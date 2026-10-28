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
//   speaker's name and work in any layout. Only names are read from them:
//   caption sentences longer than 80 characters never leave the helper, and
//   the shorter ones are matched against the roster and dropped
// Zoom's tile-status and "Talking:" rules were never seen in a real dump and
// stay provisional. Meeting apps restyle their UI without notice, which is
// why the rules live here beside their tests rather than in the native helper.

const EMPTY_STATE = Object.freeze({ participants: [], speakingIds: [], strategy: "none" });

const MAX_NAME_LENGTH = 80;

const ZOOM_BUNDLE_IDS = ["us.zoom.xos"];
// Zoom 7.2's video tiles are AXTabGroups labelled "Name, Computer audio muted,
// Video on" (checked against --dump of 7.2.2). Matching the role keeps this
// independent of Zoom's UI language, and rules out the home window's web
// panels ("Zoom Calendar Sidebar"), which carry tile-sized labels too.
const ZOOM_TILE_ROLE = "AXTabGroup";
// Video tiles are at least thumbnail-sized.
const ZOOM_MIN_TILE_WIDTH = 120;
const ZOOM_MIN_TILE_HEIGHT = 68;
// Status parts that follow the name in a tile's label ("Jane Doe, Talking").
const ZOOM_SPEAKING_TOKENS = new Set(["talking", "speaking", "active speaker"]);
const ZOOM_MUTED_TOKENS = new Set([
  "muted",
  "audio muted",
  "computer audio muted",
  "microphone muted",
]);
// Zoom's role annotations after a name: "(Host)", "(Co-host)", "(Host, me)".
const ZOOM_ROLE_SUFFIX =
  /\s*\((?:host|co-host|guest|me)(?:\s*,\s*(?:host|co-host|guest|me))*\)\s*$/i;
// The header label Zoom shows over shared screens, where tiles shrink or vanish.
const ZOOM_TALKING_LABEL = /^talking:\s*(.+)$/i;
const ZOOM_SHARE_TILE = /screen shar|'s screen\b/i;
// Speaker view shows the active speaker over most of the window and everyone
// else as thumbnails. One tile that large is the app's own pick of speaker;
// two large tiles are a small gallery, which says nothing about who talks.
// Known cost: a pinned or spotlighted video looks the same and is read as the
// speaker for as long as it stays pinned.
const ZOOM_SPEAKER_VIEW_MIN_SHARE = 0.4;
const ZOOM_THUMBNAIL_MAX_SHARE = 0.15;

// Display names are the only identity the tree exposes. Known cost: two
// participants with the same name ("iPhone") read as one.
function participantIdForName(name) {
  return name.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

function nodeText(node) {
  return String(node?.description || node?.title || "").trim();
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

function frameArea(frame) {
  const [, , width = 0, height = 0] = Array.isArray(frame) ? frame : [];
  return width > 0 && height > 0 ? width * height : 0;
}

function parseZoomName(rawName) {
  const roleMatch = rawName.match(ZOOM_ROLE_SUFFIX);
  const name = (roleMatch ? rawName.slice(0, roleMatch.index) : rawName).trim();
  if (!name || name.length > MAX_NAME_LENGTH) return null;
  return { name, isSelf: !!roleMatch && /\bme\b/i.test(roleMatch[0]) };
}

function parseZoomTileText(text) {
  if (!text || ZOOM_SHARE_TILE.test(text)) return null;

  const [rawName, ...rawTokens] = splitLabelParts(text);
  const parsedName = parseZoomName(rawName);
  if (!parsedName) return null;

  const tokens = rawTokens.map((token) => token.toLowerCase());
  return {
    ...parsedName,
    speaking: tokens.some((token) => ZOOM_SPEAKING_TOKENS.has(token)),
    muted: tokens.some((token) => ZOOM_MUTED_TOKENS.has(token)),
  };
}

function collectZoomTiles(window) {
  const tiles = new Map();
  for (const node of window?.nodes || []) {
    const [, , width = 0, height = 0] = Array.isArray(node?.frame) ? node.frame : [];
    if (node?.role !== ZOOM_TILE_ROLE) continue;
    if (width < ZOOM_MIN_TILE_WIDTH || height < ZOOM_MIN_TILE_HEIGHT) continue;

    const parsed = parseZoomTileText(nodeText(node));
    if (!parsed) continue;

    // One person can show twice: speaker view's main video and its thumbnail.
    const id = participantIdForName(parsed.name);
    const area = width * height;
    const existing = tiles.get(id);
    tiles.set(id, {
      id,
      name: existing && existing.area >= area ? existing.name : parsed.name,
      isSelf: parsed.isSelf || !!existing?.isSelf,
      speaking: parsed.speaking || !!existing?.speaking,
      muted: parsed.muted || !!existing?.muted,
      area: Math.max(area, existing?.area ?? 0),
    });
  }
  return tiles;
}

// Tiles never mark the user, and the participants panel's "(Host, me)" is an
// AXValue, which snapshots leave out. The home window's profile button carries
// the signed-in name instead: "Zoom, Jane Doe, In a Zoom Meeting, Basic account".
function collectZoomSelfIds(windows) {
  const ids = new Set();
  for (const window of windows) {
    for (const node of window?.nodes || []) {
      if (node?.role !== "AXButton") continue;
      const [brand, rawName, ...status] = splitLabelParts(nodeText(node));
      if (brand !== "Zoom" || !rawName || !status.length) continue;
      const parsed = parseZoomName(rawName);
      if (parsed) ids.add(participantIdForName(parsed.name));
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
        const parsed = parseZoomName(rawName);
        if (parsed) names.push(parsed);
      }
    }
  }
  return names;
}

function interpretZoomSnapshot(snapshot) {
  const windows = Array.isArray(snapshot?.windows) ? snapshot.windows : [];

  // The meeting window is the one showing the most participant tiles; this
  // avoids matching window titles, which Zoom localizes.
  let meeting = null;
  for (const window of windows) {
    const tiles = collectZoomTiles(window);
    if (!meeting || tiles.size > meeting.tiles.size) meeting = { window, tiles };
  }
  const tiles = meeting?.tiles ?? new Map();
  const selfIds = collectZoomSelfIds(windows);
  for (const tile of tiles.values()) {
    if (selfIds.has(tile.id)) tile.isSelf = true;
  }
  const participants = [...tiles.values()].map(({ id, name, isSelf }) => ({ id, name, isSelf }));

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

  return { participants, speakingIds: [], strategy: "none" };
}

// Browser meetings: only Chrome is checked so far. The helper reads a browser
// window only while its front tab's title matches the adapter's pattern, and
// then only the page, never the tab strip. Tab titles aren't localized here:
// Meet's is "Meet – <code>", Teams' "<meeting> | Microsoft Teams".
const BROWSER_BUNDLE_IDS = ["com.google.Chrome"];
const MEET_PAGE_TITLE = "^Meet [–-] ";
const TEAMS_PAGE_TITLE = "\\| Microsoft Teams\\b";

// A speaker layout shows the speaker at several times any other tile's size;
// equal tiles (gallery) name no one. Zoom keeps its own window-share rule,
// which was calibrated before this one.
const SPEAKER_TILE_MIN_RATIO = 4;
const MIN_TILE_WIDTH = 120;
const MIN_TILE_HEIGHT = 68;

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

function isTileSized(frame) {
  const [, , width = 0, height = 0] = Array.isArray(frame) ? frame : [];
  return width >= MIN_TILE_WIDTH && height >= MIN_TILE_HEIGHT;
}

function speakerFromLayout(tiles) {
  const [main, runnerUp] = [...tiles.values()].sort((a, b) => b.area - a.area);
  if (!main || !runnerUp || main.muted) return null;
  return main.area >= runnerUp.area * SPEAKER_TILE_MIN_RATIO ? main.id : null;
}

// Caption bars start each block with the speaker's name, newest at the bottom.
// Only a line equal to a known participant's name counts, so a short caption
// sentence can never be taken for a name.
function speakerFromCaptions(nodes, regionLabel, roster) {
  const region = nodes.find((node) => nodeText(node) === regionLabel)?.frame;
  if (!region) return null;
  let newest = null;
  for (const node of nodes) {
    if (node?.role !== "AXStaticText" || !node.value || !frameContains(region, node.frame))
      continue;
    const id = participantIdForName(node.value);
    if (!roster.has(id)) continue;
    if (!newest || node.frame[1] >= newest.frame[1]) newest = { id, frame: node.frame };
  }
  return newest?.id ?? null;
}

function stateFor(tiles, extraParticipants, captionSpeaker) {
  const participants = new Map();
  for (const { id, name, isSelf } of [...tiles.values(), ...extraParticipants]) {
    const known = participants.get(id);
    participants.set(id, { id, name: known?.name ?? name, isSelf: !!known?.isSelf || !!isSelf });
  }
  const roster = [...participants.values()];
  if (captionSpeaker) {
    return { participants: roster, speakingIds: [captionSpeaker], strategy: "captions" };
  }
  const layoutSpeaker = speakerFromLayout(tiles);
  if (layoutSpeaker) {
    return { participants: roster, speakingIds: [layoutSpeaker], strategy: "speaker-view" };
  }
  return { participants: roster, speakingIds: [], strategy: "none" };
}

function addTile(tiles, { name, isSelf = false, muted = false, frame }) {
  const id = participantIdForName(name);
  const area = frameArea(frame);
  const existing = tiles.get(id);
  tiles.set(id, {
    id,
    name: existing && existing.area >= area ? existing.name : name,
    isSelf: isSelf || !!existing?.isSelf,
    muted: existing && existing.area >= area ? existing.muted : muted,
    area: Math.max(area, existing?.area ?? 0),
  });
}

// Teams on the web, checked against teams.live.com (Oct 2026). Tiles are
// AXMenuItems labelled "Jane Doe (Guest), video is on, muted, Context menu is
// available"; the user's own tile reads "Myself video, Jane Doe, Muted, …" (an
// AXImage in Speaker view). Participant rows: "Jane Doe (Guest), Meeting
// guest, Unmuted". Captions sit in a "Live Captions" group. English labels only.
const TEAMS_TILE_ROLES = new Set(["AXMenuItem", "AXImage"]);
const TEAMS_SELF_PREFIX = "myself video";
const TEAMS_NAME_SUFFIX = /\s*\((?:guest|external|unverified)\)\s*$/i;
const TEAMS_CAPTIONS_LABEL = "Live Captions";

function parseTeamsLabel(text) {
  const parts = splitLabelParts(text);
  const isSelf = parts[0]?.toLowerCase() === TEAMS_SELF_PREFIX;
  const [rawName, ...tokens] = isSelf ? parts.slice(1) : parts;
  const name = (rawName || "").replace(TEAMS_NAME_SUFFIX, "").trim();
  if (!name || name.length > MAX_NAME_LENGTH) return null;
  return { name, isSelf, tokens: tokens.map((token) => token.toLowerCase()) };
}

function interpretTeamsWebWindows(windows) {
  const tiles = new Map();
  const rows = [];
  const nodes = windows.flatMap((window) => window?.nodes || []);
  for (const node of nodes) {
    const text = nodeText(node);
    if (TEAMS_TILE_ROLES.has(node?.role) && isTileSized(node.frame)) {
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
  const roster = new Set([...tiles.keys(), ...rows.map((row) => row.id)]);
  return stateFor(tiles, rows, speakerFromCaptions(nodes, TEAMS_CAPTIONS_LABEL, roster));
}

// Google Meet in Chrome, checked against meet.google.com (Oct 2026). Tiles are
// unlabelled groups with the participant's name in a static text at their
// bottom-left corner; a tile's own inner groups can contain the name too, so
// the tile is the largest group whose corner sits at the label. Meet marks
// neither the user's tile nor a muted microphone. Captions sit in a
// "Captions" region. English labels only.
const MEET_LABEL_CORNER_PX = 40;
const MEET_CAPTIONS_LABEL = "Captions";
const MEET_MORE_OPTIONS = /^More options for (.+)$/;

function interpretMeetWindows(windows) {
  const tiles = new Map();
  const extra = [];
  const nodes = windows.flatMap((window) => window?.nodes || []);
  const captions = nodes.find((node) => nodeText(node) === MEET_CAPTIONS_LABEL)?.frame;
  const groups = nodes.filter(
    (node) => node?.role === "AXGroup" && !nodeText(node) && isTileSized(node.frame)
  );

  for (const node of nodes) {
    const optionsFor = nodeText(node).match(MEET_MORE_OPTIONS);
    if (optionsFor) {
      const parsed = parseZoomName(optionsFor[1]);
      if (parsed)
        extra.push({ id: participantIdForName(parsed.name), name: parsed.name, isSelf: false });
      continue;
    }
    if (node?.role !== "AXStaticText" || !node.value || !Array.isArray(node.frame)) continue;
    if (captions && frameContains(captions, node.frame)) continue;
    const [labelX, labelY, , labelHeight] = node.frame;
    let tile = null;
    for (const group of groups) {
      const [x, y, width, height] = group.frame;
      if (!frameContains(group.frame, node.frame)) continue;
      if (labelX - x > MEET_LABEL_CORNER_PX) continue;
      if (y + height - (labelY + labelHeight) > MEET_LABEL_CORNER_PX) continue;
      if (!tile || frameArea(group.frame) > frameArea(tile.frame)) tile = group;
    }
    const parsed = tile ? parseZoomName(node.value) : null;
    if (parsed) addTile(tiles, { name: parsed.name, frame: tile.frame });
  }

  const roster = new Set([...tiles.keys(), ...extra.map((participant) => participant.id)]);
  return stateFor(tiles, extra, speakerFromCaptions(nodes, MEET_CAPTIONS_LABEL, roster));
}

function interpretZoomWindows(windows) {
  return interpretZoomSnapshot({ windows });
}

const MEETING_APP_SPEAKER_ADAPTERS = [
  { app: "zoom", bundleIds: ZOOM_BUNDLE_IDS, interpret: interpretZoomWindows },
  {
    app: "meet",
    bundleIds: BROWSER_BUNDLE_IDS,
    pageTitle: MEET_PAGE_TITLE,
    interpret: interpretMeetWindows,
  },
  {
    app: "teams-web",
    bundleIds: BROWSER_BUNDLE_IDS,
    pageTitle: TEAMS_PAGE_TITLE,
    interpret: interpretTeamsWebWindows,
  },
];

for (const adapter of MEETING_APP_SPEAKER_ADAPTERS) {
  if (adapter.pageTitle) adapter.pageTitleRegex = new RegExp(adapter.pageTitle);
}

// The helper's targets: each bundle id once, with the page-title pattern of
// every adapter that reads it through a browser tab.
const MEETING_APP_SPEAKER_TARGETS = (() => {
  const targets = new Map();
  for (const adapter of MEETING_APP_SPEAKER_ADAPTERS) {
    for (const bundleId of adapter.bundleIds) {
      const target = targets.get(bundleId) ?? { bundleId, pageTitles: [] };
      if (adapter.pageTitle) target.pageTitles.push(adapter.pageTitle);
      targets.set(bundleId, target);
    }
  }
  return [...targets.values()].map(({ bundleId, pageTitles }) => ({
    bundleId,
    pageTitle: pageTitles.length ? pageTitles.map((pattern) => `(?:${pattern})`).join("|") : null,
  }));
})();

function adapterForWindow(window, fallbackBundleId) {
  const bundleId = window?.bundleId ?? fallbackBundleId;
  return MEETING_APP_SPEAKER_ADAPTERS.find(
    (adapter) =>
      adapter.bundleIds.includes(bundleId) &&
      (!adapter.pageTitleRegex || adapter.pageTitleRegex.test(window?.title || ""))
  );
}

// snapshot: { windows: [{ bundleId, title, frame, nodes: [{ role, title,
// description, value, frame }] }] } (older snapshots carry one top-level
// bundleId). Each app's windows go to its adapter; when several meetings are
// open, the first one that names a speaker wins and every roster is kept.
// Returns { participants, speakingIds, strategy }.
function interpretMeetingAppSnapshot(snapshot) {
  const windows = Array.isArray(snapshot?.windows) ? snapshot.windows : [];
  const byAdapter = new Map();
  for (const window of windows) {
    const adapter = adapterForWindow(window, snapshot?.bundleId);
    if (!adapter) continue;
    if (!byAdapter.has(adapter)) byAdapter.set(adapter, []);
    byAdapter.get(adapter).push(window);
  }

  const states = MEETING_APP_SPEAKER_ADAPTERS.filter((adapter) => byAdapter.has(adapter)).map(
    (adapter) => adapter.interpret(byAdapter.get(adapter))
  );
  if (!states.length) return EMPTY_STATE;
  const speaking = states.find((state) => state.speakingIds.length);
  return {
    participants: states.flatMap((state) => state.participants),
    speakingIds: speaking?.speakingIds ?? [],
    strategy: speaking?.strategy ?? "none",
  };
}

module.exports = {
  MEETING_APP_SPEAKER_TARGETS,
  interpretMeetingAppSnapshot,
  interpretZoomSnapshot,
  parseTeamsLabel,
  parseZoomTileText,
  participantIdForName,
};
