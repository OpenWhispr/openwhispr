import { getCachedPlatform } from "../../utils/platform";

// Linux can still composite on the CPU (any NVIDIA driver, blocklisted drivers, or
// --disable-gpu-compositing in the launcher's flags file), where a blur behind a large overlay
// is redrawn on every repaint above it: hover inside a dialog lags, and the note action
// overlay's endless scanner animation keeps the GPU process at a full core (#2298). The scrim
// alone dims the page there.
export const blurBehindOverlays = getCachedPlatform() !== "linux";
