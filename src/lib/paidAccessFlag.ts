import { createReactiveLocalFlag } from "./reactiveLocalFlag.ts";

// Paid access = subscription or trial. Written by the usage store next to
// isSubscribed, with the same account lifecycle, so windows that never load
// usage (the voice assistant) gate paid features correctly for trial users.
const flag = createReactiveLocalFlag("hasPaidAccess");

export const readHasPaidAccess = flag.read;
export const writeHasPaidAccess = flag.write;
export const clearHasPaidAccess = flag.clear;
