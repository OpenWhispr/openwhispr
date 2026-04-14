const crypto = require("crypto");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const { downloadFile, extractArchive } = require("./download-utils");

const WEBRTC_APM_COMMIT = "08f235eba0c247f8929045adb090d0b0445cf8ea";
const ABSEIL_CPP_COMMIT = "9ac7062b1860d895fb5a8cbf58c3e9ef8f674b5f";

const WEBRTC_APM_URL = `https://chromium.googlesource.com/chromiumos/third_party/webrtc-apm/+archive/${WEBRTC_APM_COMMIT}.tar.gz`;
const ABSEIL_CPP_URL = `https://github.com/abseil/abseil-cpp/archive/${ABSEIL_CPP_COMMIT}.tar.gz`;

const WEBRTC_ROOT_LABELS = [
  "//api/audio:aec3_factory",
  "//api/audio:builtin_audio_processing_builder",
  "//api/environment:environment_factory",
  "//modules/audio_processing",
];

const SKIPPED_WEBRTC_SOURCES = new Set([
  "modules/audio_processing/aec_dump/aec_dump_impl.cc",
  "modules/audio_processing/aec_dump/capture_stream_info.cc",
]);

const EXTRA_WEBRTC_SOURCES = [
  "common_audio/vad/vad_core.c",
  "common_audio/vad/vad_filterbank.c",
  "common_audio/vad/vad_gmm.c",
  "common_audio/vad/vad_sp.c",
  "common_audio/vad/webrtc_vad.c",
  "modules/audio_processing/include/aec_dump.cc",
  "modules/audio_processing/logging/apm_data_dumper.cc",
  "rtc_base/strings/string_builder.cc",
];

const ABSL_SOURCES = [
  "absl/base/internal/cycleclock.cc",
  "absl/base/internal/raw_logging.cc",
  "absl/base/internal/spinlock.cc",
  "absl/base/internal/spinlock_wait.cc",
  "absl/base/internal/sysinfo.cc",
  "absl/base/internal/thread_identity.cc",
  "absl/base/internal/throw_delegate.cc",
  "absl/base/internal/unscaledcycleclock.cc",
  "absl/base/log_severity.cc",
  "absl/numeric/int128.cc",
  "absl/strings/ascii.cc",
  "absl/strings/charconv.cc",
  "absl/strings/escaping.cc",
  "absl/strings/internal/charconv_bigint.cc",
  "absl/strings/internal/charconv_parse.cc",
  "absl/strings/internal/damerau_levenshtein_distance.cc",
  "absl/strings/internal/escaping.cc",
  "absl/strings/internal/memutil.cc",
  "absl/strings/internal/ostringstream.cc",
  "absl/strings/internal/stringify_sink.cc",
  "absl/strings/internal/utf8.cc",
  "absl/strings/match.cc",
  "absl/strings/numbers.cc",
  "absl/strings/str_cat.cc",
  "absl/strings/str_replace.cc",
  "absl/strings/str_split.cc",
  "absl/strings/string_view.cc",
  "absl/strings/substitute.cc",
  "absl/types/bad_optional_access.cc",
];

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function listEntries(dirPath) {
  return fs.readdirSync(dirPath, { withFileTypes: true });
}

function moveChildrenUp(dirPath) {
  const entries = listEntries(dirPath);
  if (entries.length !== 1 || !entries[0].isDirectory()) {
    return;
  }

  const nestedDir = path.join(dirPath, entries[0].name);
  for (const child of listEntries(nestedDir)) {
    fs.renameSync(path.join(nestedDir, child.name), path.join(dirPath, child.name));
  }
  fs.rmSync(nestedDir, { recursive: true, force: true });
}

async function ensureSourceTree({
  url,
  archiveName,
  outputDir,
  flattenSingleRoot = false,
}) {
  if (fs.existsSync(outputDir) && listEntries(outputDir).length > 0) {
    return outputDir;
  }

  ensureDir(outputDir);
  const archivePath = path.join(path.dirname(outputDir), archiveName);

  try {
    await downloadFile(url, archivePath);
    await extractArchive(archivePath, outputDir);
    if (flattenSingleRoot) {
      moveChildrenUp(outputDir);
    }
  } finally {
    if (fs.existsSync(archivePath)) {
      fs.rmSync(archivePath, { force: true });
    }
  }

  return outputDir;
}

