/**
 * Which story the assistant demo tells. The email on the card is the same in
 * every case; what changes is the request the user is invited to speak, so it
 * only asks for what the assistant can actually deliver on this machine:
 * a connected calendar lets it look up free times, and active screen context
 * lets it read the sender's name and the ask off the card itself.
 */
export type AssistantDemoScenario = "calendarScreen" | "screen" | "calendar" | "general";

export function resolveAssistantDemoScenario({
  calendarConnected,
  screenContextActive,
}: {
  calendarConnected: boolean;
  screenContextActive: boolean;
}): AssistantDemoScenario {
  if (calendarConnected && screenContextActive) return "calendarScreen";
  if (screenContextActive) return "screen";
  if (calendarConnected) return "calendar";
  return "general";
}
