import CoreFoundation
import Foundation

let kMRPlay: UInt32 = 0
let kMRPause: UInt32 = 1
let usage = "Usage: macos-media-remote --is-playing|--pause|--play"
let playbackRateKey = "kMRMediaRemoteNowPlayingInfoPlaybackRate"

typealias MRSendCommand = @convention(c) (UInt32, Optional<AnyObject>) -> Bool
typealias MRRegister = @convention(c) (DispatchQueue) -> Void
// The get-callback is an Objective-C block, not a C function pointer;
// @convention(c) here would silently misroute the callback.
typealias MRGetInfo = @convention(c) (
    DispatchQueue, @escaping @convention(block) ([AnyHashable: Any]?) -> Void
) -> Void

struct MediaRemote {
    let send: MRSendCommand
    let register: MRRegister?
    let getInfo: MRGetInfo
}

func loadMediaRemote() -> MediaRemote? {
    let url = URL(fileURLWithPath: "/System/Library/PrivateFrameworks/MediaRemote.framework")
    guard let bundle = CFBundleCreate(kCFAllocatorDefault, url as CFURL),
          let sendPtr = CFBundleGetFunctionPointerForName(bundle, "MRMediaRemoteSendCommand" as CFString),
          let infoPtr = CFBundleGetFunctionPointerForName(bundle, "MRMediaRemoteGetNowPlayingInfo" as CFString) else {
        return nil
    }
    let regPtr = CFBundleGetFunctionPointerForName(
        bundle, "MRMediaRemoteRegisterForNowPlayingNotifications" as CFString)
    return MediaRemote(
        send: unsafeBitCast(sendPtr, to: MRSendCommand.self),
        register: regPtr.map { unsafeBitCast($0, to: MRRegister.self) },
        getInfo: unsafeBitCast(infoPtr, to: MRGetInfo.self)
    )
}

func emit(_ message: String, exitCode: Int32) -> Never {
    print(message)
    exit(exitCode)
}

let args = CommandLine.arguments
let command = args.count > 1 ? args[1] : ""

switch command {
case "--play", "--is-playing", "--pause":
    break
default:
    emit(usage, exitCode: 1)
}

// macOS 15.4 closed the now-playing daemon to unprivileged Mach-O processes;
// both reads and sends silently no-op. Emit UNKNOWN so the consumer falls
// back to its media-key path.
let v = ProcessInfo.processInfo.operatingSystemVersion
if v.majorVersion > 15 || (v.majorVersion == 15 && v.minorVersion >= 4) {
    emit("UNKNOWN", exitCode: 1)
}

guard let mr = loadMediaRemote() else {
    emit("ERROR", exitCode: 1)
}

// macOS 13+ requires this before any subsequent get-callback fires.
mr.register?(DispatchQueue.main)

if command == "--play" {
    let ok = mr.send(kMRPlay, nil)
    emit(ok ? "OK" : "FAIL", exitCode: ok ? 0 : 1)
}

DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
    emit("NOT_PLAYING", exitCode: 1)
}

DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
    mr.getInfo(DispatchQueue.main) { info in
        guard let info = info, !info.isEmpty else {
            emit("NOT_PLAYING", exitCode: 1)
        }
        let rate = (info[playbackRateKey] as? NSNumber)?.doubleValue ?? 0
        let playing = rate > 0
        switch command {
        case "--is-playing":
            emit(playing ? "PLAYING" : "NOT_PLAYING", exitCode: playing ? 0 : 1)
        case "--pause":
            if !playing { emit("NOT_PLAYING", exitCode: 1) }
            let ok = mr.send(kMRPause, nil)
            emit(ok ? "OK" : "FAIL", exitCode: ok ? 0 : 1)
        default:
            emit(usage, exitCode: 1)
        }
    }
}

CFRunLoopRun()