async function ensureThirdPartySources(helperRoot) {
  const thirdPartyRoot = path.join(helperRoot, "third_party");
  ensureDir(thirdPartyRoot);

  const webrtcApmRoot = path.join(thirdPartyRoot, `webrtc-apm-${WEBRTC_APM_COMMIT}`);
  const abslRoot = path.join(thirdPartyRoot, `abseil-cpp-${ABSEIL_CPP_COMMIT}`);

  await ensureSourceTree({
    url: WEBRTC_APM_URL,
    archiveName: `webrtc-apm-${WEBRTC_APM_COMMIT}.tar.gz`,
    outputDir: webrtcApmRoot,
  });
  await ensureSourceTree({
    url: ABSEIL_CPP_URL,
    archiveName: `abseil-cpp-${ABSEIL_CPP_COMMIT}.tar.gz`,
    outputDir: abslRoot,
    flattenSingleRoot: true,
  });

  return {
    webrtcApmRoot,
    abslRoot,
  };
}

function normalizeArch(arch) {
  if (arch === "x64") {
    return "x64";
  }
  if (arch === "arm64" || arch === "aarch64") {
    return "arm64";
  }
  return arch;
}

function buildWebrtcSourceList(webrtcApmRoot, targetArch) {
  const pythonScript = `
import json
from pathlib import Path

ROOT = Path(${JSON.stringify(webrtcApmRoot)})
ROOT_LABELS = ${JSON.stringify(WEBRTC_ROOT_LABELS)}
SKIPPED = set(${JSON.stringify([...SKIPPED_WEBRTC_SOURCES])})
TARGET_ARCH = ${JSON.stringify(normalizeArch(targetArch))}

want_arm64 = TARGET_ARCH == "arm64"
want_arm32 = TARGET_ARCH.startswith("arm") and not want_arm64
want_neon = want_arm64 or want_arm32

targets = {}
loaded_packages = set()
current_package = "//"

def select(options):
    for key, value in options.items():
        if (key == "//:aarch64_build" or key == ":aarch64_build") and want_arm64:
            return value
        if (key == "//:aarch32_build" or key == ":aarch32_build") and want_arm32:
            return value
        if (key == "//:neon_build" or key == ":neon_build") and want_neon:
            return value
    return options.get("//conditions:default", [])

def cc_library(**kwargs):
    targets[f"{current_package}:{kwargs['name']}"] = kwargs

def cc_proto_library(**kwargs):
    targets[f"{current_package}:{kwargs['name']}"] = kwargs

def proto_library(**kwargs):
    targets[f"{current_package}:{kwargs['name']}"] = kwargs

def alias(**kwargs):
    targets[f"{current_package}:{kwargs['name']}"] = {"deps": [kwargs["actual"]]}

def cc_test(**kwargs):
    return None

def package(**kwargs):
    return None

def test_suite(**kwargs):
    return None

def config_setting(**kwargs):
    return None

def bool_flag(**kwargs):
    return None

def exports_files(**kwargs):
    return None

ENV = {
    "cc_library": cc_library,
    "cc_proto_library": cc_proto_library,
    "proto_library": proto_library,
    "alias": alias,
    "cc_test": cc_test,
    "package": package,
    "test_suite": test_suite,
    "config_setting": config_setting,
    "bool_flag": bool_flag,
    "exports_files": exports_files,
    "select": select,
    "COPTS": [],
    "AVX2_COPTS": [],
    "NEON_COPTS": [],
    "require_condition": lambda cond: [],
}

def normalize_label(label, package_path):
    if label.startswith("@"):
        return label
    if label.startswith(":"):
        return f"//{package_path}{label}"
    if label.startswith("//"):
        if ":" in label:
            return label
        pkg = label[2:]
        return f"{label}:{pkg.split('/')[-1]}"
    return f"//{package_path}:{label}"

def load_build(package_path):
    global current_package
    if package_path in loaded_packages:
        return
    loaded_packages.add(package_path)
    build_path = ROOT / package_path / "BUILD.bazel" if package_path else ROOT / "BUILD.bazel"
    text = "\\n".join(
        line for line in build_path.read_text().splitlines() if not line.strip().startswith("load(")
    )
    current_package = f"//{package_path}" if package_path else "//"
    exec(text, dict(ENV), {})

def get_target(label):
    if label.startswith("@"):
        return None
    normalized = normalize_label(label, "")
    package_path = normalized[2:].split(":", 1)[0]
    load_build(package_path)
    return targets.get(normalized)

visited = set()
collected = set()

def walk(label, package_path=""):
    normalized = normalize_label(label, package_path)
    if normalized.startswith("@") or normalized in visited:
        return
    visited.add(normalized)
    target = get_target(normalized)
    if not target:
        return
    target_package_path = normalized[2:].split(":", 1)[0]
    for source in target.get("srcs", []):
        if not isinstance(source, str):
            continue
        if source.startswith("@") or source.startswith("//"):
            continue
        if not (source.endswith(".c") or source.endswith(".cc")):
            continue
        relative_path = str(Path(target_package_path) / source).replace("\\\\", "/")
        if relative_path in SKIPPED:
            continue
        if "avx2" in Path(relative_path).name:
            continue
        collected.add(str((ROOT / relative_path).resolve()))
    for dependency in target.get("deps", []):
        if isinstance(dependency, str):
            walk(dependency, target_package_path)

for root_label in ROOT_LABELS:
    walk(root_label)

print(json.dumps(sorted(collected)))
`;

  const output = execFileSync("python3", ["-c", pythonScript], {
    encoding: "utf8",
  });
  return JSON.parse(output);
}

