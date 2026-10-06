// whisper-server stderr, rebuilt line by line from the pinned OpenWhispr/whisper.cpp
// tag (src/whisper.cpp, ggml/src/ggml-vulkan, ggml/src/ggml-cuda, ggml-backend.cpp,
// examples/server/server.cpp) and the logs on #1340 and #1606.

// #1340: RX 9070 XT on the AMD proprietary driver (Windows). The Vulkan backend
// prints its device banner when whisper-server registers it, then createDevice
// throws inside model load; whisper.cpp logs the exception and the server exits
// 3. The cause sits far past the first 200 characters.
const VULKAN_DEVICE_LOST_STDERR = [
  "ggml_vulkan: Found 1 Vulkan devices:",
  "ggml_vulkan: 0 = AMD Radeon RX 9070 XT (AMD proprietary driver) | uma: 0 | fp16: 1 | bf16: 1 | warp size: 64 | shared memory: 32768 | int dot: 1 | matrix cores: KHR_coopmat",
  "whisper_init_from_file_with_params_no_state: loading model from 'C:\\Users\\Mika\\.cache\\openwhispr\\whisper-models\\ggml-large-v3-turbo.bin'",
  "whisper_init_with_params_no_state: use gpu    = 1",
  "whisper_init_with_params_no_state: flash attn = 1",
  "whisper_init_with_params_no_state: gpu_device = 0",
  "whisper_model_load: loading model",
  "whisper_model_load: n_vocab       = 51866",
  "whisper_model_load: n_audio_ctx   = 1500",
  "whisper_model_load: n_audio_state = 1280",
  "whisper_model_load: n_mels        = 128",
  "whisper_model_load: type          = 5 (large v3)",
  "whisper_model_load: adding 1609 extra tokens",
  "whisper_model_load: n_langs       = 100",
  "whisper_init_with_params_no_state: exception during model load: vk::PhysicalDevice::createDevice: ErrorDeviceLost",
  "whisper_init_with_params_no_state: failed to load model",
  "error: failed to initialize whisper context",
  "",
].join("\r\n");

// A CUDA pack on a card below its kernel floor (the Maxwell case the model
// picker steers to Vulkan): the server starts, then aborts at the first
// kernel launch, mid-transcription.
const CUDA_KERNEL_IMAGE_STDERR = [
  "ggml_cuda_init: found 1 CUDA devices (Total VRAM: 4096 MiB):",
  "  Device 0: NVIDIA GeForce GTX 970, compute capability 5.2, VMM: yes, VRAM: 4096 MiB",
  "whisper_init_from_file_with_params_no_state: loading model from '/home/ana/.cache/openwhispr/whisper-models/ggml-base.bin'",
  "whisper_backend_init_gpu: using CUDA0 backend",
  "whisper_model_load:        CUDA0 total size =   147.37 MB",
  "CUDA error: no kernel image is available for execution on the device",
  "  current device: 0, in function ggml_cuda_compute_forward at /home/runner/work/whisper.cpp/whisper.cpp/ggml/src/ggml-cuda/ggml-cuda.cu:2503",
  "  err",
  "/home/runner/work/whisper.cpp/whisper.cpp/ggml/src/ggml-cuda/ggml-cuda.cu:88: CUDA error",
  "",
].join("\n");

// A model larger than free VRAM: the weight buffer allocation fails and the
// load then aborts on the unallocated tensor.
const CUDA_OUT_OF_MEMORY_STDERR = [
  "ggml_cuda_init: found 1 CUDA devices (Total VRAM: 2048 MiB):",
  "  Device 0: NVIDIA GeForce GTX 1050, compute capability 6.1, VMM: yes, VRAM: 2048 MiB",
  "whisper_init_from_file_with_params_no_state: loading model from 'C:\\Users\\Ana\\.cache\\openwhispr\\whisper-models\\ggml-large-v3-turbo.bin'",
  "whisper_backend_init_gpu: using CUDA0 backend",
  "ggml_backend_cuda_buffer_type_alloc_buffer: allocating 1533.14 MiB on device 0: cudaMalloc failed: out of memory",
  "alloc_tensor_range: failed to allocate CUDA0 buffer of size 1607598080",
  'D:\\a\\whisper.cpp\\whisper.cpp\\ggml\\src\\ggml-backend.cpp:327: GGML_ASSERT(buf != NULL && "tensor buffer not set") failed',
  "",
].join("\r\n");

module.exports = {
  VULKAN_DEVICE_LOST_STDERR,
  CUDA_KERNEL_IMAGE_STDERR,
  CUDA_OUT_OF_MEMORY_STDERR,
};
