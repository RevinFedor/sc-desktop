import Foundation
import AppKit
import ApplicationServices

// Persistent AX references are essential: a fresh AppleScript index or global
// Return can silently select a different dialog after the original disappears.
struct NativeDialog {
    let id: String
    let browser: String
    let pid: pid_t
    let windowId: Int
    let window: AXUIElement
    let container: AXUIElement
    let positive: AXUIElement
    let negative: AXUIElement?
    let input: AXUIElement?
    let type: String
    let fullText: String
    let text: String
    let header: String
}
var records: [String: NativeDialog] = [:]
var claimed = Set<String>()
var inspection: [[String: Any]] = []
let bundles = ["yandex": "ru.yandex.desktop.yandex-browser", "chrome": "com.google.Chrome",
               "edge": "com.microsoft.edgemac", "brave": "com.brave.Browser"]

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}
func string(_ element: AXUIElement, _ name: String) -> String { attribute(element, name) as? String ?? "" }
func children(_ element: AXUIElement) -> [AXUIElement] { attribute(element, "AXChildren") as? [AXUIElement] ?? [] }
func equal(_ a: AXUIElement, _ b: AXUIElement) -> Bool { CFEqual(a, b) }
func bounds(_ element: AXUIElement) -> CGRect? {
    guard let pos = attribute(element, "AXPosition"), let size = attribute(element, "AXSize") else { return nil }
    var p = CGPoint.zero, s = CGSize.zero
    guard CFGetTypeID(pos) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID(),
          AXValueGetValue(pos as! AXValue, .cgPoint, &p), AXValueGetValue(size as! AXValue, .cgSize, &s) else { return nil }
    return CGRect(origin: p, size: s)
}
func nativeWindowId(_ element: AXUIElement, _ pid: pid_t) -> Int? {
    guard let rect = bounds(element),
          let windows = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] else { return nil }
    let matches = windows.filter { w in
        guard (w[kCGWindowOwnerPID as String] as? Int) == Int(pid),
              (w[kCGWindowLayer as String] as? Int) == 0,
              let raw = w[kCGWindowBounds as String] as? NSDictionary,
              let r = CGRect(dictionaryRepresentation: raw) else { return false }
        return abs(r.minX - rect.minX) < 1 && abs(r.minY - rect.minY) < 1 &&
               abs(r.width - rect.width) < 1 && abs(r.height - rect.height) < 1
    }
    // Window indices and guessed ownership from origin/tab titles are forbidden.
    return matches.count == 1 ? matches[0][kCGWindowNumber as String] as? Int : nil
}
func windowExists(_ id: Int, _ pid: pid_t) -> Bool {
    let windows = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? []
    return windows.contains { ($0[kCGWindowNumber as String] as? Int) == id &&
                             ($0[kCGWindowOwnerPID as String] as? Int) == Int(pid) }
}
func nodes(_ root: AXUIElement) -> [AXUIElement] {
    var result: [AXUIElement] = []
    func walk(_ e: AXUIElement, _ depth: Int) {
        if depth > 28 || result.count >= 160 { return }
        // Do not scrape webpages, tab strip text, cookies or unrelated documents.
        if string(e, "AXRole") == "AXWebArea" { return }
        result.append(e)
        for c in children(e) { walk(c, depth + 1) }
    }
    walk(root, 0)
    return result
}
func label(_ e: AXUIElement) -> String {
    for name in ["AXDescription", "AXTitle", "AXValue"] {
        let value = string(e, name).trimmingCharacters(in: .whitespacesAndNewlines)
        if !value.isEmpty { return value }
    }
    return ""
}
func describesJSDialog(_ text: String) -> Bool {
    let first = (text.components(separatedBy: .newlines).first?.lowercased() ?? "")
        .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
    // Native Yandex/Chromium JS dialog headings, not arbitrary OS warnings or
    // menus. Unknown layouts/localizations are not actionable automatically.
    return first.contains("на сайте") || first.contains("от сайта") || first.contains("со страницы") ||
           first.contains("со страницы") || first.contains("сайт ") ||
           first.hasSuffix(" says") || first.hasSuffix(" says:")
}
func inspect(_ browser: String, _ pid: pid_t) -> [NativeDialog] {
    inspection = []
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.4)
    var roots = attribute(app, "AXWindows") as? [AXUIElement] ?? []
    roots += children(app)
    if let focused = attribute(app, "AXFocusedWindow"), CFGetTypeID(focused) == AXUIElementGetTypeID() {
        roots.append(focused as! AXUIElement)
    }
    var unique: [AXUIElement] = []
    for e in roots where !unique.contains(where: { equal($0, e) }) { unique.append(e) }
    var result: [NativeDialog] = []
    for window in unique {
        let metadata: [String: Any] = ["role": string(window, "AXRole"), "subrole": string(window, "AXSubrole"),
            "nativeWindowId": nativeWindowId(window, pid) ?? -1]
        inspection.append(metadata)
        guard string(window, "AXRole") == "AXWindow",
              ["AXUnknown", "AXDialog", "AXSystemDialog"].contains(string(window, "AXSubrole")),
              let wid = nativeWindowId(window, pid) else { continue }
        let all = nodes(window)
        let containers = all.filter { describesJSDialog(string($0, "AXTitle")) }
        inspection[inspection.count - 1]["nodeCount"] = all.count
        inspection[inspection.count - 1]["recognizedTextNodes"] = containers.count
        inspection[inspection.count - 1]["buttonLabels"] = all.filter { string($0, "AXRole") == "AXButton" }.map(label)
        if containers.isEmpty {
            inspection[inspection.count - 1]["unrecognizedTitles"] = Array(Set(all.map { string($0, "AXTitle") }.filter { !$0.isEmpty })).prefix(6).map { String($0.prefix(10000)) }
        }
        // Prefer the smallest native subtree containing both the text and
        // controls, rather than a parent which duplicates its descendants.
        for container in containers.reversed() {
            // Yandex puts the affirmative button INSIDE the text group and
            // the cancel button beside it. Containment within the text label
            // alone misclassifies a real confirm as an alert.
            let inside = all
            let buttons = inside.filter { string($0, "AXRole") == "AXButton" }
            let positiveNames = ["Да", "OK", "ОК", "Ок", "Yes", "Confirm", "Закрыть", "Close", "Продолжить", "Continue"]
            let negativeNames = ["Нет", "Отмена", "No", "Cancel"]
            let positives = buttons.filter { positiveNames.contains(label($0)) }
            let negatives = buttons.filter { negativeNames.contains(label($0)) }
            guard positives.count == 1, negatives.count <= 1,
                  buttons.count == positives.count + negatives.count else { continue }
            let inputs = inside.filter { ["AXTextField", "AXTextArea"].contains(string($0, "AXRole")) }
            guard inputs.count <= 1, inputs.isEmpty || negatives.count == 1 else { continue }
            let full = string(container, "AXTitle")
            let lines = full.components(separatedBy: .newlines)
            let kind = inputs.isEmpty ? (negatives.isEmpty ? "alert" : "confirm") : "prompt"
            let previous = records.values.first { $0.pid == pid && $0.windowId == wid &&
                equal($0.window, window) && equal($0.container, container) && $0.fullText == full }
            result.append(NativeDialog(id: previous?.id ?? "ax:" + UUID().uuidString, browser: browser,
                pid: pid, windowId: wid, window: window, container: container,
                positive: positives[0], negative: negatives.first, input: inputs.first,
                type: kind, fullText: full, text: lines.dropFirst().joined(separator: "\n"),
                header: lines.first ?? ""))
            break
        }
    }
    return result
}
func serialized(_ d: NativeDialog) -> [String: Any] {
    return ["dialogId": d.id, "browser": d.browser, "browserPid": Int(d.pid),
            "nativeWindowId": d.windowId, "tabId": NSNull(), "type": d.type,
            "text": d.text, "fullText": d.fullText, "header": d.header,
            "defaultPrompt": d.input.map { string($0, "AXValue") } ?? "",
            "source": "macOS Accessibility", "targetBinding": "native_window_not_inferred_tab"]
}
func failure(_ code: String, _ message: String) -> [String: Any] {
    return ["success": false, "errorCode": code, "error": message]
}
func waitValue(_ input: AXUIElement, _ text: String, _ seconds: TimeInterval) -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    while string(input, "AXValue") != text && Date() < deadline {
        RunLoop.current.run(until: Date().addingTimeInterval(0.03))
    }
    return string(input, "AXValue") == text
}
func writePrompt(_ d: NativeDialog, _ input: AXUIElement, _ text: String) -> Bool {
    _ = AXUIElementSetAttributeValue(input, "AXValue" as CFString, text as CFString)
    if waitValue(input, text, 0.25) { return true }
    // Yandex reports writable AXValue and returns success without changing the
    // text. Try its selected-text API, still addressed to the exact AX element.
    guard AXUIElementSetAttributeValue(input, "AXFocused" as CFString, kCFBooleanTrue) == .success else { return false }
    var range = CFRange(location: 0, length: string(input, "AXValue").utf16.count)
    if let value = AXValueCreate(.cfRange, &range) {
        _ = AXUIElementSetAttributeValue(input, "AXSelectedTextRange" as CFString, value)
        _ = AXUIElementSetAttributeValue(input, "AXSelectedText" as CFString, text as CFString)
    }
    if waitValue(input, text, 0.25) { return true }
    // Only a known native prompt field in the SAME process may receive input.
    // No global event tap, Return, Tab, mouse coordinates or clipboard paste.
    let app = AXUIElementCreateApplication(d.pid)
    func isFocused() -> Bool {
        guard (attribute(app, "AXFrontmost") as? Bool) == true,
              let focused = attribute(app, "AXFocusedUIElement"), CFGetTypeID(focused) == AXUIElementGetTypeID() else { return false }
        return equal(focused as! AXUIElement, input) && windowExists(d.windowId, d.pid) &&
               string(d.container, "AXTitle") == d.fullText
    }
    guard CGPreflightPostEventAccess(), isFocused(), let source = CGEventSource(stateID: .privateState) else { return false }
    func key(_ code: CGKeyCode, _ flags: CGEventFlags = []) {
        for down in [true, false] {
            guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else { continue }
            event.flags = flags; event.postToPid(d.pid)
        }
    }
    key(0, .maskCommand) // Cmd+A inside the proven field, not a global Enter.
    RunLoop.current.run(until: Date().addingTimeInterval(0.04))
    guard isFocused() else { return false }
    if text.isEmpty { key(51) } // Delete selection in the native prompt only.
    else {
        var remaining = text[...]
        while !remaining.isEmpty {
            guard isFocused() else { return false }
            let piece = String(remaining.prefix(32)); remaining = remaining.dropFirst(piece.count)
            let units = Array(piece.utf16)
            for down in [true, false] {
                guard let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down) else { return false }
                event.flags = []
                units.withUnsafeBufferPointer { buffer in
                    event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: buffer.baseAddress!)
                }
                event.postToPid(d.pid)
            }
        }
    }
    return waitValue(input, text, 1) && isFocused()
}
func run(_ args: [String: Any]) -> [String: Any] {
    guard AXIsProcessTrusted() else { return failure("NATIVE_AX_PERMISSION", "Enable Accessibility for the executor running Browser MCP (Noted Terminal)") }
    let action = args["action"] as? String ?? "read"
    if action == "read" {
        guard let browser = args["browser"] as? String, let bundle = bundles[browser] else {
            return failure("NATIVE_BROWSER_REQUIRED", "Explicit browser family required")
        }
        let running = NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier == bundle }
        guard running.count == 1 else { return failure("NATIVE_BROWSER_AMBIGUOUS", "Browser process is absent or ambiguous") }
        let app = running[0]
        if args["activate"] as? Bool == true {
            guard app.activate(options: []) else { return failure("NATIVE_ACTIVATION_FAILED", "Browser activation was not accepted") }
            let deadline = Date().addingTimeInterval(2)
            let ax = AXUIElementCreateApplication(app.processIdentifier)
            while (attribute(ax, "AXFrontmost") as? Bool) != true && Date() < deadline {
                RunLoop.current.run(until: Date().addingTimeInterval(0.04))
            }
        }
        let all = inspect(browser, app.processIdentifier)
        let selected = all.filter { args["nativeWindowId"] == nil || ($0.windowId == args["nativeWindowId"] as? Int) }
        for d in all { records[d.id] = d }
        // Remove only this browser's stale records. Never guess a new modal
        // from the old window index or reactivate it during a handle call.
        for (id, d) in records where d.browser == browser && !all.contains(where: { $0.id == id }) { records.removeValue(forKey: id) }
        claimed = claimed.intersection(Set(records.keys))
        return ["success": true, "status": selected.isEmpty ? "none_visible" : "open",
                "dialogs": selected.map(serialized), "browserPid": Int(app.processIdentifier),
                "inspection": inspection,
                "frontmost": app.isActive, "coverage": "visible_native_JS_dialogs", "revision": "2026-10-05-native-AX"]
    }
    guard action == "handle", let id = args["dialogId"] as? String,
          let wid = args["nativeWindowId"] as? Int, let accept = args["accept"] as? Bool,
          let d = records[id], d.windowId == wid else {
        return failure("DIALOG_STALE", "Dialog/window identity is not a current native record; no input sent")
    }
    if let text = args["promptText"], (!(text is String) || d.type != "prompt" || !accept) {
        return failure("DIALOG_ARGUMENTS", "promptText only applies to accepting a prompt")
    }
    if claimed.contains(id) { return failure("DIALOG_BUSY", "This native response has an unresolved outcome; no repeated input") }
    let fresh = inspect(d.browser, d.pid).first { $0.id == id }
    guard let current = fresh, equal(current.container, d.container), current.fullText == d.fullText,
          windowExists(wid, d.pid) else { records.removeValue(forKey: id); return failure("DIALOG_STALE", "Native dialog changed; no input sent") }
    guard let button = accept ? Optional(d.positive) : (d.negative ?? (d.type == "alert" ? d.positive : nil)) else {
        return failure("DIALOG_ACTION_UNSUPPORTED", "No native button for requested action")
    }
    if let input = d.input, accept, let text = args["promptText"] as? String {
        guard writePrompt(d, input, text) else { return failure("NATIVE_PROMPT_WRITE_FAILED", "Prompt value not confirmed; dialog not accepted. Native input needs Accessibility/post-event access and the original focused field.") }
    }
    let promptValue = d.input.map { string($0, "AXValue") }
    claimed.insert(id)
    guard (attribute(button, "AXEnabled") as? Bool) != false,
          AXUIElementPerformAction(button, kAXPressAction as CFString) == .success else {
        return ["success": false, "errorCode": "DIALOG_OUTCOME_UNKNOWN", "error": "Native button press outcome not confirmed", "retrySafe": false]
    }
    let deadline = Date().addingTimeInterval(3)
    while Date() < deadline {
        var value: CFTypeRef?
        let code = AXUIElementCopyAttributeValue(d.container, "AXRole" as CFString, &value)
        if code == .invalidUIElement || (!windowExists(wid, d.pid) && code != .success) {
            records.removeValue(forKey: id)
            claimed.remove(id)
            return ["success": true, "status": "closed", "dialog": serialized(d),
                    "accepted": accept, "userInput": accept ? (promptValue ?? "") : NSNull(),
                    "verifiedBy": "native_AX_element_invalidated", "retrySafe": false]
        }
        RunLoop.current.run(until: Date().addingTimeInterval(0.04))
    }
    return ["success": false, "errorCode": "DIALOG_OUTCOME_UNKNOWN", "error": "Native close was not confirmed",
            "dialogId": id, "retrySafe": false]
}

while let line = readLine() {
    do {
        guard let data = line.data(using: .utf8), let args = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
        var response = run(args)
        response["requestId"] = args["requestId"]
        let output = try JSONSerialization.data(withJSONObject: response, options: [.sortedKeys])
        FileHandle.standardOutput.write(output + Data([10]))
    } catch {
        let output = try! JSONSerialization.data(withJSONObject: failure("NATIVE_HELPER_ERROR", String(describing: error)))
        FileHandle.standardOutput.write(output + Data([10]))
    }
}
