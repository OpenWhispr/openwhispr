import { useEffect, useId, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Check, Code2, FileText, Info, X } from "../icons";
import { Button } from "../ui/button";
import { Breadcrumb } from "../ui/Breadcrumb";
import { DropZone } from "../ui/DropZone";
import { SectionLabel, SettingsPanel } from "../ui/SettingsSection";
import { useToast } from "../ui/useToast";
import { IntegrationsPane } from "../integrations/IntegrationsPane";
import { refreshSkills, useSkillsStore } from "../../stores/skillsStore";
import type { SkillProblemCode, SkillUploadPreview } from "../../types/skills";
import { MAX_SKILL_BYTES, problemKey, warningKey, writeFailedToast } from "./skillCopy";

interface UploadRow {
  id: number;
  preview: SkillUploadPreview;
  /** What the user decided for a file that asks Replace or Skip. */
  choice?: "replace" | "skip";
}

/**
 * What a row asks. It follows the rows above it and the skills installed now, which both change
 * after a file is previewed: a copy of a skill an earlier row holds, a skill already installed,
 * or neither.
 */
type Standing = "invalid" | "repeat" | "installed" | "ready";

// The library takes these; anything else, a dropped folder included, is refused by name.
const SKILL_FILE = /\.(md|zip|skill)$/i;

const refusal = (fileName: string, code: SkillProblemCode): SkillUploadPreview => ({
  fileName,
  status: "invalid",
  problems: [{ code }],
  warnings: [],
});

interface UploadSkillsScreenProps {
  onDone: (installed: string[]) => void;
  onBack: () => void;
}

