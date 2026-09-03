interface LeaderboardDemoEnvironment {
  DEV: boolean;
  VITE_LEADERBOARD_DEMO?: string;
}

export function isLeaderboardDemoEnvironment(env: LeaderboardDemoEnvironment): boolean {
  return env.DEV && env.VITE_LEADERBOARD_DEMO === "true";
}

const viteEnvironment = (import.meta as ImportMeta & { env?: LeaderboardDemoEnvironment }).env;

export const LEADERBOARD_DEMO_ENABLED = viteEnvironment
  ? isLeaderboardDemoEnvironment(viteEnvironment)
  : false;
