import React from "react";
import { workspaceCan } from "../../lib/capabilities";
import WorkspaceDeveloperTab from "./WorkspaceDeveloperTab";
import SettingsWorkspaceFrame from "./SettingsWorkspaceFrame";
import { useSettingsWorkspace } from "./useSettingsWorkspace";

export default function WorkspaceDeveloperSection(): React.ReactElement | null {
  const state = useSettingsWorkspace();
  return (
    <SettingsWorkspaceFrame state={state}>
      {(workspace) =>
        // The nav hides Developer without manage_settings; this covers the moment before it
        // re-resolves the section.
        workspaceCan(workspace, "manage_settings") ? (
          <WorkspaceDeveloperTab workspace={workspace} />
        ) : null
      }
    </SettingsWorkspaceFrame>
  );
}