function getPlatformDefines(targetPlatform, targetArch) {
  const defines = [
    "WEBRTC_APM_DEBUG_DUMP=0",
    "WEBRTC_ENABLE_PROTOBUF=0",
    "WEBRTC_INTELLIGIBILITY_ENHANCER=0",
    "WEBRTC_NS_FLOAT=1",
    "RTC_DISABLE_CHECK_MSG",
  ];

  if (targetPlatform === "win32") {
    defines.push("WEBRTC_WIN=1", "NOMINMAX", "WIN32_LEAN_AND_MEAN", "_USE_MATH_DEFINES");
  } else {
    defines.push("WEBRTC_POSIX=1");
    if (targetPlatform === "darwin") {
      defines.push("WEBRTC_MAC=1");
    } else if (targetPlatform === "linux") {
      defines.push("WEBRTC_LINUX=1");
    }
  }

  const normalizedArch = normalizeArch(targetArch);
  if (normalizedArch === "arm64") {
    defines.push("WEBRTC_ARCH_ARM64", "WEBRTC_HAS_NEON");
  } else if (normalizedArch.startsWith("arm")) {
    defines.push("WEBRTC_ARCH_ARM", "WEBRTC_HAS_NEON");
  }

  return defines;
}

function getDarwinArch(targetArch) {
  return normalizeArch(targetArch) === "x64" ? "x86_64" : "arm64";
}

function getArchOptions(targetPlatform, targetArch) {
  if (targetPlatform !== "darwin") {
    return [];
  }

  return ["-arch", getDarwinArch(targetArch)];
}

function getLinkOptions(targetPlatform) {
  if (targetPlatform === "linux") {
    return ["-pthread", "-lm"];
  }

  return [];
}

function quoteCmake(value) {
  return `"${String(value)
    .replace(/\\/g, "/")
    .replace(/(["\\])/g, "\\$1")}"`;
}

function writeCmakeManifest(manifest, outputPath) {
  const lines = [];
  const writeList = (name, values) => {
    lines.push(`set(${name}`);
    for (const value of values) {
      lines.push(`  ${quoteCmake(value)}`);
    }
    lines.push(")");
  };

  writeList("MEETING_AEC_WEBRTC_SOURCES", manifest.webrtcSources);
  writeList("MEETING_AEC_ABSL_SOURCES", manifest.abslSources);
  writeList("MEETING_AEC_INCLUDE_DIRS", manifest.includeDirs);
  writeList("MEETING_AEC_DEFINES", manifest.defines);
  writeList("MEETING_AEC_COMPILE_OPTIONS", manifest.compileOptions);
  writeList("MEETING_AEC_LINK_OPTIONS", manifest.linkOptions);

  fs.writeFileSync(outputPath, `${lines.join("\n")}\n`);
}

function buildManifest({ helperRoot, webrtcApmRoot, abslRoot, targetPlatform, targetArch }) {
  const webrtcSources = [
    ...new Set([
      ...buildWebrtcSourceList(webrtcApmRoot, targetArch),
      ...EXTRA_WEBRTC_SOURCES.map((source) => path.join(webrtcApmRoot, source)),
    ]),
  ];
  const abslSources = ABSL_SOURCES.map((source) => path.join(abslRoot, source));
  const defines = getPlatformDefines(targetPlatform, targetArch);
  const compileOptions = ["-O2", ...getArchOptions(targetPlatform, targetArch)];
  const linkOptions = getLinkOptions(targetPlatform);

  return {
    helperRoot,
    webrtcSources,
    abslSources,
    includeDirs: [helperRoot, webrtcApmRoot, abslRoot],
    defines,
    compileOptions,
    linkOptions,
    cSources: [...webrtcSources, ...abslSources].filter((source) => source.endsWith(".c")),
    cxxSources: [...webrtcSources, ...abslSources].filter((source) => source.endsWith(".cc")),
    allSources: [...webrtcSources, ...abslSources],
  };
}

function computeManifestHash(localFiles, targetPlatform, targetArch) {
  const hash = crypto.createHash("sha256");
  for (const file of localFiles) {
    hash.update(path.basename(file));
    hash.update(fs.readFileSync(file, "utf8"));
  }
  hash.update(targetPlatform);
  hash.update(targetArch);
  hash.update(WEBRTC_APM_COMMIT);
  hash.update(ABSEIL_CPP_COMMIT);
  return hash.digest("hex");
}

module.exports = {
  buildManifest,
  computeManifestHash,
  ensureThirdPartySources,
  writeCmakeManifest,
};
