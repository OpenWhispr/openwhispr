import { cloudDeleteForAuthGeneration } from "../services/cloudApi";
import { getValidatedAuthGeneration } from "./authRequestContext";

export async function deleteAccount(authGeneration = getValidatedAuthGeneration()): Promise<void> {
  if (authGeneration == null || authGeneration !== getValidatedAuthGeneration()) {
    throw Object.assign(new Error("Account deletion consent is no longer current"), {
      code: "AUTH_CONTEXT_CHANGED",
    });
  }
  await cloudDeleteForAuthGeneration("/api/auth/delete-account", undefined, authGeneration);
}
