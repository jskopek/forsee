import Foundation

/// Sessions live in Documents/sessions/<id>/. The folder is also visible in
/// the Files app and in Finder, as a second way to copy data off the phone.
///
/// Used from the HTTP server queue only.
final class SessionStore {
    let root: URL

    init() {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        root = documents.appendingPathComponent("sessions", isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    /// Reduces arbitrary text to a safe file name part.
    static func slug(_ text: String) -> String {
        let allowed = Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")
        var result = ""
        for character in text {
            result.append(allowed.contains(character) ? character : "-")
        }
        while result.contains("--") {
            result = result.replacingOccurrences(of: "--", with: "-")
        }
        result = result.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        return String(result.prefix(60))
    }

    func createSession(label: String, meta: [String: Any]) throws -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        var id = formatter.string(from: Date())
        let labelSlug = Self.slug(label)
        if !labelSlug.isEmpty {
            id += "-" + labelSlug
        }
        let directory = root.appendingPathComponent(id, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        if JSONSerialization.isValidJSONObject(meta) {
            let data = try JSONSerialization.data(
                withJSONObject: meta, options: [.prettyPrinted, .sortedKeys]
            )
            try data.write(to: directory.appendingPathComponent("meta.json"))
        }
        return id
    }

    /// The session folder, or nil if the id is unsafe or unknown.
    func directory(for id: String) -> URL? {
        guard !id.isEmpty, Self.slug(id) == id else { return nil }
        let directory = root.appendingPathComponent(id, isDirectory: true)
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: directory.path, isDirectory: &isDirectory),
              isDirectory.boolValue
        else { return nil }
        return directory
    }

    /// A segment name that does not collide with files already in the session.
    func uniqueSegmentName(in directory: URL, base: String) -> String {
        let cleaned = Self.slug(base).isEmpty ? "segment" : Self.slug(base)
        var name = cleaned
        var counter = 2
        while FileManager.default.fileExists(
            atPath: directory.appendingPathComponent("\(name).mov").path
        ) {
            name = "\(cleaned)-\(counter)"
            counter += 1
        }
        return name
    }

    /// Appends events to events.jsonl, one JSON object per line. Each event
    /// gets `t_recv`, the phone clock when the batch arrived.
    func appendEvents(sessionId: String, events: [[String: Any]], receivedAt: Double) throws {
        guard let directory = directory(for: sessionId) else {
            throw NSError(
                domain: "EyeCapture", code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Unknown session \(sessionId)"]
            )
        }
        var output = Data()
        for event in events {
            var stamped = event
            stamped["t_recv"] = receivedAt
            guard JSONSerialization.isValidJSONObject(stamped),
                  let line = try? JSONSerialization.data(withJSONObject: stamped, options: [.sortedKeys])
            else { continue }
            output.append(line)
            output.append(0x0A)
        }
        let url = directory.appendingPathComponent("events.jsonl")
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: nil)
        }
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.seekToEnd()
        try handle.write(contentsOf: output)
    }

    /// All sessions, newest first, with their files and sizes.
    func list() -> [[String: Any]] {
        let fileManager = FileManager.default
        let names = (try? fileManager.contentsOfDirectory(atPath: root.path)) ?? []
        var sessions: [[String: Any]] = []
        for name in names.sorted(by: >) {
            guard let directory = directory(for: name) else { continue }
            let fileNames = (try? fileManager.contentsOfDirectory(atPath: directory.path)) ?? []
            var files: [[String: Any]] = []
            var total = 0
            for fileName in fileNames.sorted() {
                let path = directory.appendingPathComponent(fileName).path
                let attributes = try? fileManager.attributesOfItem(atPath: path)
                let size = (attributes?[.size] as? NSNumber)?.intValue ?? 0
                files.append(["name": fileName, "bytes": size])
                total += size
            }
            sessions.append(["id": name, "files": files, "bytes": total])
        }
        return sessions
    }

    /// A file inside a session, or nil if the path is unsafe or missing.
    func fileURL(sessionId: String, name: String) -> URL? {
        guard let directory = directory(for: sessionId),
              !name.isEmpty, !name.contains("/"), !name.hasPrefix(".")
        else { return nil }
        let url = directory.appendingPathComponent(name)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    func delete(sessionId: String) throws {
        guard let directory = directory(for: sessionId) else { return }
        try FileManager.default.removeItem(at: directory)
    }

    static func contentType(for name: String) -> String {
        switch (name as NSString).pathExtension.lowercased() {
        case "mov": return "video/quicktime"
        case "csv": return "text/csv"
        case "json", "jsonl": return "application/json"
        default: return "application/octet-stream"
        }
    }
}
