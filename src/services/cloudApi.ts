interface CloudApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
}

async function cloudRequest<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const result = (await window.electronAPI?.cloudApiRequest?.({
    method,
    path,
    body,
  })) as CloudApiResponse<T> | undefined;

  if (!result?.success) {
    throw new Error(result?.error ?? "Cloud API request failed");
  }

  return result.data as T;
}

export async function cloudGet<T = unknown>(path: string): Promise<T> {
  return cloudRequest<T>("GET", path);
}

export async function cloudPost<T = unknown>(path: string, body?: unknown): Promise<T> {
  return cloudRequest<T>("POST", path, body);
}

export async function cloudPatch<T = unknown>(path: string, body?: unknown): Promise<T> {
  return cloudRequest<T>("PATCH", path, body);
}

export async function cloudDelete<T = unknown>(path: string, body?: unknown): Promise<T> {
  return cloudRequest<T>("DELETE", path, body);
}
