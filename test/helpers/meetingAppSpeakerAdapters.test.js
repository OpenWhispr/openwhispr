const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MEETING_APP_SPEAKER_TARGETS,
  interpretMeetingAppSnapshot,
  parseZoomTileText,
  parseTeamsLabel,
  participantIdForName,
} = require("../../src/helpers/meetingAppSpeakerAdapters");

const ZOOM_SPEAKER_VIEW = require("./fixtures/zoom-7.2-speaker-view.json");
// One live session, Priya on the Mac and Omar on a phone.
const ZOOM_TWO_PERSON = require("./fixtures/zoom-7.2-two-person.json");
// Chrome, Oct 2026: Priya on the Mac, Omar on a phone, Jane as a Safari guest,
// shaped as the live helper reports them. In the Meet session Omar's phone
// used Priya's display name, so Meet's "Priya Shah" tiles are two people.
const MEET = require("./fixtures/meet-2026-10-chrome.json");
const TEAMS_WEB = require("./fixtures/teams-web-2026-10-chrome.json");

// Synthetic trees for layouts not dumped yet, shaped like Zoom 7.2's (tiles are
// AXTabGroups; see the fixture).
const WINDOW = [0, 0, 1600, 1000];
const node = (description, frame, role = "AXTabGroup") => ({ role, description, frame });
const zoom = (...windows) => ({
  type: "snapshot",
  at: 1,
  windows: windows.map((window) => ({ bundleId: "us.zoom.xos", ...window })),
});
const meetingWindow = (...nodes) => ({ title: "Zoom Meeting", frame: WINDOW, nodes });
const gallery = (...labels) =>
  labels.map((label, index) =>
    node(label, [(index % 2) * 800, Math.floor(index / 2) * 500, 800, 500])
  );
const mapNodes = (snapshot, transform) => ({
  ...snapshot,
  windows: snapshot.windows.map((window) => ({
    ...window,
    nodes: window.nodes.map(transform),
  })),
});

const toolbar = [
  node("Mute", [20, 960, 60, 40], "AXButton"),
  node("Start Video", [90, 960, 60, 40], "AXButton"),
];

test("parses a tile label into name, self and status", () => {
  assert.deepEqual(parseZoomTileText("Jane Doe"), {
    name: "Jane Doe",
    isSelf: false,
    speaking: false,
    muted: false,
  });
  assert.deepEqual(parseZoomTileText("Gabe (Host, me), Computer audio muted"), {
    name: "Gabe",
    isSelf: true,
    speaking: false,
    muted: true,
  });
  assert.deepEqual(parseZoomTileText("Omar Haddad (Co-host), Talking"), {
    name: "Omar Haddad",
    isSelf: false,
    speaking: true,
    muted: false,
  });
  // "unmuted" contains "muted"; only whole status parts count.
  assert.equal(parseZoomTileText("Jane Doe, Computer audio unmuted").muted, false);
  // Only Zoom's own role annotations come off the name.
  assert.equal(parseZoomTileText("Jane (she/her)").name, "Jane (she/her)");
  assert.equal(parseZoomTileText("Jane Doe's screen"), null);
  assert.equal(parseZoomTileText(""), null);
  assert.equal(parseZoomTileText("x".repeat(81)), null);
});

test("ids normalize case and spacing", () => {
  assert.equal(participantIdForName("  Jane   DOE "), "jane doe");
});

test("a tile that says it's talking is the speaker", () => {
  const state = interpretMeetingAppSnapshot(
    zoom(meetingWindow(...gallery("Jane Doe", "Omar Haddad, Talking", "Gabe (me)"), ...toolbar))
  );

  assert.equal(state.strategy, "tile-status");
  assert.deepEqual(state.speakingIds, ["omar haddad"]);
  assert.deepEqual(state.participants, [
    { id: "jane doe", name: "Jane Doe", isSelf: false },
    { id: "omar haddad", name: "Omar Haddad", isSelf: false },
    { id: "gabe", name: "Gabe", isSelf: true },
  ]);
});

