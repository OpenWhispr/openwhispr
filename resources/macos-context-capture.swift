import Cocoa
import Foundation
import Darwin

let codeExtensions = Set([
    "swift", "ts", "tsx", "js", "jsx", "py", "rb", "rs", "go", "java", "kt",
    "c", "cpp", "h", "hpp", "cs", "m", "mm", "php", "vue", "svelte", "html",
    "css", "scss", "less", "json", "yaml", "yml", "toml", "xml", "sql", "sh",
    "zsh", "bash", "fish", "lua", "zig", "ex", "exs", "erl", "hs", "ml",
    "scala", "r", "jl", "dart", "tf", "proto", "graphql", "md", "mdx",
    "dockerfile", "makefile", "cmake", "gradle", "plist", "xcconfig"
])

func hasCodeExtension(_ segment: String) -> Bool {
    let trimmed = segment.trimmingCharacters(in: .whitespaces)
    if let dot = trimmed.lastIndex(of: ".") {
        let ext = String(trimmed[trimmed.index(after: dot)...]).lowercased()
        return codeExtensions.contains(ext)
    }
    return false
}

func parseFileName(windowTitle: String, bundleId: String) -> String? {
    let id = bundleId.lowercased()

    // VS Code: "file.ts — project — Visual Studio Code"
    if id.contains("vscode") || id.contains("visual studio code") || id.contains("cursor") || id.contains("windsurf") {
        let parts = windowTitle.components(separatedBy: " — ")
        if let first = parts.first, hasCodeExtension(first) {
            return first.trimmingCharacters(in: .whitespaces)
        }
        return nil
    }

    // Xcode: "Project — file.swift"
    if id.contains("xcode") {
        let parts = windowTitle.components(separatedBy: " — ")
        for part in parts {
            if hasCodeExtension(part) {
                return part.trimmingCharacters(in: .whitespaces)
            }
        }
        return nil
    }

    // JetBrains: "project – file.ts [path]"
    if id.contains("jetbrains") || id.contains("intellij") || id.contains("webstorm")
        || id.contains("pycharm") || id.contains("phpstorm") || id.contains("rubymine")
        || id.contains("goland") || id.contains("rider") || id.contains("clion")
        || id.contains("datagrip") || id.contains("appcode") {
        let parts = windowTitle.components(separatedBy: " – ")
        if parts.count >= 2 {
            var segment = parts[1].trimmingCharacters(in: .whitespaces)
            if let bracketRange = segment.range(of: "\\s*\\[.*\\]$", options: .regularExpression) {
                segment = String(segment[..<bracketRange.lowerBound])
            }
            if hasCodeExtension(segment) {
                return segment.trimmingCharacters(in: .whitespaces)
            }
        }
        return nil
    }

    // Sublime Text: "file.ts - Project"
    if id.contains("sublimetext") || id.contains("sublime") {
        let parts = windowTitle.components(separatedBy: " - ")
        if let first = parts.first, hasCodeExtension(first) {
            return first.trimmingCharacters(in: .whitespaces)
        }
        return nil
    }

    // Vim/Neovim (usually running in a terminal host)
    if id.contains("nvim") || id.contains("neovim") || id.contains("vim")
        || windowTitle.contains("NVIM") || windowTitle.contains("VIM") {
        let parts = windowTitle.components(separatedBy: " - ")
        if let first = parts.first, hasCodeExtension(first) {
            return first.trimmingCharacters(in: .whitespaces)
        }
        return nil
    }

    return nil
}

func jsonEscape(_ str: String) -> String {
    var result = str
    result = result.replacingOccurrences(of: "\\", with: "\\\\")
    result = result.replacingOccurrences(of: "\"", with: "\\\"")
    result = result.replacingOccurrences(of: "\n", with: "\\n")
    result = result.replacingOccurrences(of: "\r", with: "\\r")
    result = result.replacingOccurrences(of: "\t", with: "\\t")
    return result
}

func jsonString(_ value: String?) -> String {
    guard let value = value else { return "null" }
    return "\"\(jsonEscape(value))\""
}

// Gather frontmost application info (no Accessibility needed)
guard let app = NSWorkspace.shared.frontmostApplication else {
    FileHandle.standardError.write("No frontmost application\n".data(using: .utf8)!)
    exit(1)
}

let bundleId = app.bundleIdentifier
let appName = app.localizedName
var windowTitle: String?
var exitCode: Int32 = 0

// Accessibility required for window title
if AXIsProcessTrusted() {
    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    var focusedWindow: AnyObject?
    let windowResult = AXUIElementCopyAttributeValue(axApp, kAXFocusedWindowAttribute as CFString, &focusedWindow)
    if windowResult == .success {
        var titleValue: AnyObject?
        let titleResult = AXUIElementCopyAttributeValue(focusedWindow as! AXUIElement, kAXTitleAttribute as CFString, &titleValue)
        if titleResult == .success, let title = titleValue as? String, !title.isEmpty {
            windowTitle = title
        }
    }
} else {
    exitCode = 2
}

let fileName: String? = {
    guard let title = windowTitle, let bid = bundleId else { return nil }
    return parseFileName(windowTitle: title, bundleId: bid)
}()

let json = "{\"bundleId\":\(jsonString(bundleId)),\"appName\":\(jsonString(appName)),\"windowTitle\":\(jsonString(windowTitle)),\"fileName\":\(jsonString(fileName))}"
FileHandle.standardOutput.write(json.data(using: .utf8)!)
FileHandle.standardOutput.write("\n".data(using: .utf8)!)
exit(exitCode)
