// The code a billing action refused for an unvalidated session carries.
export const UNCONFIRMED_SESSION_CODE = "AUTH_CONTEXT_UNVALIDATED";
const UNCONFIRMED_SESSION_KEY = "auth.unconfirmedSession";

export function billingPortalErrorCopy(code?: string): {
  titleKey: string;
  descriptionKey: string;
} {
  if (code === UNCONFIRMED_SESSION_CODE) {
    return {
      titleKey: "settingsPage.account.billing.couldNotOpenTitle",
      descriptionKey: UNCONFIRMED_SESSION_KEY,
    };
  }
  if (code === "not_workspace_owner") {
    return {
      titleKey: "settingsPage.account.billing.contactOwnerTitle",
      descriptionKey: "settingsPage.account.billing.contactOwnerDescription",
    };
  }
  return {
    titleKey: "settingsPage.account.billing.couldNotOpenTitle",
    descriptionKey: "settingsPage.account.billing.couldNotOpenDescription",
  };
}

export function checkoutErrorDescriptionKey(code?: string): string {
  return code === UNCONFIRMED_SESSION_CODE
    ? UNCONFIRMED_SESSION_KEY
    : "settingsPage.account.checkout.couldNotOpenDescription";
}