test("speaker view's large tile is the speaker, its thumbnail the same person", () => {
  const state = interpretMeetingAppSnapshot(
    zoom(
      meetingWindow(
        node("Jane Doe", [0, 120, 1600, 840]),
        node("Jane Doe", [0, 0, 200, 112]),
        node("Omar Haddad", [200, 0, 200, 112]),
        node("Gabe (me)", [400, 0, 200, 112]),
        ...toolbar
      )
    )
  );

  assert.equal(state.strategy, "speaker-view");
  assert.deepEqual(state.speakingIds, ["jane doe"]);
  assert.equal(state.participants.length, 3);
});

test("speaker view with a muted main tile names no speaker", () => {
  const state = interpretMeetingAppSnapshot(
    zoom(
      meetingWindow(
        node("Jane Doe, Computer audio muted", [0, 120, 1600, 840]),
        node("Omar Haddad", [200, 0, 200, 112])
      )
    )
  );

  assert.deepEqual(state.speakingIds, []);
  assert.equal(state.strategy, "none");
});

test("a small gallery without status says nothing about who talks", () => {
  const state = interpretMeetingAppSnapshot(
    zoom(meetingWindow(node("Jane Doe", [0, 0, 800, 900]), node("Omar Haddad", [800, 0, 800, 900])))
  );

  assert.deepEqual(state.speakingIds, []);
  assert.equal(state.strategy, "none");
  assert.equal(state.participants.length, 2);
});

test("the Talking label names the speaker, with or without a visible tile", () => {
  const withTile = interpretMeetingAppSnapshot(
    zoom(
      meetingWindow(
        ...gallery("Jane Doe", "Omar Haddad"),
        node("Talking: Omar Haddad", [600, 4, 300, 20], "AXStaticText")
      )
    )
  );
  assert.equal(withTile.strategy, "talking-label");
  assert.deepEqual(withTile.speakingIds, ["omar haddad"]);
  assert.equal(withTile.participants.length, 2);

  // Screen share: the shared screen fills the window and tiles are gone.
  const sharing = interpretMeetingAppSnapshot(
    zoom(
      meetingWindow(
        node("Jane Doe's screen", [0, 0, 1600, 1000]),
        node("Talking: Omar Haddad (Co-host)", [600, 4, 300, 20], "AXStaticText")
      )
    )
  );
  assert.deepEqual(sharing.speakingIds, ["omar haddad"]);
  assert.deepEqual(sharing.participants, [
    { id: "omar haddad", name: "Omar Haddad", isSelf: false },
  ]);
});

test("reads the window showing the most tiles, never list rows or buttons", () => {
  const home = {
    title: "Zoom Workplace",
    frame: WINDOW,
    nodes: [
      node("Zoom Calendar Sidebar", [0, 0, 600, 530], "AXWebArea"),
      node("Zoom AI", [600, 0, 376, 840], "AXWebArea"),
      node("Suggested", [600, 360, 344, 152], "AXGroup"),
    ],
  };
  const meeting = meetingWindow(
    ...gallery("Jane Doe", "Omar Haddad"),
    node("Priya Shah", [1200, 100, 380, 80], "AXRow"),
    ...toolbar
  );
  const state = interpretMeetingAppSnapshot(zoom(home, meeting));

  assert.deepEqual(
    state.participants.map((participant) => participant.id),
    ["jane doe", "omar haddad"]
  );
});

test("real Zoom 7.2 speaker view: the large tile speaks, the home window is ignored", () => {
  const state = interpretMeetingAppSnapshot(ZOOM_SPEAKER_VIEW);

  assert.equal(state.strategy, "speaker-view");
  assert.deepEqual(state.speakingIds, ["omar haddad"]);
  assert.deepEqual(state.participants, [
    { id: "omar haddad", name: "Omar Haddad", isSelf: false },
    { id: "priya shah", name: "Priya Shah", isSelf: true },
  ]);
});

