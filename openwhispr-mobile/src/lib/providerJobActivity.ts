// A startup hydration rerun must not recover work still running in this JS process.
const activeJobs = new Set<string>();

export function isProviderJobActive(jobId: string): boolean {
  return activeJobs.has(jobId);
}

export async function withActiveProviderJob<T>(
  jobId: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (jobId) activeJobs.add(jobId);
  try {
    return await run();
  } finally {
    if (jobId) activeJobs.delete(jobId);
  }
}
