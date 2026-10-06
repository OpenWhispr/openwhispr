import type { CudaWhisperStatus, VulkanWhisperStatus } from "../types/electron";

export type WhisperGpuBackend = "cuda" | "vulkan";

// Which pack the transcription GPU card describes. A working pack comes first,
// CUDA before Vulkan as the resolver prefers it, so a working Vulkan setup is
// never re-prompted to download the CUDA pack. Next comes a pack an older
// release installed that this version can't use (#2424): the startup notice
// names it, so the card offers its re-download even when GPU detection no
// longer sees the GPU (RDP, a VM, a failed nvidia-smi). Last, a first-time
// offer. Cards below the CUDA build's kernel floor (e.g. Maxwell) crash at the
// first kernel launch, so they are never offered the CUDA pack and get the
// Vulkan pack like AMD/Intel GPUs.
export function pickWhisperGpuBackend(
  cuda: CudaWhisperStatus | null | undefined,
  vulkan: VulkanWhisperStatus | null | undefined
): WhisperGpuBackend | null {
  const cudaEligible = !!cuda?.gpuInfo.hasNvidiaGpu && !!cuda.gpuInfo.cudaSupported;
  const cudaBelowFloor = !!cuda?.gpuInfo.hasNvidiaGpu && !cuda.gpuInfo.cudaSupported;
  const vulkanAvailable = !!vulkan?.vulkan.available;
  if (cudaEligible && cuda?.downloaded) return "cuda";
  if (vulkanAvailable && vulkan?.downloaded) return "vulkan";
  if (cuda?.needsUpdate && !cudaBelowFloor) return "cuda";
  if (vulkan?.needsUpdate) return "vulkan";
  if (cudaEligible) return "cuda";
  if (vulkanAvailable) return "vulkan";
  return null;
}