test("real Zoom 7.2 two-person session: only speaker views name a speaker", () => {
  const speaker = (snapshot) => {
    const state = interpretMeetingAppSnapshot(snapshot);
    return [state.strategy, state.speakingIds];
  };

  assert.deepEqual(speaker(ZOOM_TWO_PERSON.speakerViewTalking), ["speaker-view", ["omar haddad"]]);
  // Sharing: the floating video window in active-speaker mode is a speaker view.
  assert.deepEqual(speaker(ZOOM_TWO_PERSON.sharingFloatingActiveSpeaker), [
    "speaker-view",
    ["omar haddad"],
  ]);
  // Gallery labels are identical whether Omar talks or not, and so are the
  // floating window's two tiles: nothing to read a speaker from.
  assert.deepEqual(ZOOM_TWO_PERSON.galleryTalking.windows, ZOOM_TWO_PERSON.gallerySilent.windows);
  assert.deepEqual(speaker(ZOOM_TWO_PERSON.galleryTalking), ["none", []]);
  assert.deepEqual(speaker(ZOOM_TWO_PERSON.sharingFloatingGallery), ["none", []]);

  assert.deepEqual(
    interpretMeetingAppSnapshot(ZOOM_TWO_PERSON.galleryTalking).participants.map(({ id }) => id),
    ["priya shah", "omar haddad"]
  );
});

test("the home window's profile button marks the user's tile", () => {
  const profile = (description) => ({
    title: "Zoom Workplace",
    frame: WINDOW,
    nodes: [node(description, [1449, 87, 34, 34], "AXButton")],
  });
  const meeting = meetingWindow(...gallery("Jane Doe", "Omar Haddad"));

  const marked = interpretMeetingAppSnapshot(
    zoom(meeting, profile("Zoom, Omar Haddad, In a Zoom Meeting, Basic account"))
  );
  assert.deepEqual(
    marked.participants.map(({ id, isSelf }) => [id, isSelf]),
    [
      ["jane doe", false],
      ["omar haddad", true],
    ]
  );

  // Other buttons that start with "Zoom" or name a participant don't count.
  for (const description of [
    "Zoom",
    "Zoom, Omar Haddad",
    "More options for Omar Haddad, collapsed",
  ]) {
    const state = interpretMeetingAppSnapshot(zoom(meeting, profile(description)));
    assert.ok(
      state.participants.every((participant) => !participant.isSelf),
      description
    );
  }
});

const verdict = (snapshot) => {
  const state = interpretMeetingAppSnapshot(snapshot);
  return [state.strategy, state.speakingIds];
};

test("Teams web: Speaker view's large tile speaks, gallery names no one", () => {
  assert.deepEqual(verdict(TEAMS_WEB.speakerPhoneTalking), ["speaker-view", ["omar haddad"]]);
  assert.deepEqual(verdict(TEAMS_WEB.speakerGuestTalking), ["speaker-view", ["jane doe"]]);
  assert.deepEqual(verdict(TEAMS_WEB.galleryMuted), ["none", []]);
  assert.deepEqual(verdict(TEAMS_WEB.galleryPhoneTalking), ["none", []]);

  const { participants } = interpretMeetingAppSnapshot(TEAMS_WEB.galleryMuted);
  assert.deepEqual(participants.map(({ id, isSelf }) => [id, isSelf]).sort(), [
    ["jane doe", false],
    ["omar haddad", false],
    ["priya shah", true],
  ]);
});

test("Teams web: captions name the speaker in any layout", () => {
  assert.deepEqual(verdict(TEAMS_WEB.captionsGuestTalking), ["captions", ["jane doe"]]);

  // Participants panel closed: Jane's tile still puts her on the roster.
  const panelClosed = {
    ...TEAMS_WEB.captionsGuestTalking,
    windows: TEAMS_WEB.captionsGuestTalking.windows.map((window) => ({
      ...window,
      nodes: window.nodes.filter((node) => node.role !== "AXRow"),
    })),
  };
  assert.deepEqual(verdict(panelClosed), ["captions", ["jane doe"]]);

  // A caption header keeps Teams' "(Guest)" annotation.
  const annotated = mapNodes(TEAMS_WEB.captionsGuestTalking, (node) =>
    node.value === "Jane Doe" ? { ...node, value: "Jane Doe (Guest)" } : node
  );
  assert.deepEqual(verdict(annotated), ["captions", ["jane doe"]]);
});

