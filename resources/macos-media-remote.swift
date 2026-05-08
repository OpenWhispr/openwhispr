import CoreFoundation
import Foundation

let kMRPlay: UInt32 = 0
let kMRPause: UInt32 = 1

typealias MRSendCommand = @convention(c) (UInt32, Optional<AnyObject>) -> Bool
typealias MRRegister = @convention(c) (DispatchQueue) -> Void
typealias MRGetIsPlaying = @convention(c) (DispatchQueue, @escaping (Bool) -> Void) -> Void
typealias MRGetInfo = @convention(c) (DispatchQueue, @escaping ([AnyHashable: Any]?) -> Void) -> Void

struct MediaRemote {
    let send: MRSendCommand
    let register: MRRegister?
    let isPlaying: MRGetIsPlaying
    let nowPlayingInfo: MRGetInfo
}

func loadMediaRemote() -> MediaRemote? {
    let frameworkPath = "/System/Library/PrivateFrameworks/MediaRemote.framework/MediaRemote"
    guard let handle = dlopen(frameworkPath, RTLD_NOW) else { return nil }

    guard let sendPtr = dlsym(handle, "MRMediaRemoteSendCommand"),
          let isPlayingPtr = dlsym(handle, "MRMediaRemoteGetNowPlayingApplicationIsPlaying"),
          let infoPtr = dlsym(handle, "MRMediaRemoteGetNowPlayingInfo") else {
        return nil
    }

    let registerPtr = dlsym(handle, "MRMediaRemoteRegisterForNowPlayingNotifications")
    let register = registerPtr.flatMap { unsafeBitCast($0, to: MRRegister.self) }

    return MediaRemote(
        send: unsafeBitCast(sendPtr, to: MRSendCommand.self),
        register: register,
        isPlaying: unsafeBitCast(isPlayingPtr, to: MRGetIsPlaying.self),
        nowPlayingInfo: unsafeBitCast(infoPtr, to: MRGetInfo.self)
    )
}

// macOS 15.4+ regression: legacy MediaRemote callbacks return empty even when
// a session is active. Fall back to MRNowPlayingController via runtime lookup.
func controllerApplicationIsPlaying() -> Bool? {
    guard let cls = NSClassFromString("MRNowPlayingController") as? NSObject.Type else {
        return nil
    }
    let sharedSel = NSSelectorFromString("sharedNowPlayingController")
    guard cls.responds(to: sharedSel),
          let shared = cls.perform(sharedSel)?.takeUnretainedValue() as? NSObject else {
        return nil
    }
    let playingSel = NSSelectorFromString("applicationIsPlaying")
    guard shared.responds(to: playingSel),
          let value = shared.perform(playingSel)?.takeUnretainedValue() as? NSNumber else {
        return nil
    }
    return value.boolValue
}

func emit(_ message: String, exitCode: Int32) -> Never {
    print(message)
    exit(exitCode)
}

guard let mr = loadMediaRemote() else {
    emit("ERROR", exitCode: 1)
}

let args = CommandLine.arguments
let command = args.count > 1 ? args[1] : ""

// Required on macOS 13+ for the now-playing daemon to wire up before any
// subsequent get-callbacks fire. Harmless on older systems where it's absent.
mr.register?(DispatchQueue.main)

switch command {
case "--play":
    let ok = mr.send(kMRPlay, nil)
    emit(ok ? "OK" : "FAIL", exitCode: ok ? 0 : 1)
case "--is-playing", "--pause":
    break
default:
    emit("Usage: macos-media-remote --is-playing|--pause|--play", exitCode: 1)
}

DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
    emit("NOT_PLAYING", exitCode: 1)
}

func resolveIsPlaying(_ done: @escaping (Bool) -> Void) {
    mr.nowPlayingInfo(DispatchQueue.main) { info in
        if !(info?.isEmpty ?? true) {
            mr.isPlaying(DispatchQueue.main) { done($0) }
            return
        }
        done(controllerApplicationIsPlaying() ?? false)
    }
}

DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
    resolveIsPlaying { playing in
        switch command {
        case "--is-playing":
            emit(playing ? "PLAYING" : "NOT_PLAYING", exitCode: playing ? 0 : 1)
        case "--pause":
            if !playing { emit("NOT_PLAYING", exitCode: 1) }
            let ok = mr.send(kMRPause, nil)
            emit(ok ? "OK" : "FAIL", exitCode: ok ? 0 : 1)
        default:
            emit("Usage: macos-media-remote --is-playing|--pause|--play", exitCode: 1)
        }
    }
}

CFRunLoopRun()
