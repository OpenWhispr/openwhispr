import { createAiWorkflows } from './aiWorkflowsCore';

export const {
  WORKFLOW_LABELS,
  WORKFLOWS,
  UNSET_PROVIDER_NOTES,
  ON_DEVICE_CLEANUP_UNSUPPORTED_NOTE,
  LOCAL_MODE_DICTATION_NOTES,
  ON_DEVICE_MODE_NOTES,
  CLOUD_CLEANUP_NEEDS_ACCOUNT_NOTE,
  cloudAccessFor,
  cloudCleanupNeedsAccount,
  cleanupRunsOnDevice,
  workflowSelection,
  workflowSwitchedOff,
  voiceAssistantCanRun,
  parseWorkflow,
  unsetSelection,
  workflowSummary,
} = createAiWorkflows();
