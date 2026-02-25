import CoreAudio
import Foundation

var systemObject = AudioObjectID(kAudioObjectSystemObject)
var address = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDefaultInputDevice,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
)
var deviceID = AudioDeviceID()
var size = UInt32(MemoryLayout<AudioDeviceID>.size)

let status = AudioObjectGetPropertyData(systemObject, &address, 0, nil, &size, &deviceID)
guard status == noErr else { print("false"); exit(0) }

var isRunning: UInt32 = 0
var runningAddress = AudioObjectPropertyAddress(
    mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
    mScope: kAudioObjectPropertyScopeInput,
    mElement: kAudioObjectPropertyElementMain
)
var runningSize = UInt32(MemoryLayout<UInt32>.size)

let runStatus = AudioObjectGetPropertyData(deviceID, &runningAddress, 0, nil, &runningSize, &isRunning)
guard runStatus == noErr else { print("false"); exit(0) }

print(isRunning > 0 ? "true" : "false")
