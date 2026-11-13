import React, { useEffect, useId, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LogOut, Trash2, Upload } from "../icons";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { WorkspacesService } from "../../services/WorkspacesService";
import { deleteWorkspace, leaveWorkspace } from "../../services/workspaceActions";
import { useAuth } from "../../hooks/useAuth";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useToast } from "../ui/useToast";
import { workspaceCan } from "../../lib/capabilities";
import { getValidatedAuthGeneration } from "../../lib/authRequestContext";
import {
  WORKSPACE_ICON_INPUT_TYPES,
  checkWorkspaceIconFile,
  encodeWorkspaceIcon,
} from "../../lib/workspaceIcon";
import { exitReducer } from "../../lib/workspaceExitFlow";
import { transferReducer } from "../../lib/workspaceTransferFlow";
import { WorkspaceExitDialog } from "../workspace/WorkspaceExitDialog";
import { TransferOwnershipDialog } from "../workspace/TransferOwnershipDialog";
import MemberAvatar from "../MemberAvatar";
import EnterpriseConsoleRow from "./EnterpriseConsoleRow";
import SettingsWorkspaceFrame from "./SettingsWorkspaceFrame";
import { PAGE_DESCRIPTION, PAGE_TITLE } from "./tableTokens";
import { useSettingsWorkspace } from "./useSettingsWorkspace";
import type { SettingsSectionType } from "../../lib/settingsNav";
import type { Workspace } from "../../types/electron";

/** The API accepts 80, so longer names already exist; they still display in full. */
export const WORKSPACE_NAME_MAX = 65;

export function canSaveWorkspaceName(draft: string, saved: string): boolean {
  const name = draft.trim();
  return name.length > 0 && name !== saved && name.length <= WORKSPACE_NAME_MAX;
}

interface WorkspaceGeneralSectionProps {
  onNavigateToSection?: (section: SettingsSectionType, subTab?: string) => void;
  /** Opens the workspace picker in the Settings nav. */
  onChooseWorkspace?: () => void;
}

export default function WorkspaceGeneralSection({
  onNavigateToSection,
  onChooseWorkspace,
}: WorkspaceGeneralSectionProps): React.ReactElement | null {
  const state = useSettingsWorkspace();
  const { user } = useAuth();
  // Held here, outside the frame and not keyed by workspace, so the Left and
  // Deleted outcomes survive the refresh that moves the store to another
  // workspace (or to none, which unmounts the frame's page).
  const [exitState, dispatchExit] = useReducer(exitReducer, { kind: "closed" });
  const [transferState, dispatchTransfer] = useReducer(transferReducer, { kind: "closed" });
  const exitTargetId = useRef<string | null>(null);
  const [transferWorkspace, setTransferWorkspace] = useState<Workspace | null>(null);

  const startExit = (workspace: Workspace, type: "startLeave" | "startDelete"): void => {
    exitTargetId.current = workspace.id;
    dispatchExit({ type, name: workspace.name });
  };

  const startTransfer = (workspace: Workspace): void => {
    setTransferWorkspace(workspace);
    dispatchTransfer({ type: "open" });
  };

  const confirmLeave = async (): Promise<void> => {
    const workspaceId = exitTargetId.current;
    if (!workspaceId || !user?.id) throw new Error("No workspace or user to leave with");
    await leaveWorkspace(workspaceId, user.id);
  };

  const confirmDelete = async (): Promise<void> => {
    const workspaceId = exitTargetId.current;
    if (!workspaceId) throw new Error("No workspace to delete");
    await deleteWorkspace(workspaceId);
  };

  return (
    <>
      <SettingsWorkspaceFrame state={state} onChooseWorkspace={onChooseWorkspace}>
        {(workspace) => (
          <GeneralPage
            workspace={workspace}
            onTransfer={() => startTransfer(workspace)}
            onDelete={() => startExit(workspace, "startDelete")}
            onLeave={() => startExit(workspace, "startLeave")}
          />
        )}
      </SettingsWorkspaceFrame>
      <WorkspaceExitDialog
        state={exitState}
        dispatch={dispatchExit}
        onConfirmLeave={confirmLeave}
        onConfirmDelete={confirmDelete}
        onChooseWorkspace={() => onChooseWorkspace?.()}
      />
      {transferWorkspace && (
        <TransferOwnershipDialog
          workspace={transferWorkspace}
          state={transferState}
          dispatch={dispatchTransfer}
          // The dialog announces the transfer itself.
          onTransferred={() => onNavigateToSection?.("workspacePeople", "members")}
        />
      )}
    </>
  );
}

