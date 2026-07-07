import AppKit

let nxKeyTypePlay = 16
let nxKeyDown = 0x0A
let nxKeyUp = 0x0B
let nxSystemDefinedSubtype: Int16 = 8

func postMediaKey(_ key: Int, state: Int) -> Bool {
    let data1 = (key << 16) | (state << 8)
    guard let event = NSEvent.otherEvent(
        with: .systemDefined,
        location: NSPoint(x: 0, y: 0),
        modifierFlags: NSEvent.ModifierFlags(rawValue: 0),
        timestamp: ProcessInfo.processInfo.systemUptime,
        windowNumber: 0,
        context: nil,
        subtype: nxSystemDefinedSubtype,
        data1: data1,
        data2: -1
    ) else {
        return false
    }

    guard let cgEvent = event.cgEvent else {
        return false
    }

    cgEvent.post(tap: .cghidEventTap)
    return true
}

let sentDown = postMediaKey(nxKeyTypePlay, state: nxKeyDown)
usleep(8_000)
let sentUp = postMediaKey(nxKeyTypePlay, state: nxKeyUp)

exit(sentDown && sentUp ? 0 : 1)
