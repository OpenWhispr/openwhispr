export type ColorScheme = "purple" | "blue";

export interface ModelPickerStyles {
  container: string;
  header: string;
  modelCard: { selected: string; default: string };
  badges: { selected: string; downloaded: string; recommended: string };
  buttons: { download: string; select: string; delete: string; refresh: string };
}

export const MODEL_PICKER_COLORS: Record<ColorScheme, ModelPickerStyles> = {
  purple: {
    container:
      "bg-surface-secondary/95 rounded-lg overflow-hidden border border-default/60 backdrop-blur-xl shadow-(--shadow-metallic-light) dark:shadow-(--shadow-metallic-dark)",
    header: "font-medium text-primary tracking-tight",
    modelCard: {
      selected:
        "border-brand-solid/40 bg-brand-solid/12 dark:bg-brand-solid/8 shadow-(--shadow-selected-glow) relative before:absolute before:inset-0 before:bg-linear-to-b before:from-white/[0.03] before:to-transparent before:pointer-events-none",
      default:
        "border-default/70 bg-surface-secondary/50 hover:border-hover hover:bg-surface-tertiary/60 hover:-translate-y-[1px] hover:shadow-(--shadow-card-hover-subtle) transition-[background-color,border-color,transform,box-shadow] duration-200 ease-out",
    },
    badges: {
      selected: "text-[10px] text-on-solid bg-brand-solid px-1.5 py-0.5 rounded-sm font-medium",
      downloaded:
        "text-[10px] text-green bg-green-solid/10 dark:bg-green-solid/12 px-1.5 py-0.5 rounded-sm",
      recommended:
        "text-[10px] text-brand-solid bg-brand-solid/10 dark:bg-brand-solid/12 px-1.5 py-0.5 rounded-sm font-medium",
    },
    buttons: {
      download: "",
      select: "border-brand-solid/25 text-brand-solid hover:bg-brand-solid/8",
      delete: "text-red hover:text-red/90 hover:bg-red-solid/8 border-red-solid/25",
      refresh: "border-brand-solid/25 text-brand-solid hover:bg-brand-solid/8",
    },
  },
  blue: {
    container:
      "bg-surface-secondary/95 rounded-lg overflow-hidden border border-default/60 backdrop-blur-xl shadow-(--shadow-metallic-light) dark:shadow-(--shadow-metallic-dark)",
    header: "text-sm font-medium text-primary tracking-tight",
    modelCard: {
      selected:
        "border-brand-solid/40 bg-brand-solid/12 dark:bg-brand-solid/8 shadow-(--shadow-selected-glow) relative before:absolute before:inset-0 before:bg-linear-to-b before:from-white/[0.03] before:to-transparent before:pointer-events-none",
      default:
        "border-default/70 bg-surface-secondary/50 hover:border-hover hover:bg-surface-tertiary/60 hover:-translate-y-[1px] hover:shadow-(--shadow-card-hover-subtle) transition-[background-color,border-color,transform,box-shadow] duration-200 ease-out",
    },
    badges: {
      selected: "text-[10px] text-on-solid bg-brand-solid px-1.5 py-0.5 rounded-sm font-medium",
      downloaded: "text-[10px] text-green bg-green-solid/10 px-1.5 py-0.5 rounded-sm font-medium",
      recommended:
        "text-[10px] bg-brand-solid/10 text-brand-solid px-1.5 py-0.5 rounded-sm font-medium",
    },
    buttons: {
      download: "",
      select: "border-default text-primary hover:bg-surface-tertiary",
      delete: "text-red hover:text-red/90 hover:bg-red-solid/8 border-red-solid/25",
      refresh: "border-default text-primary hover:bg-surface-tertiary",
    },
  },
};

export function getModelPickerStyles(colorScheme: ColorScheme): ModelPickerStyles {
  return MODEL_PICKER_COLORS[colorScheme];
}
