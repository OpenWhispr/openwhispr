import { createReactiveLocalFlag } from "./reactiveLocalFlag";

// Written by the sync probe (me/teams 404 check); read by the TEAM SPACES gate.
const flag = createReactiveLocalFlag("teamSpacesCapability");

export const readTeamSpacesCapability = flag.read;
export const notifyTeamSpacesCapabilityChanged = flag.notify;
export const subscribeTeamSpacesCapability = flag.subscribe;