test("Teams web: a newest caption from someone off the roster credits no one else", () => {
  const headers = TEAMS_WEB.captionsGuestTalking.windows[0].nodes.filter(
    (node) => node.value === "Jane Doe"
  );
  const newest = headers.reduce((a, b) => (b.frame[1] > a.frame[1] ? b : a));
  const stranger = mapNodes(TEAMS_WEB.captionsGuestTalking, (node) =>
    node === newest ? { ...node, value: "Ann Lee" } : node
  );
  // Not the older Jane block, and not the Speaker view tile either.
  assert.deepEqual(interpretMeetingAppSnapshot(stranger).speakingIds, []);

  // Seen earlier in the meeting, she's matched even with no tile on screen.
  const knownParticipants = new Map([["ann lee", { id: "ann lee", name: "Ann Lee" }]]);
  const state = interpretMeetingAppSnapshot(stranger, { knownParticipants });
  assert.deepEqual([state.strategy, state.speakingIds], ["captions", ["ann lee"]]);
});

test("Teams web: a shared screen is never a participant", () => {
  const sharing = mapNodes(TEAMS_WEB.speakerGuestTalking, (node) =>
    node.description?.startsWith("Jane Doe (Guest), video is on")
      ? { ...node, description: "Jane Doe's screen, Context menu is available" }
      : node
  );
  const state = interpretMeetingAppSnapshot(sharing);
  // The shared screen is neither a participant (Jane stays, from the
  // participants panel) nor the large tile to credit.
  assert.deepEqual(state.participants.map(({ id }) => id).sort(), [
    "jane doe",
    "omar haddad",
    "priya shah",
  ]);
  assert.deepEqual([state.strategy, state.speakingIds], ["none", []]);
});

test("Meet: the user's hover controls never mark the spotlit remote as the user", () => {
  const spotlight = withoutCaptionBar(MEET.spotlightGuestTalking);
  const thumbnail = spotlight.windows[0].nodes.find(
    (node) => node.value === "Priya Shah" && node.frame[1] < 760
  );
  // The self view sits inside Jane's spotlight tile; its hover controls with it.
  const [x, y] = thumbnail.frame;
  const controls = ["Backgrounds and effects", "You're continuously framed"].map((title, i) => ({
    role: "AXButton",
    title,
    description: title,
    frame: [x + i * 44, y - 60, 44, 44],
  }));
  const hovered = {
    ...spotlight,
    windows: [{ ...spotlight.windows[0], nodes: [...spotlight.windows[0].nodes, ...controls] }],
  };
  const state = interpretMeetingAppSnapshot(hovered);
  assert.ok(state.participants.every(({ isSelf }) => !isSelf));
  assert.deepEqual(state.speakingIds, ["jane doe"]);
});

test("Meet: a newest caption from someone off the roster credits no one else", () => {
  const headers = MEET.spotlightGuestTalking.windows[0].nodes.filter(
    (node) => node.value === "Jane Doe" && node.frame[1] > 760
  );
  const newest = headers.reduce((a, b) => (b.frame[1] > a.frame[1] ? b : a));
  const stranger = mapNodes(MEET.spotlightGuestTalking, (node) =>
    node === newest ? { ...node, value: "Ann Lee" } : node
  );
  assert.deepEqual(interpretMeetingAppSnapshot(stranger).speakingIds, []);
});

