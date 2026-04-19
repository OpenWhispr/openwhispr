import Foundation

// MediaRemote.framework command constants
let kMRPlay: UInt32 = 0
let kMRPause: UInt32 = 1
let kMRTogglePlayPause: UInt32 = 2

// C function type aliases from MediaRemote.framework
typealias MRMediaRemoteSendCommandType = @convention(c) (UInt32, Optional<AnyObject>) -> Bool
typealias MRMediaRemoteGetNowPlayingApplicationIsPlayingType = @convention(c) (DispatchQueue, @escaping (Bool) -> Void) -> Void

func loadMediaRemote() -> (send: MRMediaRemoteSendCommandType, isPlaying: MRMediaRemoteGetNowPlayingApplicationIsPlayingType)? {
    let frameworkPath = "/System/Library/PrivateFrameworks/MediaRemote.framework/MediaRemote"
    guard let handle = dlopen(frameworkPath, RTLD_NOW) else { return nil }

    guard let sendPtr = dlsym(handle, "MRMediaRemoteSendCommand"),
          let isPlayingPtr = dlsym(handle, "MRMediaRemoteGetNowPlayingApplicationIsPlaying") else {
        return nil
    }

    let send = unsafeBitCast(sendPtr, to: MRMediaRemoteSendCommandType.self)
    let isPlaying = unsafeBitCast(isPlayingPtr, to: MRMediaRemoteGetNowPlayingApplicationIsPlayingType.self)
    return (send: send, isPlaying: isPlaying)
}

func checkIsPlaying(_ isPlayingFn: MRMediaRemoteGetNowPlayingApplicationIsPlayingType) -> Bool {
    let semaphore = DispatchSemaphore(value: 0)
    var playing = false
    isPlayingFn(DispatchQueue.main) { result in
        playing = result
        semaphore.signal()
    }
    _ = semaphore.wait(timeout: .now() + 2)
    return playing
}

guard let mr = loadMediaRemote() else {
    print("ERROR")
    exit(1)
}

let args = CommandLine.arguments
let command = args.count > 1 ? args[1] : ""

switch command {
case "--is-playing":
    let playing = checkIsPlaying(mr.isPlaying)
    print(playing ? "PLAYING" : "NOT_PLAYING")
    exit(playing ? 0 : 1)

case "--pause":
    let playing = checkIsPlaying(mr.isPlaying)
    if !playing {
        print("NOT_PLAYING")
        exit(1)
    }
    let ok = mr.send(kMRPause, nil)
    print(ok ? "OK" : "FAIL")
    exit(ok ? 0 : 1)

case "--play":
    let ok = mr.send(kMRPlay, nil)
    print(ok ? "OK" : "FAIL")
    exit(ok ? 0 : 1)

default:
    print("Usage: macos-media-remote --is-playing|--pause|--play")
    exit(1)
}