interface GeneralPageProps {
  workspace: Workspace;
  onTransfer: () => void;
  onDelete: () => void;
  onLeave: () => void;
}

const ROW_CLASS =
  "flex items-center justify-between gap-4 border-t border-border/70 dark:border-border-subtle/60 pt-8";
const DESTRUCTIVE_PILL =
  "bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive dark:text-destructive dark:hover:bg-destructive/20";

function GeneralPage({
  workspace,
  onTransfer,
  onDelete,
  onLeave,
}: GeneralPageProps): React.ReactElement {
  const { t } = useTranslation();
  const { toast } = useToast();
  const refresh = useWorkspaceStore((s) => s.refresh);
  const [name, setName] = useState(workspace.name);
  const [saving, setSaving] = useState(false);
  const [iconBusy, setIconBusy] = useState<"upload" | "remove" | null>(null);
  const iconInputRef = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const hintId = useId();
  const canEdit = workspaceCan(workspace, "manage_settings");
  const canTransfer = workspaceCan(workspace, "transfer_ownership");
  const canDelete = workspaceCan(workspace, "delete_workspace");
  const canLeave = workspaceCan(workspace, "leave");
  const overLimit = canEdit && name.trim().length > WORKSPACE_NAME_MAX;

  useEffect(() => {
    setName(workspace.name);
  }, [workspace.id, workspace.name]);

  async function applyUpdate(update: () => Promise<unknown>, successTitle: string): Promise<void> {
    try {
      await update();
      await refresh({ fresh: true });
      toast({ title: successTitle });
    } catch (error) {
      toast({
        title: t("common.error"),
        description: error instanceof Error ? error.message : t("common.unknownError"),
        variant: "destructive",
      });
    }
  }

  async function handleSave(): Promise<void> {
    setSaving(true);
    await applyUpdate(
      (): Promise<Workspace> => WorkspacesService.update(workspace.id, { name: name.trim() }),
      t("settingsPage.workspace.general.saved")
    );
    setSaving(false);
  }

  async function handleIconFile(file: File): Promise<void> {
    if (!canEdit || iconBusy) return;
    const validation = checkWorkspaceIconFile(file);
    if (validation !== "ok") {
      toast({
        title: t("common.error"),
        description: t(
          validation === "unsupported"
            ? "settingsPage.workspace.general.iconUnsupported"
            : "settingsPage.workspace.general.iconTooLarge"
        ),
        variant: "destructive",
      });
      return;
    }
    // Pin before encoding so an account switch cannot adopt the replacement session.
    const authGeneration = getValidatedAuthGeneration();
    setIconBusy("upload");
    await applyUpdate(async (): Promise<Workspace> => {
      if (authGeneration === null) throw new Error(t("auth.unconfirmedSession"));
      return WorkspacesService.uploadIcon(
        workspace.id,
        await encodeWorkspaceIcon(file),
        authGeneration
      );
    }, t("settingsPage.workspace.general.iconUploaded"));
    setIconBusy(null);
  }

  async function handleIconRemove(): Promise<void> {
    if (!canEdit || iconBusy) return;
    setIconBusy("remove");
    await applyUpdate(
      (): Promise<Workspace> => WorkspacesService.removeIcon(workspace.id),
      t("settingsPage.workspace.general.iconRemoved")
    );
    setIconBusy(null);
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className={PAGE_TITLE}>{t("settingsPage.workspace.general.title")}</h2>
        <p className={PAGE_DESCRIPTION}>
          {canEdit
            ? t("settingsPage.workspace.general.subtitleManage")
            : t("settingsPage.workspace.general.subtitleView")}
        </p>
      </div>

      <div className="space-y-3">
        <div>
          <label htmlFor={nameId} className="text-xs font-medium text-foreground">
            {t("settingsPage.workspace.general.nameLabel")}
          </label>
          <p
            id={hintId}
            className={
              overLimit
                ? "text-xs text-destructive mt-0.5"
                : "text-xs text-muted-foreground/80 mt-0.5"
            }
          >
            {t("settingsPage.workspace.general.nameHint")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id={nameId}
            dir="auto"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label={t("settingsPage.workspace.general.nameLabel")}
            aria-describedby={hintId}
            aria-invalid={overLimit || undefined}
            disabled={!canEdit || saving}
            // Stops typing past the limit; an existing longer name is not cut.
            maxLength={WORKSPACE_NAME_MAX}
            className="h-[38px] w-[400px] max-w-full rounded-xl"
          />
          {canEdit && (
            <Button
              size="sm"
              onClick={() => void handleSave()}
              disabled={saving || !canSaveWorkspaceName(name, workspace.name)}
            >
              {saving ? t("common.saving") : t("common.save")}
            </Button>
          )}
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <p className="text-xs font-medium text-foreground">
            {t("settingsPage.workspace.general.iconLabel")}
          </p>
          <p className="text-xs text-muted-foreground/80 mt-0.5">
            {t("settingsPage.workspace.general.iconHint")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <MemberAvatar name={workspace.name} email={null} image={workspace.icon_url} size="lg" />
          {canEdit && (
            <>
              <input
                ref={iconInputRef}
                type="file"
                accept={WORKSPACE_ICON_INPUT_TYPES.join(",")}
                className="hidden"
                disabled={iconBusy !== null}
                onChange={(event): void => {
                  const file = event.target.files?.[0];
                  // Cleared so choosing the same file again still reports it.
                  event.target.value = "";
                  if (file) void handleIconFile(file);
                }}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={(): void => iconInputRef.current?.click()}
                disabled={iconBusy !== null}
              >
                <Upload className="size-3.5" aria-hidden="true" />
                {t(
                  iconBusy === "upload"
                    ? "settingsPage.workspace.general.iconUploading"
                    : workspace.icon_url
                      ? "settingsPage.workspace.general.iconChange"
                      : "settingsPage.workspace.general.iconUpload"
                )}
              </Button>
              {workspace.icon_url && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(): void => void handleIconRemove()}
                  disabled={iconBusy !== null}
                >
                  <Trash2 className="size-3.5" aria-hidden="true" />
                  {t("settingsPage.workspace.general.iconRemove")}
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      <div>
        <p className="text-xs font-medium text-foreground">
          {t("settingsPage.workspace.general.roleLabel")}
        </p>
        <p className="text-xs text-muted-foreground/80 mt-0.5">
          {t(`settingsPage.workspace.role.${workspace.role}`)}
        </p>
      </div>

      <EnterpriseConsoleRow workspace={workspace} />

      {canTransfer && (
        <div className={ROW_CLASS}>
          <RowText
            title={t("settingsPage.workspace.general.ownerTitle")}
            description={t("settingsPage.workspace.general.ownerDescription")}
          />
          <Button size="sm" onClick={onTransfer}>
            {t("workspaces.transfer.submit")}
          </Button>
        </div>
      )}

      {canDelete && (
        <div className={ROW_CLASS}>
          <RowText
            title={t("settingsPage.workspace.general.dangerTitle")}
            description={t("settingsPage.workspace.general.dangerDescription")}
          />
          <Button size="sm" variant="ghost" onClick={onDelete} className={DESTRUCTIVE_PILL}>
            <Trash2 className="size-3.5" aria-hidden="true" />
            {t("settingsPage.workspace.general.delete")}
          </Button>
        </div>
      )}

      {canLeave && (
        <div className={ROW_CLASS}>
          <RowText
            title={t("settingsPage.workspace.general.leaveTitle")}
            description={t("settingsPage.workspace.general.leaveDescription")}
          />
          <Button size="sm" variant="ghost" onClick={onLeave} className={DESTRUCTIVE_PILL}>
            <LogOut className="size-3.5 rtl:rotate-180" aria-hidden="true" />
            {t("settingsPage.workspace.general.leave")}
          </Button>
        </div>
      )}
    </div>
  );
}

function RowText({
  title,
  description,
}: {
  title: string;
  description: string;
}): React.ReactElement {
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium text-foreground">{title}</p>
      <p className="text-xs text-muted-foreground/80 mt-0.5 leading-relaxed">{description}</p>
    </div>
  );
}