test("Teams web: captions under the user's own name never name a remote voice", () => {
  const headers = TEAMS_WEB.captionsGuestTalking.windows[0].nodes.filter(
    (node) => node.value === "Jane Doe"
  );
  const newest = headers.reduce((a, b) => (b.frame[1] > a.frame[1] ? b : a));
  // No self tile on screen ("Hide for me"); the session knows Priya is the user.
  const noSelfTile = mapNodes(TEAMS_WEB.captionsGuestTalking, (node) =>
    node === newest ? { ...node, value: "Priya Shah" } : node
  );
  noSelfTile.windows = noSelfTile.windows.map((window) => ({
    ...window,
    nodes: window.nodes.filter((node) => !String(node.description).startsWith("Myself video")),
  }));
  const state = interpretMeetingAppSnapshot(noSelfTile, { knownSelfIds: new Set(["priya shah"]) });
  assert.deepEqual(state.speakingIds, []);
});

test("Meet: names ending in a period are still names, sentences aren't", () => {
  const relabel = (from, to) =>
    mapNodes(withoutCaptionBar(MEET.spotlightGuestTalking), (node) =>
      node.value === from ? { ...node, value: to } : node
    );
  for (const name of ["Jane Doe Jr.", "Dr. A. B.", "Maria del Carmen de la Fuente"]) {
    assert.deepEqual(
      interpretMeetingAppSnapshot(relabel("Jane Doe", name)).speakingIds,
      [participantIdForName(name)],
      name
    );
  }
  for (const sentence of ["Let me check with Omar.", "Can you hear me?"]) {
    assert.ok(
      !interpretMeetingAppSnapshot(relabel("Jane Doe", sentence)).participants.some(
        ({ name }) => name === sentence
      ),
      sentence
    );
  }
});

test("names that contain a comma stay whole", () => {
  assert.equal(
    parseTeamsLabel("Doe, Jane, video is on, muted, Context menu is available").name,
    "Doe, Jane"
  );
  assert.equal(parseTeamsLabel("Doe, Jane (Guest), Meeting guest, Unmuted").name, "Doe, Jane");
  assert.equal(parseZoomTileText("Doe, Jane, Computer audio muted, Video on").name, "Doe, Jane");
  // A status in a language not listed: the first part is the name, as before.
  assert.equal(parseZoomTileText("Jane Doe, Computer-Audio stumm").name, "Jane Doe");
  // A status no list knows never joins the name.
  assert.equal(parseZoomTileText("Jane Doe, Raised hand, Computer audio muted").name, "Jane Doe");
  assert.deepEqual(parseZoomTileText("Gabe (Host, me), Raised hand, Computer audio muted"), {
    name: "Gabe",
    isSelf: true,
    speaking: false,
    muted: true,
  });
  assert.equal(parseTeamsLabel("Jane Doe (Guest), Raised hand, muted").name, "Jane Doe");
  assert.equal(parseTeamsLabel("Jane Doe, Pinned, muted").name, "Jane Doe");
  assert.equal(parseZoomTileText("Jane Doe, Spotlighted, Computer audio muted").name, "Jane Doe");
  assert.equal(parseTeamsLabel("Doe, Jane Jr., muted").name, "Doe, Jane Jr.");
  assert.equal(parseTeamsLabel("李, 华, muted").name, "李, 华");
  assert.equal(parseZoomTileText("Doe, Jane, Phone audio muted").name, "Doe, Jane");
  assert.equal(parseTeamsLabel("van der Berg, Jan, muted").name, "van der Berg, Jan");
});

test("Zoom: the profile button marks a user whose name holds a comma", () => {
  const state = interpretMeetingAppSnapshot(
    zoom(
      meetingWindow(
        node("Doe, Jane, Computer audio muted", [0, 0, 800, 500]),
        node("Omar Haddad, Computer audio muted", [800, 0, 800, 500])
      ),
      {
        title: "Zoom Workplace",
        frame: WINDOW,
        nodes: [
          node("Zoom, Doe, Jane, In a Zoom Meeting, Basic account", [1449, 87, 34, 34], "AXButton"),
        ],
      }
    )
  );
  assert.deepEqual(state.participants.map(({ id, isSelf }) => [id, isSelf]).sort(), [
    ["doe, jane", true],
    ["omar haddad", false],
  ]);
});

