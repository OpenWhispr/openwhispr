// Where a note's files live in the mirror, worked out only from the database's
// spaces and folders, so a rename or move is just "write the notes again". The
// layout follows the sidebar: each workspace has a Private section and its
// Teamspaces. A private space not bound to a workspace yet (an account's pending
// default, or the signed-out stand-in) sits in Private notes until it is.
const UNBOUND_PRIVATE_ROOT = "Private notes";
const WORKSPACES_ROOT = "Workspaces";
const PRIVATE_SECTION = "Private";
const TEAMSPACES_SECTION = "Teamspaces";
const OTHER_SPACES = "Other spaces";

const WORKSPACE_ID_LABEL_LENGTH = 8;
const WORKSPACE_ID_SUFFIX_LENGTH = 6;

// Fold both cases so expanding mappings (ß/ss) and final sigma cannot merge
// directories on case-insensitive disks. Keep the original spelling for display.
const nameKey = (name) =>
  String(name).normalize("NFC").toLowerCase().toUpperCase().normalize("NFC");

// The first of each same-named group keeps its name; the rest get a short id,
// and another if that name is taken too. File systems that ignore case would
// merge the directories otherwise.
function distinctNames(items, nameOf, suffixOf) {
  const taken = new Set();
  const names = new Map();
  for (const item of items) {
    const name = nameOf(item);
    let assigned = name;
    for (let copy = 1; taken.has(nameKey(assigned)); copy++) {
      assigned = `${name} (${suffixOf(item)}${copy > 1 ? `-${copy}` : ""})`;
    }
    names.set(item, assigned);
    taken.add(nameKey(assigned));
  }
  return names;
}

const byId = (left, right) => left.id - right.id;

function groupBy(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

function workspaceDirectories(spaces, workspaceNames) {
  // Local space ids preserve arrival order; a later workspace must not take an
  // existing workspace's unsuffixed directory just because its UUID sorts first.
  const ids = [
    ...new Set(
      [...spaces]
        .sort(byId)
        .map((space) => space.workspace_id)
        .filter(Boolean)
    ),
  ];
  const dirNameOf = (id) => {
    if (id === null) return OTHER_SPACES;
    return workspaceNames[id] ?? `Workspace ${id.slice(0, WORKSPACE_ID_LABEL_LENGTH)}`;
  };
  // Team spaces with no workspace come first, so they always keep "Other spaces".
  return distinctNames([null, ...ids], dirNameOf, (id) => id.slice(0, WORKSPACE_ID_SUFFIX_LENGTH));
}

function buildNotePlacements({ spaces, folders, workspaceNames }) {
  const spaceLocations = new Map();
  const folderLocations = new Map();
  const workspaceDirs = workspaceDirectories(spaces, workspaceNames);
  const workspaceLabel = (workspaceId) => {
    const name = workspaceId ? workspaceNames[workspaceId] : undefined;
    return name ? { workspace: name } : {};
  };

  for (const space of spaces.filter((row) => row.kind === "private")) {
    spaceLocations.set(space.id, {
      segments: space.workspace_id
        ? [WORKSPACES_ROOT, workspaceDirs.get(space.workspace_id), PRIVATE_SECTION]
        : [UNBOUND_PRIVATE_ROOT],
      ...workspaceLabel(space.workspace_id),
      space: PRIVATE_SECTION,
    });
  }

  const teamSpaces = spaces.filter((row) => row.kind !== "private");
  for (const [workspaceId, siblings] of groupBy(
    teamSpaces,
    (space) => space.workspace_id || null
  )) {
    const sorted = [...siblings].sort(byId);
    const spaceDirs = distinctNames(
      sorted,
      (space) => space.name,
      (space) => space.id
    );
    for (const space of sorted) {
      spaceLocations.set(space.id, {
        segments: [
          WORKSPACES_ROOT,
          workspaceDirs.get(workspaceId),
          TEAMSPACES_SECTION,
          spaceDirs.get(space),
        ],
        ...workspaceLabel(workspaceId),
        space: space.name,
      });
    }
  }

  // Grouped by the directory they go in, which two accounts' Private sections of one
  // workspace share. Folders with the very same name share a directory, since files carry
  // unique note ids and are handled one by one; names that differ only in case don't, or a
  // case-insensitive disk would merge them and each write would rename the directory.
  const knownFolders = folders.filter((folder) => spaceLocations.has(folder.space_id));
  for (const siblings of groupBy(knownFolders, (folder) =>
    spaceLocations.get(folder.space_id).segments.join("/")
  ).values()) {
    const firstByName = new Map();
    for (const folder of [...siblings].sort(byId)) {
      if (!firstByName.has(folder.name)) firstByName.set(folder.name, folder);
    }
    const folderDirs = distinctNames(
      [...firstByName.values()],
      (folder) => folder.name,
      (folder) => folder.id
    );
    for (const folder of siblings) {
      const parent = spaceLocations.get(folder.space_id);
      folderLocations.set(folder.id, {
        ...parent,
        segments: [...parent.segments, folderDirs.get(firstByName.get(folder.name))],
        folder: folder.name,
      });
    }
  }

  const forNote = (note) => {
    if (note.folder_id != null && folderLocations.has(note.folder_id)) {
      return folderLocations.get(note.folder_id);
    }
    if (note.space_id == null) {
      return { segments: [UNBOUND_PRIVATE_ROOT], space: PRIVATE_SECTION };
    }
    if (spaceLocations.has(note.space_id)) return spaceLocations.get(note.space_id);
    // A note must never fall into a Private section because its space is missing.
    const label = `Space ${note.space_id}`;
    return {
      segments: [WORKSPACES_ROOT, OTHER_SPACES, TEAMSPACES_SECTION, label],
      space: label,
    };
  };

  return {
    forNote,
    folderLocation: (folderId) => folderLocations.get(folderId) ?? null,
    folderLocations: () => [...folderLocations.values()],
  };
}

module.exports = { buildNotePlacements };
