import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { refreshSkills, refreshSkillsOnFocus, useSkillsStore } from "../../stores/skillsStore";
import { useToast } from "../ui/useToast";
import { CreateSkillScreen } from "../skills/CreateSkillScreen";
import { ManageSkillsScreen } from "../skills/ManageSkillsScreen";
import { SkillDetailDialog } from "../skills/SkillDetailDialog";
import { SkillsHome, type SkillsHomeControl } from "../skills/SkillsHome";
import { UploadSkillsScreen } from "../skills/UploadSkillsScreen";
import type { SkillChatStart, SkillOpenRequest } from "../../types/skills";

type SkillsScreen = "home" | "manage" | "upload" | "create";

interface SkillsPaneProps {
  title: string;
  /** The pane stays mounted while another section is open. */
  active: boolean;
  /** Try now, Create with assistant and Draft with assistant; absent hides them. */
  onStartSkillChat?: (start: SkillChatStart) => void;
  /** A new id goes home and opens that skill. */
  openSkillRequest?: SkillOpenRequest | null;
  onOpenSkillRequestHandled?: () => void;
}

// Keys pressed in the pop-up or a menu are theirs. Both are portalled, but React still
// bubbles their events through the pane.
function isInsidePopup(target: EventTarget | null): boolean {
  for (let node = target as Element | null; node; node = node.parentNode as Element | null) {
    const role = node.getAttribute?.("role");
    if (role === "dialog" || role === "menu") return true;
  }
  return false;
}

/** Skills home, with Manage, Upload and Create opening in place of it. */
export function SkillsPane({
  title,
  active,
  onStartSkillChat,
  openSkillRequest = null,
  onOpenSkillRequestHandled,
}: SkillsPaneProps): ReactElement {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [screen, setScreen] = useState<SkillsScreen>("home");
  const [openedFrom, setOpenedFrom] = useState<SkillsHomeControl | null>(null);
  const [arrived, setArrived] = useState<string[]>([]);
  const [detail, setDetail] = useState<{ name: string; confirmUninstall: boolean } | null>(null);
  const root = useRef<HTMLDivElement>(null);

  // Opening the pane rereads the folder, as does a window focus while it shows, so a skill
  // edited outside the app shows up. A list that never loaded has home's card with Retry, so
  // only a reread that fails after a good one says so here.
  useEffect(() => {
    if (!active) return;
    void refreshSkills().then(() => {
      const { loaded, loadError } = useSkillsStore.getState();
      if (loaded && loadError) {
        toast({ title: t("skills.toasts.loadFailed"), variant: "destructive" });
      }
    });
    return refreshSkillsOnFocus();
  }, [active, t, toast]);

  // Open skill from a chat; the request stays set until the parent clears it.
  const handledOpenRequest = useRef<number | null>(null);
  useEffect(() => {
    if (!openSkillRequest || handledOpenRequest.current === openSkillRequest.id) return;
    handledOpenRequest.current = openSkillRequest.id;
    setScreen("home");
    setDetail({ name: openSkillRequest.name, confirmUninstall: false });
    onOpenSkillRequestHandled?.();
  }, [openSkillRequest, onOpenSkillRequestHandled]);

  // The control that opened a screen is gone with home, so the screen's heading takes focus
  // and the keyboard starts there; home restores its own focus.
  useEffect(() => {
    if (screen !== "home") root.current?.querySelector("h2")?.focus();
  }, [screen]);

  const open = (next: SkillsScreen, from: SkillsHomeControl) => {
    setOpenedFrom(from);
    setArrived([]);
    setScreen(next);
  };
  const goHome = () => setScreen("home");
  const arriveHome = (names: string[]) => {
    setArrived(names);
    goHome();
  };
  const openSkill = (name: string, confirmUninstall = false) =>
    setDetail({ name, confirmUninstall });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
    if (screen === "home" || isInsidePopup(event.target)) return;
    event.preventDefault();
    goHome();
  };

  return (
    <div ref={root} onKeyDown={onKeyDown}>
      {screen === "home" && (
        <SkillsHome
          title={title}
          restoreFocus={openedFrom}
          arrived={arrived}
          onOpenSkill={openSkill}
          onManage={(from) => open("manage", from)}
          onCreate={() => open("create", "add")}
          onUpload={() => open("upload", "add")}
          onCreateWithAssistant={onStartSkillChat && (() => onStartSkillChat({ kind: "create" }))}
        />
      )}
      {screen === "manage" && <ManageSkillsScreen onOpenSkill={openSkill} onBack={goHome} />}
      {screen === "upload" && <UploadSkillsScreen onDone={arriveHome} onBack={goHome} />}
      {screen === "create" && (
        <CreateSkillScreen
          onCreated={(name) => arriveHome([name])}
          onBack={goHome}
          onDraftWithAssistant={
            onStartSkillChat &&
            ((draft) => onStartSkillChat({ kind: "create", ...(draft ? { draft } : {}) }))
          }
        />
      )}
      {/* When the card or row that opened the pop-up is gone, the heading takes focus. */}
      <SkillDetailDialog
        name={detail?.name ?? null}
        open={detail !== null}
        initialConfirmUninstall={detail?.confirmUninstall}
        onOpenChange={(next) => {
          if (!next) setDetail(null);
        }}
        focusFallback={() => root.current?.querySelector("h2")?.focus()}
        onTryNow={
          onStartSkillChat &&
          ((skill) => {
            setDetail(null);
            onStartSkillChat({ kind: "try", ...skill });
          })
        }
      />
    </div>
  );
}