test("parses Teams tile labels", () => {
  assert.deepEqual(parseTeamsLabel("Myself video, Priya Shah, Muted, Has context menu"), {
    name: "Priya Shah",
    isSelf: true,
    tokens: ["muted", "has context menu"],
  });
  assert.deepEqual(parseTeamsLabel("Jane Doe (Guest), video is on, Context menu is available"), {
    name: "Jane Doe",
    isSelf: false,
    tokens: ["video is on", "context menu is available"],
  });
});

// The same snapshot with the caption bar switched off: the region and every
// line inside it gone.
const withoutCaptionBar = (snapshot) => ({
  ...snapshot,
  windows: snapshot.windows.map((window) => {
    const bar = window.nodes.find((node) => node.title === "Captions")?.frame;
    const inBar = (frame) =>
      bar && frame && frame[0] >= bar[0] && frame[1] >= bar[1] && frame[1] < bar[1] + bar[3];
    return { ...window, nodes: window.nodes.filter((node) => !inBar(node.frame)) };
  }),
});

test("Meet: Spotlight's large tile speaks without captions", () => {
  assert.deepEqual(verdict(withoutCaptionBar(MEET.spotlightGuestTalking)), [
    "speaker-view",
    ["jane doe"],
  ]);
  // The phone used Priya's display name, so its spotlight tile and Priya's
  // thumbnail are one participant: no smaller tile to compare against.
  assert.deepEqual(verdict(withoutCaptionBar(MEET.spotlightPhoneTalking)), ["none", []]);
});

test("Meet: a remote who shares the user's display name reads as that name", () => {
  // The phone joined under Priya's own name; Meet doesn't mark the user's
  // tile, so its captions credit "Priya Shah" like anyone else's.
  assert.deepEqual(verdict(MEET.twoPersonCaptions), ["captions", ["priya shah"]]);
});

test("Meet: captions win over the layout, newest block first", () => {
  // The bar's newest block is Jane while she talks, then the phone.
  assert.deepEqual(verdict(MEET.spotlightGuestTalking), ["captions", ["jane doe"]]);
  assert.deepEqual(verdict(MEET.spotlightPhoneTalking), ["captions", ["priya shah"]]);
});

test("Meet: the user's own captions name no remote speaker", () => {
  const youSpeaking = mapNodes(MEET.spotlightGuestTalking, (node) =>
    node.value === "Jane Doe" && node.frame[1] > 900 ? { ...node, value: "You" } : node
  );
  // Without captions the layout would still credit Jane's spotlight tile.
  assert.deepEqual(interpretMeetingAppSnapshot(youSpeaking).speakingIds, []);
});

test("Meet: in another UI language, caption lines never become participants", () => {
  const relabelled = mapNodes(MEET.spotlightGuestTalking, (node) =>
    node.title === "Captions" ? { ...node, title: "Untertitel", description: "Untertitel" } : node
  );
  const state = interpretMeetingAppSnapshot(relabelled);
  assert.deepEqual(state.participants.map(({ id }) => id).sort(), ["jane doe", "priya shah"]);
  assert.deepEqual([state.strategy, state.speakingIds], ["speaker-view", ["jane doe"]]);
});

test("Meet: a presentation tile is never the speaker", () => {
  const presenting = mapNodes(withoutCaptionBar(MEET.spotlightGuestTalking), (node) =>
    node.value === "Jane Doe" ? { ...node, value: "Jane Doe (Presentation)" } : node
  );
  assert.deepEqual(verdict(presenting), ["none", []]);
});

