import { getCachedPlatform } from "../../utils/platform";

// Linux can still composite on the CPU (any NVIDIA driver, blocklisted drivers, or
// --disable-gpu-compositing in the launcher's flags file), where a blur behind a full-window
// overlay is redrawn on every repaint inside the dialog: hover lags and the GPU process pins
// a core (#2298). The scrim alone dims the page there.
export const blurBehindOverlays = getCachedPlatform() !== "linux";
