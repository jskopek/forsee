import Foundation

/// A named rectangle in normalised sensor coordinates (0...1 from the
/// top-left of the delivered buffer).
struct StreamROI {
    var name: String
    var x: Double
    var y: Double
    var w: Double
    var h: Double

    var json: [String: Any] {
        ["name": name, "x": x, "y": y, "w": w, "h": h]
    }
}

struct StreamConfigError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// What `/stream` carries. See `sidecars/phone-gaze/docs/PROTOCOL.md`,
/// `POST /api/stream/config`.
struct StreamConfig {
    static let maxRois = 4

    var maxFps = 30.0
    var wideEnabled = true
    var wideWidth = 640
    var wideQuality = 0.6
    var wideEvery = 1
    var rois: [StreamROI] = []
    var roiQuality = 0.9
    var roiSource = "mac"
    var roiWidth = 0.12
    var roiHeight = 0.07
    var arkit = true
    var depth = false

    var json: [String: Any] {
        [
            "maxFps": maxFps,
            "wide": [
                "enabled": wideEnabled,
                "width": wideWidth,
                "quality": wideQuality,
                "every": wideEvery,
            ] as [String: Any],
            "rois": rois.map { $0.json },
            "roiQuality": roiQuality,
            "roiSource": roiSource,
            "roiSize": ["w": roiWidth, "h": roiHeight],
            "arkit": arkit,
            "depth": depth,
        ]
    }

    /// A copy with the fields in `body` applied. Omitted fields keep their
    /// values. Throws, changing nothing, if any field is invalid.
    func merged(with body: [String: Any], roiSources: [String]) throws -> StreamConfig {
        var next = self
        let known: Set<String> = [
            "maxFps", "wide", "rois", "roiQuality", "roiSource", "roiSize", "arkit", "depth",
        ]
        for key in body.keys where !known.contains(key) {
            throw StreamConfigError(message: "Unknown stream setting \(key)")
        }

        if let value = try Self.number(body["maxFps"], "maxFps", 1, 240) {
            next.maxFps = value
        }
        if let wide = body["wide"] {
            guard let wide = wide as? [String: Any] else {
                throw StreamConfigError(message: "wide must be an object")
            }
            for key in wide.keys where !["enabled", "width", "quality", "every"].contains(key) {
                throw StreamConfigError(message: "Unknown stream setting wide.\(key)")
            }
            if let value = try Self.bool(wide["enabled"], "wide.enabled") {
                next.wideEnabled = value
            }
            if let value = try Self.integer(wide["width"], "wide.width", 16, 7680) {
                next.wideWidth = value
            }
            if let value = try Self.number(wide["quality"], "wide.quality", 0, 1) {
                next.wideQuality = value
            }
            if let value = try Self.integer(wide["every"], "wide.every", 1, 1000) {
                next.wideEvery = value
            }
        }
        if let rois = body["rois"] {
            guard let list = rois as? [Any] else {
                throw StreamConfigError(message: "rois must be an array")
            }
            guard list.count <= Self.maxRois else {
                throw StreamConfigError(message: "At most \(Self.maxRois) rois")
            }
            var parsed: [StreamROI] = []
            var names = Set<String>()
            for item in list {
                guard let roi = item as? [String: Any] else {
                    throw StreamConfigError(message: "Each roi must be an object")
                }
                guard let name = roi["name"] as? String, Self.isValidName(name) else {
                    throw StreamConfigError(message: "Each roi needs a name of 1 to 32 letters, digits or _")
                }
                guard !names.contains(name) else {
                    throw StreamConfigError(message: "Duplicate roi name \(name)")
                }
                names.insert(name)
                guard let x = try Self.number(roi["x"], "\(name).x", 0, 1),
                      let y = try Self.number(roi["y"], "\(name).y", 0, 1),
                      let w = try Self.number(roi["w"], "\(name).w", 0, 1),
                      let h = try Self.number(roi["h"], "\(name).h", 0, 1),
                      w > 0, h > 0
                else {
                    throw StreamConfigError(message: "roi \(name) needs x, y, w and h, with w and h above 0")
                }
                parsed.append(StreamROI(name: name, x: x, y: y, w: w, h: h))
            }
            next.rois = parsed
        }
        if let value = try Self.number(body["roiQuality"], "roiQuality", 0, 1) {
            next.roiQuality = value
        }
        if let source = body["roiSource"] {
            guard let source = source as? String else {
                throw StreamConfigError(message: "roiSource must be a string")
            }
            guard roiSources.contains(source) else {
                throw StreamConfigError(
                    message: "roiSource \(source) is not supported here; use one of \(roiSources.joined(separator: ", "))"
                )
            }
            next.roiSource = source
        }
        if let size = body["roiSize"] {
            guard let size = size as? [String: Any] else {
                throw StreamConfigError(message: "roiSize must be an object")
            }
            if let value = try Self.number(size["w"], "roiSize.w", 0.001, 1) {
                next.roiWidth = value
            }
            if let value = try Self.number(size["h"], "roiSize.h", 0.001, 1) {
                next.roiHeight = value
            }
        }
        if let value = try Self.bool(body["arkit"], "arkit") {
            next.arkit = value
        }
        if let value = try Self.bool(body["depth"], "depth") {
            next.depth = value
        }
        return next
    }

    // MARK: - Parsing helpers

    private static func isValidName(_ name: String) -> Bool {
        guard (1...32).contains(name.count) else { return false }
        return name.unicodeScalars.allSatisfy { scalar in
            (scalar >= "a" && scalar <= "z") || (scalar >= "A" && scalar <= "Z")
                || (scalar >= "0" && scalar <= "9") || scalar == "_"
        }
    }

    private static func isBoolean(_ number: NSNumber) -> Bool {
        CFGetTypeID(number) == CFBooleanGetTypeID()
    }

    /// Nil when absent; throws when present but not a number in range.
    private static func number(_ value: Any?, _ name: String, _ low: Double, _ high: Double) throws -> Double? {
        guard let value = value else { return nil }
        guard let number = value as? NSNumber, !isBoolean(number) else {
            throw StreamConfigError(message: "\(name) must be a number")
        }
        let double = number.doubleValue
        guard double.isFinite, double >= low, double <= high else {
            throw StreamConfigError(message: "\(name) must be between \(low) and \(high)")
        }
        return double
    }

    private static func integer(_ value: Any?, _ name: String, _ low: Int, _ high: Int) throws -> Int? {
        guard let double = try number(value, name, Double(low), Double(high)) else { return nil }
        guard double == double.rounded() else {
            throw StreamConfigError(message: "\(name) must be a whole number")
        }
        return Int(double)
    }

    private static func bool(_ value: Any?, _ name: String) throws -> Bool? {
        guard let value = value else { return nil }
        guard let number = value as? NSNumber, isBoolean(number) else {
            throw StreamConfigError(message: "\(name) must be true or false")
        }
        return number.boolValue
    }
}