test("a cut-off tree names no speaker", () => {
  const truncated = {
    ...TEAMS_WEB.speakerGuestTalking,
    windows: TEAMS_WEB.speakerGuestTalking.windows.map((window) => ({
      ...window,
      truncated: true,
    })),
  };
  assert.deepEqual(verdict(truncated), ["none", []]);
  assert.ok(interpretMeetingAppSnapshot(truncated).participants.length > 0);
});

test("Meet: a caption name line is never read as a tile", () => {
  const { participants } = interpretMeetingAppSnapshot(MEET.spotlightGuestTalking);
  assert.deepEqual(participants.map(({ id }) => id).sort(), ["jane doe", "priya shah"]);
});

test("browser windows go to the adapter their page title names", () => {
  const meet = MEET.spotlightGuestTalking.windows[0];
  const retitled = (title) =>
    interpretMeetingAppSnapshot({ type: "snapshot", windows: [{ ...meet, title }] });
  assert.equal(retitled("Inbox - Google Chrome").strategy, "none");
  assert.deepEqual(retitled("Inbox - Google Chrome").participants, []);
  assert.deepEqual(retitled(meet.title).speakingIds, ["jane doe"]);
});

test("Zoom's provisional rules never outrank its Speaker view", () => {
  const state = interpretMeetingAppSnapshot(
    zoom(
      meetingWindow(
        node("Jane Doe", [0, 120, 1600, 840]),
        node("Omar Haddad, Talking", [200, 0, 200, 112]),
        node("Talking: Bo Chen", [600, 4, 300, 20], "AXStaticText")
      )
    )
  );
  assert.deepEqual([state.strategy, state.speakingIds], ["speaker-view", ["jane doe"]]);
});

test("with two meetings read, captions outrank another app's layout", () => {
  const state = interpretMeetingAppSnapshot({
    type: "snapshot",
    windows: [...ZOOM_SPEAKER_VIEW.windows, ...TEAMS_WEB.captionsGuestTalking.windows],
  });
  assert.deepEqual([state.strategy, state.speakingIds], ["captions", ["jane doe"]]);
});

test("one meeting naming a speaker wins over another app's silent one", () => {
  const state = interpretMeetingAppSnapshot({
    type: "snapshot",
    windows: [
      { ...meetingWindow(...gallery("Ann Lee", "Bo Chen")), bundleId: "us.zoom.xos" },
      ...TEAMS_WEB.speakerGuestTalking.windows,
    ],
  });
  assert.deepEqual(state.speakingIds, ["jane doe"]);
  assert.ok(state.participants.some(({ id }) => id === "ann lee"));
});

test("only apps with an adapter are read", () => {
  assert.deepEqual(
    MEETING_APP_SPEAKER_TARGETS.map(({ bundleId }) => bundleId),
    ["us.zoom.xos", "com.google.Chrome"]
  );
  // A browser page is read only while it shows a call: Meet's page title, or
  // a Teams video tile. Each page kind keeps its own marker.
  const chrome = MEETING_APP_SPEAKER_TARGETS.find(
    ({ bundleId }) => bundleId === "com.google.Chrome"
  );
  const [meet, teams] = chrome.pages.map(({ pageTitle, pageMarker }) => ({
    title: new RegExp(pageTitle),
    marker: new RegExp(pageMarker),
  }));
  assert.ok(meet.title.test("Meet – abc-defg-hij") && meet.marker.test("Meet – abc-defg-hij"));
  assert.ok(teams.title.test("Weekly sync | Microsoft Teams"));
  assert.ok(teams.marker.test("Jane Doe (Guest), muted, Context menu is available"));
  assert.ok(teams.marker.test("Myself video, Priya Shah, Muted, Has context menu"));
  // A Teams page mentioning a Meet link is still no call.
  assert.ok(!teams.marker.test("Meet – abc-defg-hij"));
  assert.ok(!teams.marker.test("Leave"));
  const state = interpretMeetingAppSnapshot({
    bundleId: "com.example.other",
    windows: [meetingWindow(...gallery("Jane Doe, Talking"))],
  });
  assert.deepEqual(state, { participants: [], speakingIds: [], strategy: "none" });
  assert.deepEqual(interpretMeetingAppSnapshot(null).speakingIds, []);
});

