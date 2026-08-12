const test = require("node:test");
const assert = require("node:assert/strict");

const localSpace = (overrides) => ({
  id: 1,
  kind: "team",
  cloud_space_id: null,
  cloud_team_id: null,
  ...overrides,
});
const remoteSpace = (id, teams) => ({ id, teams });

test("exact cloud space identity proves the local account scope", async () => {
  const { partitionLocalTeamSpaces } = await import("../../src/services/accountSpaceValidation.ts");
  const exact = localSpace({ id: 10, cloud_space_id: "space-a" });
  const foreign = localSpace({ id: 11, cloud_space_id: "space-b" });
  const result = partitionLocalTeamSpaces(
    [exact, foreign],
    [remoteSpace("space-a", [{ id: "team-a" }])]
  );

  assert.deepEqual(
    result.proven.map((space) => space.id),
    [10]
  );
  assert.deepEqual(
    result.unproven.map((space) => space.id),
    [11]
  );
});

test("legacy identity requires one unambiguous single-team remote space", async () => {
  const { partitionLocalTeamSpaces } = await import("../../src/services/accountSpaceValidation.ts");
  const legacy = localSpace({ id: 20, cloud_team_id: "team-a" });

  assert.deepEqual(
    partitionLocalTeamSpaces([legacy], [remoteSpace("space-a", [{ id: "team-a" }])]).proven.map(
      (space) => space.id
    ),
    [20]
  );
  assert.deepEqual(
    partitionLocalTeamSpaces(
      [legacy],
      [remoteSpace("space-a", [{ id: "team-a" }, { id: "team-b" }])]
    ).unproven.map((space) => space.id),
    [20],
    "broad membership in a multi-team space is not a legacy identity proof"
  );
  assert.deepEqual(
    partitionLocalTeamSpaces(
      [legacy],
      [remoteSpace("space-a", [{ id: "team-a" }]), remoteSpace("space-b", [{ id: "team-a" }])]
    ).unproven.map((space) => space.id),
    [20],
    "an ambiguous migration match is not trusted"
  );
});

test("private rows never participate in account-scoped team cleanup", async () => {
  const { partitionLocalTeamSpaces } = await import("../../src/services/accountSpaceValidation.ts");
  const privateSpace = localSpace({
    id: 30,
    kind: "private",
    cloud_space_id: "missing",
  });
  const result = partitionLocalTeamSpaces([privateSpace], []);
  assert.deepEqual(result, { proven: [], unproven: [] });
});
