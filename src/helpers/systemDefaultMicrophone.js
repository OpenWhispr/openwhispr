const { execFile } = require("child_process");
const { resolveBundledBinary } = require("./binaryResolver");
const debugLogger = require("./debugLogger");

const COMMAND_TIMEOUT_MS = 3000;
// Windows resolves through a short-lived PowerShell process, so keep successful
// lookups warm. Renderer devicechange recovery explicitly bypasses this cache.
const CACHE_TTL_MS = 30000;

const WINDOWS_DEFAULT_INPUT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Runtime.InteropServices;

public static class OpenWhisprDefaultInput {
  enum EDataFlow { eRender, eCapture, eAll }
  enum ERole { eConsole, eMultimedia, eCommunications }

  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  class MMDeviceEnumeratorComObject { }

  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
  interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(EDataFlow dataFlow, uint stateMask, out IntPtr devices);
    int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice endpoint);
    int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
    int RegisterEndpointNotificationCallback(IntPtr client);
    int UnregisterEndpointNotificationCallback(IntPtr client);
  }

  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("D666063F-1587-4E43-81F1-B948E807363F")]
  interface IMMDevice {
    int Activate(ref Guid iid, uint context, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
    int OpenPropertyStore(uint access, out IPropertyStore properties);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetState(out uint state);
  }

  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
  interface IPropertyStore {
    int GetCount(out uint count);
    int GetAt(uint index, out PropertyKey key);
    int GetValue(ref PropertyKey key, out PropVariant value);
    int SetValue(ref PropertyKey key, ref PropVariant value);
    int Commit();
  }

  [StructLayout(LayoutKind.Sequential)]
  struct PropertyKey {
    public Guid formatId;
    public uint propertyId;
  }

  [StructLayout(LayoutKind.Explicit)]
  struct PropVariant {
    [FieldOffset(0)] public ushort valueType;
    [FieldOffset(8)] public IntPtr pointerValue;
  }

  [DllImport("ole32.dll")]
  static extern int PropVariantClear(ref PropVariant value);

  public static string GetJson() {
    var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
    IMMDevice device;
    Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(EDataFlow.eCapture, ERole.eConsole, out device));

    string id;
    Marshal.ThrowExceptionForHR(device.GetId(out id));
    IPropertyStore properties;
    Marshal.ThrowExceptionForHR(device.OpenPropertyStore(0, out properties));

    var key = new PropertyKey {
      formatId = new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"),
      propertyId = 14
    };
    PropVariant value;
    Marshal.ThrowExceptionForHR(properties.GetValue(ref key, out value));
    string name = value.pointerValue == IntPtr.Zero ? "" : Marshal.PtrToStringUni(value.pointerValue);
    PropVariantClear(ref value);

    return "{\"name\":\"" + Escape(name) + "\",\"id\":\"" + Escape(id) + "\"}";
  }

  static string Escape(string value) {
    if (String.IsNullOrEmpty(value)) return "";
    return value.Replace("\\", "\\\\").Replace("\"", "\\\"");
  }
}
'@
Add-Type -TypeDefinition $source
[OpenWhisprDefaultInput]::GetJson()
`;

function runFile(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        timeout: COMMAND_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 256 * 1024,
        ...options,
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve(stdout.trim());
      }
    );
  });
}

function parseJsonResult(output) {
  const line = String(output || "")
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .filter(Boolean)
    .at(-1);
  if (!line) return null;
  const result = JSON.parse(line);
  if (!result || typeof result.name !== "string" || !result.name.trim()) return null;
  return {
    name: result.name.trim(),
    nativeId: typeof result.id === "string" && result.id ? result.id : undefined,
  };
}

function parseWpctlResult(output) {
  const description = String(output || "").match(
    /^\s*(?:node\.description|device\.description)\s*=\s*"([^"]+)"/m
  )?.[1];
  const name = String(output || "").match(/^\s*node\.name\s*=\s*"([^"]+)"/m)?.[1];
  const label = description || name;
  return label ? { name: label, nativeId: name || undefined } : null;
}

function parsePactlSources(output, defaultSourceName) {
  let sources;
  try {
    sources = JSON.parse(output);
  } catch {
    return null;
  }
  if (!Array.isArray(sources)) return null;
  const source = sources.find((candidate) => candidate?.name === defaultSourceName);
  if (!source) return null;
  const label = source.description || source.properties?.["device.description"] || source.name;
  return label ? { name: label, nativeId: source.name } : null;
}

function createSystemDefaultMicrophoneResolver({
  platform = process.platform,
  run = runFile,
  resolveBinary = resolveBundledBinary,
  now = Date.now,
} = {}) {
  let cache = null;
  let cachedAt = 0;

  const resolveDarwin = async () => {
    const helper = resolveBinary("macos-mic-listener", "audio");
    if (!helper) return null;
    return parseJsonResult(await run(helper, ["--print-default-input"]));
  };

  const resolveWindows = async () => {
    const shell = process.env.SystemRoot
      ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
      : "powershell.exe";
    return parseJsonResult(
      await run(shell, [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        WINDOWS_DEFAULT_INPUT_SCRIPT,
      ])
    );
  };

  const resolveLinux = async () => {
    try {
      const output = await run("wpctl", ["inspect", "@DEFAULT_AUDIO_SOURCE@"]);
      const result = parseWpctlResult(output);
      if (result) return result;
    } catch {
      // PulseAudio remains common on distributions without WirePlumber.
    }

    const defaultSourceName = (await run("pactl", ["get-default-source"])).trim();
    if (!defaultSourceName) return null;
    const sources = await run("pactl", ["--format=json", "list", "sources"]);
    return parsePactlSources(sources, defaultSourceName);
  };

  return async ({ refresh = false } = {}) => {
    if (!refresh && cache && now() - cachedAt < CACHE_TTL_MS) return cache;

    try {
      let result = null;
      if (platform === "darwin") result = await resolveDarwin();
      else if (platform === "win32") result = await resolveWindows();
      else if (platform === "linux") result = await resolveLinux();

      cache = result
        ? { ...result, platform, source: "system" }
        : { name: "", platform, source: "unavailable" };
      cachedAt = now();
      return cache;
    } catch (error) {
      debugLogger.debug(
        "Failed to resolve the system default microphone",
        { platform, error: error.message },
        "audio"
      );
      cache = { name: "", platform, source: "unavailable" };
      cachedAt = now();
      return cache;
    }
  };
}

module.exports = {
  createSystemDefaultMicrophoneResolver,
  parseJsonResult,
  parsePactlSources,
  parseWpctlResult,
  resolveSystemDefaultMicrophone: createSystemDefaultMicrophoneResolver(),
};
