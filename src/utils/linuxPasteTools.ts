type Translate = (key: string) => string;

export type LinuxPasteTool = "wtype" | "ydotool" | "xdotool" | "wl-clipboard";

export interface LinuxPasteInstallCommand {
  label: string;
  cmd: string;
}

export function getLinuxPasteInstallCommands(
  t: Translate,
  tool: LinuxPasteTool
): LinuxPasteInstallCommand[] {
  const commands = [
    {
      label: t(
        tool === "xdotool"
          ? "pasteToolsInfo.installCommands.debianUbuntuMint"
          : "pasteToolsInfo.installCommands.debianUbuntuPop"
      ),
      cmd: `sudo apt install ${tool}`,
    },
    { label: t("pasteToolsInfo.installCommands.fedoraRhel"), cmd: `sudo dnf install ${tool}` },
    { label: t("pasteToolsInfo.installCommands.archLinux"), cmd: `sudo pacman -S ${tool}` },
  ];

  return tool === "xdotool"
    ? commands
    : [
        ...commands,
        {
          label: t("pasteToolsInfo.installCommands.openSuse"),
          cmd: `sudo zypper install ${tool}`,
        },
      ];
}

// wtype is the paste tool on wlroots. COSMIC is left out: cosmic-comp drops the
// modifiers wtype sends (pop-os/cosmic-comp#2945), so it would break terminal paste.
export function needsWtype(pasteTools: PasteToolsResult) {
  return !pasteTools.hasWtype && !!pasteTools.isWlroots;
}

export function needsLinuxPasteToolGuidance(pasteTools: PasteToolsResult) {
  return (
    pasteTools.platform === "linux" &&
    (!pasteTools.available || needsWtype(pasteTools) || !!pasteTools.wlCopyMissing)
  );
}
import type { PasteToolsResult } from "../types/electron";
