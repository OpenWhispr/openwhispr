const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");
const { privateSectionDropTarget } = require("../../src/lib/privateSection.ts");

// One Private section over the workspace's own Private (1) and the pending one (9): "Plans" in
// both, "Notes" in the own one only, Meetings in both. A teamspace (2) with its own Meetings.
const SECTION = [
  { id: 1, kind: "private", workspace_id: "a" },
  { id: 9, kind: "private", workspace_id: null },
];
const FOLDERS = [
  { id: 10, space_id: 1, name: "Plans", is_default: 0 },
  { id: 90, space_id: 9, name: "Plans", is_default: 0 },
  { id: 12, space_id: 1, name: "Notes", is_default: 0 },
  { id: 11, space_id: 1, name: "Meetings", is_default: 1 },
  { id: 92, space_id: 9, name: "Meetings", is_default: 1 },
  { id: 21, space_id: 2, name: "Meetings", is_default: 1 },
];
const ROWS = {
  plans: { spaceId: 1, folderId: 10, folderName: "Plans" },
  notes: { spaceId: 1, folderId: 12, folderName: "Notes" },
  meetings: { spaceId: 1, folderId: 11, folderName: "Meetings", isDefaultFolder: true },
  section: { spaceId: 1, folderId: null },
  teamMeetings: { spaceId: 2, folderId: 21, folderName: "Meetings", isDefaultFolder: true },
};

async function mountDragAndDrop(t) {
  // Registered first, so the root unmounts before the globals it renders against are restored.
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installHostDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-note-drag-and-drop-",
    mockModules: {
      "/stores/noteStore": `
        export const folderContainerKey = (id) => "folder:" + id;
        export const spaceContainerKey = (id) => "space:" + id;
      `,
    },
  });
  const { useNoteDragAndDrop } = await vite.ssrLoadModule("/hooks/useNoteDragAndDrop.ts");
  const moves = [];
  const crossSpaceDrops = [];
  let latest = null;
  function Harness() {
    latest = useNoteDragAndDrop({
      untitledLabel: "Untitled",
      onMoveToTarget: (noteId, target) => moves.push([noteId, target]),
      onCrossSpaceDrop: (note, target, commit) => crossSpaceDrops.push({ note, target, commit }),
      resolveDropTarget: (note, target) =>
        privateSectionDropTarget(SECTION, FOLDERS, note.spaceId, target),
    });
    return null;
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));

  // Drags the note over a row and drops it there. True when the row took the drag.
  const dragOnto = async (note, row) => {
    const data = new Map();
    const dataTransfer = {
      setData: (type, value) => data.set(type, value),
      getData: (type) => data.get(type) ?? "",
      setDragImage() {},
    };
    const event = () => ({
      dataTransfer,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    });
    await React.act(async () => latest.noteDragHandlers(note).onDragStart(event()));
    const over = event();
    await React.act(async () => latest.dropTargetHandlers(row).onDragOver(over));
    await React.act(async () => latest.dropTargetHandlers(row).onDrop(event()));
    await React.act(async () => latest.noteDragHandlers(note).onDragEnd());
    return over.defaultPrevented;
  };
  return { dragOnto, moves, crossSpaceDrops };
}

const pendingPlan = { id: 900, title: "Pending plan", folderId: 90, spaceId: 9 };
const ownPlan = { id: 100, title: "Own plan", folderId: 10, spaceId: 1 };

test("drops on a Private section row land in the dragged note's own Private", async (t) => {
  const { dragOnto, moves, crossSpaceDrops } = await mountDragAndDrop(t);

  // The merged "Plans" row is the pending note's own folder: nothing to do.
  assert.equal(await dragOnto(pendingPlan, ROWS.plans), false);
  assert.deepEqual(moves, []);
  assert.deepEqual(crossSpaceDrops, []);

  // The section header is its own Private's root, a move inside that Private.
  assert.equal(await dragOnto(pendingPlan, ROWS.section), true);
  assert.deepEqual(moves, [[900, { spaceId: 9, folderId: null }]]);
  assert.deepEqual(crossSpaceDrops, []);

  // A folder only the other Private has is a move between the two, which the caller handles.
  assert.equal(await dragOnto(pendingPlan, ROWS.notes), true);
  assert.equal(crossSpaceDrops.length, 1);
  assert.deepEqual(crossSpaceDrops[0].target, { spaceId: 1, folderId: 12 });
});

test("own Meetings is no drop target from either Private of the section", async (t) => {
  const { dragOnto, moves, crossSpaceDrops } = await mountDragAndDrop(t);

  assert.equal(await dragOnto(pendingPlan, ROWS.meetings), false);
  assert.equal(await dragOnto(ownPlan, ROWS.meetings), false);
  // A teamspace keeps its own rule: its Meetings is no target for its own notes.
  assert.equal(
    await dragOnto({ id: 200, title: "Team note", folderId: null, spaceId: 2 }, ROWS.teamMeetings),
    false
  );
  assert.deepEqual(moves, []);
  assert.deepEqual(crossSpaceDrops, []);
});