test("Zoom: a surname alone counts as the user only when no tile has the full name", () => {
  const profile = {
    title: "Zoom Workplace",
    frame: WINDOW,
    nodes: [
      node("Zoom, Doe, Jane, In a Zoom Meeting, Basic account", [1449, 87, 34, 34], "AXButton"),
    ],
  };
  const state = interpretMeetingAppSnapshot(
    zoom(
      meetingWindow(
        node("Doe, Jane, Computer audio muted", [0, 0, 800, 500]),
        node("Doe, Computer audio muted", [800, 0, 800, 500])
      ),
      profile
    )
  );
  const byId = Object.fromEntries(state.participants.map(({ id, isSelf }) => [id, isSelf]));
  assert.deepEqual(byId, { doe: false, "doe, jane": true });
});

test("Zoom: a cut-off tree still reads Speaker view", () => {
  const truncated = {
    ...ZOOM_SPEAKER_VIEW,
    windows: ZOOM_SPEAKER_VIEW.windows.map((window) => ({ ...window, truncated: true })),
  };
  assert.deepEqual(verdict(truncated), verdict(ZOOM_SPEAKER_VIEW));
});

test("Meet: only a landmark region named Captions is the caption bar", () => {
  const plainGroup = mapNodes(MEET.spotlightGuestTalking, (node) =>
    node.title === "Captions" ? { ...node, subrole: undefined } : node
  );
  assert.notEqual(interpretMeetingAppSnapshot(plainGroup).strategy, "captions");
});

test("Teams web: a newer caption header a few pixels off is still caught", () => {
  const headers = TEAMS_WEB.captionsGuestTalking.windows[0].nodes.filter(
    (node) => node.value === "Jane Doe"
  );
  // The last two are the caption bar's name lines (the first sits in the panel).
  const [older, newest] = [...headers].sort((a, b) => a.frame[1] - b.frame[1]).slice(-2);
  const shifted = mapNodes(TEAMS_WEB.captionsGuestTalking, (node) =>
    node === newest
      ? {
          ...node,
          value: "Ann Lee",
          frame: [node.frame[0] + 3, node.frame[1], node.frame[2], node.frame[3] + 2],
        }
      : node
  );
  assert.ok(older);
  assert.deepEqual(interpretMeetingAppSnapshot(shifted).speakingIds, []);
});

test("a value that isn't text is ignored, not read as a name", () => {
  const odd = mapNodes(MEET.spotlightGuestTalking, (node) =>
    node.value === "Jane Doe" && node.frame[1] < 760 ? { ...node, value: 42 } : node
  );
  assert.doesNotThrow(() => interpretMeetingAppSnapshot(odd));
  assert.ok(!interpretMeetingAppSnapshot(odd).participants.some(({ id }) => id === "42"));
});

test("Meet: an eight-word line is a sentence, not a name", () => {
  const long = mapNodes(withoutCaptionBar(MEET.spotlightGuestTalking), (node) =>
    node.value === "Jane Doe" ? { ...node, value: "So what we really need to do is" } : node
  );
  assert.ok(
    !interpretMeetingAppSnapshot(long).participants.some(({ name }) => name.startsWith("So what"))
  );
});

test("a browser window tagged with its page kind goes to that kind's adapter", () => {
  const meet = MEET.spotlightGuestTalking.windows[0];
  // A Meet page in a window whose title the helper cut short (or that a split
  // view shares with Teams): the page index decides, not the title.
  const tagged = { type: "snapshot", windows: [{ ...meet, title: "Untitled", page: 0 }] };
  assert.deepEqual(interpretMeetingAppSnapshot(tagged).speakingIds, ["jane doe"]);
  const asTeams = { type: "snapshot", windows: [{ ...meet, page: 1 }] };
  assert.deepEqual(interpretMeetingAppSnapshot(asTeams).speakingIds, []);
});
