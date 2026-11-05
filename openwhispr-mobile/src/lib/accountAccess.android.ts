import { createAccountAccess } from './accountAccessCore';
import { androidAccountAccessPresentation } from '../android/accountAccess';

export const {
  accountRequiredForCloud,
  requiresRealAccount,
  cloudModeRequiresAccount,
  canRunCloudMeeting,
  getCloudAccountRequiredMessage,
  getCloudOnlyAccountRequiredMessage,
  showAccountRequiredAlert,
  handleAccountRequiredError,
} = createAccountAccess(androidAccountAccessPresentation);