export function UploadSkillsScreen({ onDone, onBack }: UploadSkillsScreenProps): ReactElement {
  const { t } = useTranslation();
  const { toast } = useToast();
  const skills = useSkillsStore((state) => state.skills);
  const [rows, setRows] = useState<UploadRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);
  const removeButtons = useRef(new Map<number, HTMLButtonElement>());
  const nextRowId = useRef(0);
  // Every upload this screen previewed; whatever didn't install is let go when it closes.
  const issued = useRef(new Set<string>());
  const closed = useRef(false);
  const hintId = useId();
  // In lower case: on macOS and Windows a folder that differs only in case is the same folder.
  const installed = new Set(skills.map((skill) => skill.name.toLowerCase()));
  const standing = (row: UploadRow): Standing => {
    const { preview } = row;
    if (preview.status === "invalid") return "invalid";
    const repeat = rows.some(
      (other) =>
        other.id < row.id &&
        other.preview.status !== "invalid" &&
        other.preview.name === preview.name
    );
    if (repeat) return "repeat";
    return installed.has((preview.name ?? "").toLowerCase()) ? "installed" : "ready";
  };
  const willInstall = (row: UploadRow) => {
    const asked = standing(row);
    return asked === "ready" || (asked !== "invalid" && row.choice === "replace");
  };
  const toInstall = rows.filter(willInstall);
  // Two files of one skill install as one, so the button counts skills.
  const skillCount = new Set(toInstall.map((row) => row.preview.name)).size;

  const addFiles = async (files: File[]) => {
    // Read one by one, so a file that can't be read doesn't take the others with it.
    const read = await Promise.all(
      files.map(async (file) => {
        if (!SKILL_FILE.test(file.name)) return { file, problem: "unsupportedFile" as const };
        if (file.size > MAX_SKILL_BYTES) return { file, problem: "tooLarge" as const };
        try {
          return { file, data: new Uint8Array(await file.arrayBuffer()) };
        } catch {
          return { file, problem: "unreadableArchive" as const };
        }
      })
    );
    const items = read.flatMap((entry) =>
      "data" in entry ? [{ fileName: entry.file.name, data: entry.data }] : []
    );
    // Read after the screen closed, so there's nothing left to show them in.
    if (closed.current) return;
    // A preview that fails leaves every file shown as one that can't be opened.
    const result =
      items.length > 0
        ? await window.electronAPI?.skillsPreviewUpload?.(items)?.catch(() => null)
        : null;
    const previews = result && "items" in result ? result.items : [];
    const tokens = previews.flatMap((preview) => (preview.token ? [preview.token] : []));
    // Previewed after the screen closed, so nothing here will install or free them.
    if (closed.current) {
      void window.electronAPI?.skillsDiscardUploads?.(tokens);
      return;
    }
    for (const token of tokens) issued.current.add(token);
    let next = 0;
    const added = read.map((entry): UploadRow => ({
      id: nextRowId.current++,
      preview:
        "data" in entry
          ? (previews[next++] ?? refusal(entry.file.name, "unreadableArchive"))
          : refusal(entry.file.name, entry.problem),
    }));
    setRows((current) => [...current, ...added]);
  };

  useEffect(() => {
    closed.current = false;
    const held = issued.current;
    return () => {
      closed.current = true;
      void window.electronAPI?.skillsDiscardUploads?.([...held]);
    };
  }, []);

  // Takes one file out of the upload, and lets go of what was previewed for it. Later copies of
  // its skill ask again, and focus moves to the next row, else the one before, else the drop zone.
  const remove = (row: UploadRow) => {
    const { token, name } = row.preview;
    if (token) {
      issued.current.delete(token);
      void window.electronAPI?.skillsDiscardUploads?.([token]);
    }
    const index = rows.findIndex((entry) => entry.id === row.id);
    const neighbour = rows[index + 1] ?? rows[index - 1];
    (neighbour ? removeButtons.current.get(neighbour.id) : dropZoneRef.current)?.focus();
    setRows((current) =>
      current
        .filter((entry) => entry.id !== row.id)
        .map((entry) =>
          name && entry.id > row.id && entry.preview.name === name
            ? { ...entry, choice: undefined }
            : entry
        )
    );
  };

  const choose = (id: number, choice?: UploadRow["choice"]) =>
    setRows((current) => current.map((row) => (row.id === id ? { ...row, choice } : row)));

  const submit = async () => {
    setSubmitting(true);
    const result = await window.electronAPI?.skillsCommitUpload?.({
      tokens: toInstall.map((row) => row.preview.token ?? ""),
      replace: toInstall
        .filter((row) => standing(row) !== "ready")
        .map((row) => row.preview.name ?? ""),
    });
    if (!result || !("installed" in result)) {
      setSubmitting(false);
      toast(writeFailedToast(t));
      return;
    }
    // Each file that didn't install gets its own toast, named, as Create does.
    for (const { fileName, error } of result.failed) {
      const failed = writeFailedToast(t, error);
      toast(
        fileName
          ? { ...failed, title: fileName, description: failed.description ?? failed.title }
          : failed
      );
    }
    if (result.installed.length === 0) {
      // A skill that arrived from elsewhere since its preview then asks Replace or Skip.
      await refreshSkills();
      setSubmitting(false);
      return;
    }
    // Stays busy from here: the screen closes once the list has reloaded.
    await refreshSkills();
    toast({
      title: t("skills.toasts.uploaded", { count: result.installed.length }),
      variant: "success",
    });
    onDone(result.installed);
  };

  const status = (row: UploadRow) => {
    const { preview } = row;
    const asked = standing(row);
    if (asked === "invalid") {
      const [problem] = preview.problems;
      return (
        <span className="flex items-center gap-1.5 text-xs text-warning">
          <AlertTriangle size={13} className="shrink-0" />
          {t(problemKey(problem), problem.values)}
        </span>
      );
    }
    if (asked === "ready") {
      return (
        <span className="flex items-center gap-1.5 text-xs text-foreground">
          <Check size={13} className="text-success" />
          {t("skills.upload.ready")}
        </span>
      );
    }
    // A copy of a skill an earlier row holds: Replace uses this file instead of that one.
    const repeat = asked === "repeat";
    if (row.choice) {
      return (
        <>
          {row.choice === "replace" ? (
            <span className="flex items-center gap-1.5 text-xs text-foreground">
              <Check size={13} className="text-success" />
              {t(repeat ? "skills.upload.willReplaceCopy" : "skills.upload.willReplace")}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">{t("skills.upload.skipped")}</span>
          )}
          <Button variant="link" size="sm" className="h-6 px-1" onClick={() => choose(row.id)}>
            {t("skills.upload.undo")}
          </Button>
        </>
      );
    }
    return (
      <>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Info size={13} className="text-info shrink-0" />
          {t(repeat ? "skills.upload.alsoInUpload" : "skills.upload.duplicate")}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2.5"
          onClick={() => choose(row.id, "replace")}
        >
          {t("skills.upload.replace")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2.5"
          onClick={() => choose(row.id, "skip")}
        >
          {t("common.skip")}
        </Button>
      </>
    );
  };

  return (
    <IntegrationsPane
      breadcrumb={
        <Breadcrumb
          label={t("skills.breadcrumb.label")}
          items={[
            { label: t("skills.breadcrumb.root"), onSelect: onBack },
            { label: t("skills.upload.crumb") },
          ]}
        />
      }
      title={t("skills.upload.title")}
      description={t("skills.upload.description")}
    >
      <DropZone
        ref={dropZoneRef}
        label={t("skills.upload.drop")}
        activeLabel={t("skills.upload.dropActive")}
        hint={t("skills.upload.several")}
        onFiles={(files) => void addFiles(files)}
        onBrowse={() => inputRef.current?.click()}
        className="mt-0 py-10"
      />
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".md,.zip,.skill"
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          // Cleared so choosing the same file again still reports it.
          event.target.value = "";
          if (files.length > 0) void addFiles(files);
        }}
      />
      <ul className="mt-3 space-y-1 ps-1 text-xs text-muted-foreground/80 leading-relaxed">
        <li className="flex items-center gap-2">
          <FileText size={12} className="shrink-0 text-muted-foreground/60" />
          <span>{t("skills.upload.ruleMd")}</span>
        </li>
        <li className="flex items-center gap-2">
          <Code2 size={12} className="shrink-0 text-muted-foreground/60" />
          <span>{t("skills.upload.ruleZip")}</span>
        </li>
      </ul>
      {rows.length > 0 && (
        <div className="mt-4">
          <SectionLabel>{t("skills.upload.fileCount", { count: rows.length })}</SectionLabel>
          <SettingsPanel role="list">
            {rows.map((row) => {
              const Icon = row.preview.fileName.toLowerCase().endsWith(".md") ? FileText : Code2;
              return (
                <div
                  key={row.id}
                  role="listitem"
                  className="px-4 py-3 flex flex-wrap items-center gap-x-3 gap-y-1.5"
                >
                  <div className="flex flex-1 basis-52 min-w-0 items-center gap-2.5">
                    <Icon size={14} className="shrink-0 text-muted-foreground/70" />
                    <span dir="ltr" className="truncate font-mono text-xs text-foreground">
                      {row.preview.fileName}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">{status(row)}</div>
                  <button
                    ref={(element) => {
                      if (element) removeButtons.current.set(row.id, element);
                      else removeButtons.current.delete(row.id);
                    }}
                    type="button"
                    onClick={() => remove(row)}
                    aria-label={t("skills.create.removeFile", { path: row.preview.fileName })}
                    className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground/70 hover:bg-foreground/8 hover:text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring/30"
                  >
                    <X size={12} />
                  </button>
                  {row.preview.status !== "invalid" &&
                    row.preview.warnings.map((warning) => (
                      <p
                        key={warning.code}
                        className="basis-full ps-6 text-[11px] leading-relaxed text-muted-foreground"
                      >
                        {t(warningKey(warning), warning.values)}
                      </p>
                    ))}
                </div>
              );
            })}
          </SettingsPanel>
        </div>
      )}
      <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
        {toInstall.length === 0 && (
          <span id={hintId} className="me-1 text-xs text-muted-foreground">
            {t("skills.upload.chooseFile")}
          </span>
        )}
        <Button variant="ghost" size="sm" onClick={onBack}>
          {t("common.cancel")}
        </Button>
        <Button
          size="sm"
          disabled={toInstall.length === 0 || submitting}
          aria-describedby={toInstall.length === 0 ? hintId : undefined}
          onClick={() => void submit()}
        >
          {toInstall.length === 0
            ? t("skills.upload.submit")
            : t("skills.upload.submitCount", { count: skillCount })}
        </Button>
      </div>
    </IntegrationsPane>
  );
}
