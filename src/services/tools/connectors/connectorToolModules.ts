import type { ToolDefinition, ToolRegistry } from "../ToolRegistry";
import type { EmailDraftTarget } from "../../../utils/emailDraftTarget";
import { emailToolModule } from "./emailDraftTool";
import { linearToolModule } from "./linearTools";
import { slackToolModule } from "./slackSendMessageTool";
import { githubToolModule } from "./githubTools";

/** What a module may need to build its tools for this send. */
export interface ConnectorToolEnv {
  emailDraftTarget: EmailDraftTarget;
}

/** One connector's tools. Each connector's own file exports its module. */
export interface ConnectorToolModule {
  connectorId: string;
  /** False for tools that work without a login (compose windows, find_contact). */
  requiresConnection: boolean;
  createTools: (env: ConnectorToolEnv) => ToolDefinition[];
}

export interface ConnectorToolSettings extends ConnectorToolEnv {
  /** Connected and not waiting on a reconnect (connectorStatusStore.readyConnectorIds). */
  readyConnectorIds: readonly string[];
}

/** Every connector's tools, in the order the model sees them. New connectors append here. */
export const CONNECTOR_TOOL_MODULES: readonly ConnectorToolModule[] = [
  emailToolModule,
  slackToolModule,
  linearToolModule,
  githubToolModule,
];

export function registerConnectorTools(
  registry: ToolRegistry,
  settings: ConnectorToolSettings,
  modules: readonly ConnectorToolModule[] = CONNECTOR_TOOL_MODULES
): void {
  const env: ConnectorToolEnv = { emailDraftTarget: settings.emailDraftTarget };
  for (const toolModule of modules) {
    if (
      toolModule.requiresConnection &&
      !settings.readyConnectorIds.includes(toolModule.connectorId)
    ) {
      continue;
    }
    for (const tool of toolModule.createTools(env)) {
      // Two tools with one name would silently replace each other.
      if (registry.get(tool.name)) {
        throw new Error(`connector tool "${tool.name}" is registered twice`);
      }
      registry.register(tool);
    }
  }
}
