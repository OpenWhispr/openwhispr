export function billingPortalErrorCopy(code?: string): {
  titleKey: string;
  descriptionKey: string;
} {
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
