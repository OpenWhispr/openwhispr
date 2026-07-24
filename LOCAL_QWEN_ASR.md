# OpenWhispr + 本地 Qwen3-ASR（MLX）

这份 fork 为 Apple Silicon 增加了一个本地 ASR sidecar。OpenWhispr 继续负责录音、快捷键、自动粘贴与模型润色，本地服务负责把录音交给 `Qwen/Qwen3-ASR-0.6B`。

## 架构

```text
麦克风 → OpenWhispr → http://127.0.0.1:8765/audio/transcriptions
                    → mlx-qwen3-asr / Metal GPU → {"text":"..."}
                    → OpenWhispr cleanup（可选）→ 自动粘贴
```

服务只监听回环地址、不要求 API Key，模型加载后常驻内存。PyAV 在进程内把 WebM/Opus 解码为 16 kHz 单声道波形，不依赖系统 ffmpeg。请求中的自定义词典会作为 Qwen3-ASR 的 `context` 传入。

## 首次安装

```bash
npm ci
npm run prepare:local-asr
npm run asr:setup
npm run asr:download
```

默认模型是 `Qwen/Qwen3-ASR-0.6B`。模型权重只在首次下载时联网，之后可离线运行。

## 启动

```bash
npm run dev:local-asr
```

该命令同时启动本地模型服务与 OpenWhispr，并在 development 配置中自动选择：

- Transcription mode: `Self-Hosted`
- Server URL: `http://127.0.0.1:8765`
- Model: `Qwen/Qwen3-ASR-0.6B`
- Account: 本地模式自动跳过登录，不启动云同步

普通的 `npm run dev` 不会启用此预设。

`prepare:local-asr` 负责一次性编译和下载 OpenWhispr 自身的运行资源。完成后，日常使用只需运行 `npm run dev:local-asr`，不会重复执行准备流程。

首次启动时，macOS 会要求授予麦克风和辅助功能权限。麦克风用于录音，辅助功能用于全局快捷键和把识别结果粘贴到当前应用；这两项权限需要在“系统设置 → 隐私与安全性”中手动确认。

## 单独启动与检查

```bash
npm run asr:start
curl http://127.0.0.1:8765/health
```

返回的 `status` 为 `ready` 表示模型已经加载完成。

## 本机实测

测试设备为 Mac mini M4 / 16 GB，输入是一段 8.76 秒的普通话音频：

- 模型冷启动约 1–2.5 秒（权重已下载）。
- 热请求约 2.7 秒，实时率约 0.31，即约 3.2 倍实时速度。
- 除项目英文名 `OpenWhispr` 被识别成近音词外，中文测试句完整正确。

实际端到端延迟还会受到停顿检测、录音时长和 cleanup 模型速度影响。

## 可选配置

环境变量：

- `QWEN_ASR_MODEL`：Hugging Face 模型 ID 或本地模型目录。
- `QWEN_ASR_PORT`：服务端口，默认 `8765`。
- `QWEN_ASR_LAZY_LOAD=1`：首次请求时才加载模型。
- `QWEN_ASR_MAX_BODY_BYTES`：单次上传大小上限，默认 25 MiB。

如果要启用本地模型润色，在 OpenWhispr 的 Intelligence / Cleanup 中选择本地推理模型；ASR 与润色是两个独立步骤，可以分别替换和调优。

当前 ASR 路径使用 PyAV，不依赖仓库附带的 `ffmpeg-static`。该上游二进制在当前 macOS 版本上会被系统以退出码 137 终止，因此上游测试套件中的音频分段合并用例仍有 1 项失败；这不会影响此处的 Qwen3-ASR 自托管转写路径。
