import { useTranslation } from "react-i18next";
import { Copy, CircleCheck, CircleX, RotateCw } from "lucide-react";

interface NixOsPasteInfoProps {
  status: {
    hasYdotool: boolean;
    hasUinput: boolean;
    daemonRunning: boolean;
  };
  onRecheck: () => void;
}

// Declarative config NixOS users paste into their system config. Not translated (it's code).
const MANUAL_CONFIG = `programs.ydotool.enable = true;
hardware.uinput.enable  = true;
users.users.<you>.extraGroups = [ "ydotool" "uinput" ];`;

const FLAKE_CONFIG = `# flake inputs
inputs.openwhispr.url = "github:OpenWhispr/openwhispr";

# in your NixOS modules
imports = [ openwhispr.nixosModules.default ];
programs.openwhispr = {
  enable = true;
  users = [ "<you>" ];
};`;

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs">
      {ok ? (
        <CircleCheck className="h-3.5 w-3.5 text-emerald-500" />
      ) : (
        <CircleX className="h-3.5 w-3.5 text-red-500" />
      )}
      <span className="font-mono">{label}</span>
    </span>
  );
}

function CodeBlock({ code, copyLabel }: { code: string; copyLabel: string }) {
  return (
    <div className="flex items-start gap-1.5">
      <pre className="flex-1 text-[11px] bg-muted/60 rounded-md px-3 py-2 font-mono whitespace-pre-wrap break-all select-all overflow-x-auto">
        {code}
      </pre>
      <button
        onClick={() => navigator.clipboard.writeText(code).catch(() => {})}
        className="shrink-0 p-1.5 rounded-md hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
        title={copyLabel}
      >
        <Copy className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

export default function NixOsPasteInfo({ status, onRecheck }: NixOsPasteInfoProps) {
  const { t } = useTranslation();
  const copyLabel = t("settingsPage.general.waylandPaste.copy", { defaultValue: "Copy" });

  return (
    <div className="rounded-xl border border-border p-4 space-y-4">
      <p className="text-sm text-muted-foreground">
        {t("settingsPage.general.waylandPaste.nixos.intro", {
          defaultValue:
            "You're on NixOS. Auto-paste needs ydotool and /dev/uinput access, which NixOS grants declaratively.",
        })}
      </p>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="text-xs text-muted-foreground">
          {t("settingsPage.general.waylandPaste.nixos.detected", {
            defaultValue: "Detected",
          })}
          :
        </span>
        <StatusPill ok={status.hasYdotool} label="ydotool" />
        <StatusPill ok={status.hasUinput} label="/dev/uinput" />
        <StatusPill ok={status.daemonRunning} label="ydotoold" />
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">
          {t("settingsPage.general.waylandPaste.nixos.manualTitle", {
            defaultValue: "Add this to your configuration",
          })}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("settingsPage.general.waylandPaste.nixos.manualDesc", {
            defaultValue: "Configure it yourself, then rebuild.",
          })}
        </p>
        <CodeBlock code={MANUAL_CONFIG} copyLabel={copyLabel} />
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">
          {t("settingsPage.general.waylandPaste.nixos.flakeTitle", {
            defaultValue: "Installing via our flake?",
          })}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("settingsPage.general.waylandPaste.nixos.flakeDesc", {
            defaultValue:
              "If you install OpenWhispr from the flake, programs.openwhispr.enable turns on ydotool, the uinput module and the group memberships for you.",
          })}
        </p>
        <CodeBlock code={FLAKE_CONFIG} copyLabel={copyLabel} />
      </div>

      <p className="text-xs text-muted-foreground">
        {t("settingsPage.general.waylandPaste.nixos.rebuildNote", {
          defaultValue:
            "Run sudo nixos-rebuild switch, then log out and back in so the group change and the /dev/uinput rule take effect. Replace <you> with your username.",
        })}
      </p>

      <button
        onClick={onRecheck}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <RotateCw className="w-3 h-3" />
        {t("settingsPage.general.waylandPaste.recheck", { defaultValue: "Re-check" })}
      </button>
    </div>
  );
}
