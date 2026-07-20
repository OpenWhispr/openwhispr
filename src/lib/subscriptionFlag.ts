import { createReactiveLocalFlag } from "./reactiveLocalFlag";

// Written by useUsage after each usage fetch; read by surfaces that gate on
// subscription without paying a usage fetch (e.g. the note share affordance).
const flag = createReactiveLocalFlag("isSubscribed");

export const readIsSubscribed = flag.read;
export const notifyIsSubscribedChanged = flag.notify;
export const subscribeIsSubscribed = flag.subscribe;
