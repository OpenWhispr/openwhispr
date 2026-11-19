export const WORKSPACE_ICON_INPUT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

const WORKSPACE_ICON_INPUT_MAX_BYTES = 10 * 1024 * 1024;
const WORKSPACE_ICON_SIZE = 256;

export function checkWorkspaceIconFile(file: {
  type: string;
  size: number;
}): "ok" | "unsupported" | "tooLarge" {
  if (!WORKSPACE_ICON_INPUT_TYPES.some((type): boolean => type === file.type)) {
    return "unsupported";
  }
  return file.size > WORKSPACE_ICON_INPUT_MAX_BYTES ? "tooLarge" : "ok";
}

export function coverCrop(width: number, height: number): { sx: number; sy: number; side: number } {
  const side = Math.min(width, height);
  return {
    sx: Math.floor((width - side) / 2),
    sy: Math.floor((height - side) / 2),
    side,
  };
}

// The file passed the type check but doesn't decode: corrupt, truncated, or another format.
export class WorkspaceIconUnreadableError extends Error {}

export async function encodeWorkspaceIcon(file: Blob): Promise<string> {
  const bitmap = await createImageBitmap(file).catch((): never => {
    throw new WorkspaceIconUnreadableError("Unable to decode workspace icon");
  });
  try {
    const canvas = new OffscreenCanvas(WORKSPACE_ICON_SIZE, WORKSPACE_ICON_SIZE);
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Unable to create workspace icon canvas");
    }
    const { sx, sy, side } = coverCrop(bitmap.width, bitmap.height);
    context.drawImage(bitmap, sx, sy, side, side, 0, 0, WORKSPACE_ICON_SIZE, WORKSPACE_ICON_SIZE);
    const blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.9 });
    return await new Promise<string>((resolve, reject): void => {
      const reader = new FileReader();
      reader.onload = (): void => {
        const dataUrl = reader.result as string;
        resolve(dataUrl.slice(dataUrl.indexOf(",") + 1));
      };
      reader.onerror = (): void => {
        reject(reader.error ?? new Error("Unable to read workspace icon"));
      };
      reader.readAsDataURL(blob);
    });
  } finally {
    bitmap.close();
  }
}
