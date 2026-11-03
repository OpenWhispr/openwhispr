import { createAccountAccess } from './accountAccessCore';

export const {
  accountRequiredForCloud,
  requiresRealAccount,
  cloudModeRequiresAccount,
  canRunCloudMeeting,
  getCloudAccountRequiredMessage,
  getCloudOnlyAccountRequiredMessage,
  showAccountRequiredAlert,
  handleAccountRequiredError,
} = createAccountAccess();
