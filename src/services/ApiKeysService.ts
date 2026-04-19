import { cloudGet, cloudPost } from "./cloudApi.js";

interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
}

interface CreateApiKeyResponse extends ApiKey {
  key: string;
}

interface CreateApiKeyOptions {
  name: string;
  scopes: string[];
  expiresInDays?: number | null;
}

interface V1Response<T> {
  data: T;
}

async function listApiKeys(): Promise<{ keys: ApiKey[] }> {
  const res = await cloudGet<V1Response<{ keys: ApiKey[] }>>("/api/v1/keys/list");
  return { keys: res.data.keys };
}

async function createApiKey(options: CreateApiKeyOptions): Promise<CreateApiKeyResponse> {
  const res = await cloudPost<V1Response<CreateApiKeyResponse>>("/api/v1/keys/create", {
    name: options.name,
    scopes: options.scopes,
    ...(options.expiresInDays != null ? { expires_in_days: options.expiresInDays } : {}),
  });
  return res.data;
}

async function revokeApiKey(id: string): Promise<{ revoked: true }> {
  await cloudPost(`/api/v1/keys/${id}/revoke`);
  return { revoked: true };
}

export { listApiKeys, createApiKey, revokeApiKey };
export type { ApiKey, CreateApiKeyResponse, CreateApiKeyOptions };

export const ApiKeysService = {
  list: listApiKeys,
  create: createApiKey,
  revoke: revokeApiKey,
};
