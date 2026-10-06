import { getCachedPlatform } from "../../utils/platform";

// Linux composites on the CPU (main.js passes --disable-gpu-compositing), where a blur
// behind a full-window overlay is redrawn on every repaint inside the dialog: hover lags
// and the GPU process pins a core (#2298). The scrim alone dims the page there.
export const blurBehindOverlays = getCachedPlatform() !== "linux";
