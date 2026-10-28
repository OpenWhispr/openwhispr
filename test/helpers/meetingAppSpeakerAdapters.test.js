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
const zoom = (...windows) => ({ type: "snapshot", at: 1, bundleId: "us.zoom.xos", windows });
const meetingWindow = (...nodes) => ({ title: "Zoom Meeting", frame: WINDOW, nodes });
const gallery = (...labels) =>
  labels.map((label, index) =>
    node(label, [(index % 2) * 800, Math.floor(index / 2) * 500, 800, 500])
  );
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

test("Meet: Spotlight's large tile speaks, and follows the speaker", () => {
  assert.deepEqual(verdict(MEET.spotlightGuestTalking).slice(1), [["jane doe"]]);
  assert.deepEqual(verdict(MEET.spotlightPhoneTalking).slice(1), [["priya shah"]]);
});

test("Meet: captions win over the layout, newest block first", () => {
  // The bar's newest block is Jane while she talks, then the phone.
  assert.deepEqual(verdict(MEET.spotlightGuestTalking), ["captions", ["jane doe"]]);
  assert.deepEqual(verdict(MEET.spotlightPhoneTalking), ["captions", ["priya shah"]]);

  const withoutCaptions = {
    ...MEET.spotlightGuestTalking,
    windows: MEET.spotlightGuestTalking.windows.map((window) => ({
      ...window,
      nodes: window.nodes.filter((node) => node.title !== "Captions"),
    })),
  };
  assert.deepEqual(verdict(withoutCaptions), ["speaker-view", ["jane doe"]]);
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
  const state = interpretMeetingAppSnapshot({
    bundleId: "com.example.other",
    windows: [meetingWindow(...gallery("Jane Doe, Talking"))],
  });
  assert.deepEqual(state, { participants: [], speakingIds: [], strategy: "none" });
  assert.deepEqual(interpretMeetingAppSnapshot(null).speakingIds, []);
});
