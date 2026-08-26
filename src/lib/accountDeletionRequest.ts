import { cloudDelete } from "../services/cloudApi";

export async function deleteAccount(): Promise<void> {
  await cloudDelete("/api/auth/delete-account");
}
