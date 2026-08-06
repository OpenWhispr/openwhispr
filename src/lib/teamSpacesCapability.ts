import { createReactiveLocalFlag } from "./reactiveLocalFlag";

// Written by the sync probe (me/teams 404 check); read by the TEAM SPACES gate.
const flag = createReactiveLocalFlag("teamSpacesCapability");

export const readTeamSpacesCapability = flag.read;
export const writeTeamSpacesCapability = flag.write;
export const clearTeamSpacesCapability = flag.clear;
export const subscribeTeamSpacesCapability = flag.subscribe;
