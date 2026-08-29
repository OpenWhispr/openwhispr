import { createReactiveLocalFlag } from "./reactiveLocalFlag";

// Written by the sync probe (me/teams 404 check); read by the TEAM SPACES gate.
const flag = createReactiveLocalFlag("teamSpacesCapability");

export const readTeamSpacesCapability = flag.read;
export const writeTeamSpacesCapability = flag.write;
export const clearTeamSpacesCapability = flag.clear;
export const subscribeTeamSpacesCapability = flag.subscribe;

/**
 * UI-side read: unprobed counts as available. Team spaces are the default for
 * every signed-in user, so the section must not blink out of existence while
 * the first sync pass runs — only a confirmed 404 (endpoint not deployed)
 * takes it away. Sync keeps using the strict read above: guessing there would
 * attach workspace scope to pushes an older API cannot accept.
 */
export const readTeamSpacesAvailable = (): boolean =>
  localStorage.getItem("teamSpacesCapability") !== "false";
