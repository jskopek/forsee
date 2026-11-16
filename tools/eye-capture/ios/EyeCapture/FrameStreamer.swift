import CoreGraphics
import CoreImage
import CoreVideo
import Foundation
import ImageIO
import QuartzCore

/// Everything about one captured frame that the stream needs. Built on the
/// frame queue only when the frame will be sent.
struct StreamFrameInput {
    let pixelBuffer: CVPixelBuffer
    /// Capture time, phone clock (seconds since boot).
    let t: Double
    let mode: String
    let camera: [String: Any]
    let lens: [String: Any]
    let gravity: [Double]?
    let rotationRate: [Double]?
    /// The `arkit` header block, when in ARKit mode and asked for.
    let arkit: [String: Any]?
    /// ARKit's eye centres in sensor pixels, for `roiSource` = `"arkit"`.
    let eyePixels: (left: CGPoint, right: CGPoint)?
    let depth: DepthSample?
}

/// The live stream (`GET /stream`): one client at a time, PGZ1 framing, and
/// frames dropped rather than queued when the client is slow. The wire format
/// is specified in `sidecars/phone-gaze/docs/PROTOCOL.md`.
///
/// Threading: `begin` and `submit` are called on the capture frame queue and
/// do almost nothing there. JPEG encoding happens on `encodeQueue`, one frame
/// at a time; a frame that arrives while the previous one is still being
/// encoded or written is dropped. Shared state sits behind `lock`.
final class FrameStreamer {
    struct Ticket {
        let seq: Int
        let dropped: Int
        let config: StreamConfig
        let sendWide: Bool
        let writer: StreamWriter
        let thermalCapFps: Double?
    }

    /// The `state` object of `/api/status`. Set once by the owner.
    var stateProvider: (() -> [String: Any])?

    private let lock = NSLock()
    private let encodeQueue = DispatchQueue(label: "eyecapture.stream.encode", qos: .userInitiated)
    private let statusQueue = DispatchQueue(label: "eyecapture.stream.status")
    private let ciContext = CIContext(options: [.cacheIntermediates: false])
    private let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
    private var statusTimer: DispatchSourceTimer?

    // Guarded by `lock`.
    private var writer: StreamWriter?
    private var config = StreamConfig()
    private var roiSources = ["mac"]
    private var encoding = false
    private var seq = -1
    private var lastAcceptedT = -Double.infinity
    private var acceptedCount = 0
    private var droppedSinceSent = 0
    private var sentTotal = 0
    private var droppedTotal = 0
    private var skippedTotal = 0
    private var bytesTotal = 0
    private var clientsTotal = 0
    private var lastFrameBytes = 0
    private var windowStart = CACurrentMediaTime()
    private var windowSent = 0
    private var windowBytes = 0
    private var sentFps = 0.0
    private var sentMbps = 0.0
    private var lastError = ""

    // Encode queue only.
    private let vision = VisionEyeLocator()
    private var lastDepthT = -Double.infinity

    init() {
        let timer = DispatchSource.makeTimerSource(queue: statusQueue)
        timer.schedule(deadline: .now() + 1, repeating: 1)
        timer.setEventHandler { [weak self] in
            self?.sendStatus()
        }
        timer.resume()
        statusTimer = timer
    }

    deinit {
        statusTimer?.cancel()
    }

    // MARK: - Clients and configuration

    /// Which `roiSource` values this phone supports. Set by the owner.
    func setSupportedRoiSources(_ sources: [String]) {
        lock.lock()
        roiSources = sources
        lock.unlock()
    }

    var configJSON: [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        return config.json
    }

    /// Applies a partial configuration. Returns the full effective one.
    func updateConfig(_ body: [String: Any]) throws -> [String: Any] {
        lock.lock()
        let next: StreamConfig
        do {
            next = try config.merged(with: body, roiSources: roiSources)
        } catch {
            lock.unlock()
            throw error
        }
        config = next
        lock.unlock()
        statusQueue.async { [weak self] in self?.sendStatus() }
        return next.json
    }

    /// Makes `writer` the stream client, closing any previous one, and sends
    /// `hello` first.
    func attach(_ writer: StreamWriter, hello: [String: Any]) {
        lock.lock()
        let previous = self.writer
        self.writer = writer
        clientsTotal += 1
        droppedSinceSent = 0
        lastAcceptedT = -Double.infinity
        acceptedCount = 0
        lock.unlock()
        previous?.close()

        let id = ObjectIdentifier(writer)
        writer.onClose { [weak self] in
            guard let self = self else { return }
            self.lock.lock()
            if let current = self.writer, ObjectIdentifier(current) == id {
                self.writer = nil
            }
            self.lock.unlock()
        }
        if let message = Self.message(header: hello, parts: []) {
            writer.sendReliable(message)
        } else {
            writer.close()
        }
    }

    /// Counts for `state.stream` and the phone's screen.
    func stats() -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        var json: [String: Any] = [
            "clients": writer == nil ? 0 : 1,
            "sent": sentTotal,
            "dropped": droppedTotal,
            "skipped": skippedTotal,
            "bytes": bytesTotal,
            "fps": sentFps,
            "mbps": sentMbps,
            "lastFrameBytes": lastFrameBytes,
            "connections": clientsTotal,
        ]
        if !lastError.isEmpty { json["lastError"] = lastError }
        return json
    }

    /// One line for the phone's own screen.
    func summaryLine() -> String {
        lock.lock()
        defer { lock.unlock() }
        guard writer != nil else {
            return sentTotal == 0 ? "Stream: no client" : "Stream: no client (\(sentTotal) frames sent before)"
        }
        return String(
            format: "Stream: 1 client, %.0f fps, %.1f Mbit/s, %d dropped", sentFps, sentMbps, droppedTotal
        )
    }

    // MARK: - Frames (frame queue)

    /// Called for every captured frame. Returns a ticket when this frame
    /// should be sent; then the caller builds the input and calls `submit`.
    /// Cheap when nobody is connected.
    func begin(t: Double) -> Ticket? {
        let thermal = ProcessInfo.processInfo.thermalState
        let thermalCap: Double? = thermal == .critical ? 15 : (thermal == .serious ? 30 : nil)

        lock.lock()
        defer { lock.unlock() }
        seq += 1
        guard let writer = writer else { return nil }

        var maxFps = config.maxFps
        if let cap = thermalCap { maxFps = min(maxFps, cap) }
        // A little slack so a 60 fps camera with maxFps 30 sends every other frame.
        if t - lastAcceptedT < 0.9 / maxFps, t >= lastAcceptedT {
            skippedTotal += 1
            return nil
        }
        if encoding || writer.isBusy {
            droppedSinceSent += 1
            droppedTotal += 1
            return nil
        }
        encoding = true
        lastAcceptedT = t
        var sendWide = config.wideEnabled && acceptedCount % config.wideEvery == 0
        if thermal == .critical { sendWide = false }
        acceptedCount += 1
        let ticket = Ticket(
            seq: seq, dropped: droppedSinceSent, config: config, sendWide: sendWide,
            writer: writer, thermalCapFps: thermalCap
        )
        return ticket
    }

    /// Gives back a ticket whose frame will not be submitted after all.
    func abandon(_ ticket: Ticket) {
        lock.lock()
        encoding = false
        lock.unlock()
    }

    /// Encodes and sends the frame on the encode queue.
    func submit(_ ticket: Ticket, input: StreamFrameInput) {
        encodeQueue.async { [weak self] in
            guard let self = self else { return }
            let message = self.encode(ticket, input: input)
            var accepted = false
            if let message = message {
                accepted = ticket.writer.sendDroppable(message)
            }
            let now = CACurrentMediaTime()
            self.lock.lock()
            self.encoding = false
            if accepted, let message = message {
                self.sentTotal += 1
                self.bytesTotal += message.count
                self.lastFrameBytes = message.count
                self.windowSent += 1
                self.windowBytes += message.count
                self.droppedSinceSent = 0
            } else {
                self.droppedSinceSent += 1
                self.droppedTotal += 1
                if message == nil { self.lastError = "A frame could not be encoded" }
            }
            if now - self.windowStart >= 1 {
                let span = now - self.windowStart
                self.sentFps = Double(self.windowSent) / span
                self.sentMbps = Double(self.windowBytes) * 8 / span / 1_000_000
                self.windowStart = now
                self.windowSent = 0
                self.windowBytes = 0
            }
            self.lock.unlock()
        }
    }

    // MARK: - Encoding (encode queue)

    private func encode(_ ticket: Ticket, input: StreamFrameInput) -> Data? {
        let config = ticket.config
        let image = CIImage(cvPixelBuffer: input.pixelBuffer)
        let width = CVPixelBufferGetWidth(input.pixelBuffer)
        let height = CVPixelBufferGetHeight(input.pixelBuffer)
        guard width > 0, height > 0 else { return nil }

        var descriptors: [[String: Any]] = []
        var payloads: [Data] = []

        if ticket.sendWide {
            let targetWidth = min(config.wideWidth, width)
            let targetHeight = max(1, Int((Double(height) * Double(targetWidth) / Double(width)).rounded()))
            let scaleY = Double(targetHeight) / Double(height)
            let scaleX = Double(targetWidth) / Double(width)
            let scaled: CIImage
            if targetWidth == width {
                scaled = image
            } else {
                scaled = image.clampedToExtent()
                    .applyingFilter(
                        "CILanczosScaleTransform",
                        parameters: [
                            kCIInputScaleKey: scaleY,
                            kCIInputAspectRatioKey: scaleX / scaleY,
                        ]
                    )
                    .cropped(to: CGRect(x: 0, y: 0, width: targetWidth, height: targetHeight))
            }
            if let data = jpeg(scaled, quality: config.wideQuality) {
                descriptors.append([
                    "name": "wide", "kind": "wide", "format": "jpeg", "bytes": data.count,
                    "width": targetWidth, "height": targetHeight, "rect": [0, 0, width, height],
                ])
                payloads.append(data)
            }
        }

        // Where the eye rectangles come from.
        var rois: [StreamROI] = []
        switch config.roiSource {
        case "arkit":
            if let eyes = input.eyePixels {
                rois = [
                    Self.centred("left_eye", eyes.left.x / CGFloat(width), eyes.left.y / CGFloat(height), config),
                    Self.centred("right_eye", eyes.right.x / CGFloat(width), eyes.right.y / CGFloat(height), config),
                ]
            }
        case "vision":
            if let eyes = vision.locate(input.pixelBuffer, t: input.t) {
                rois = [
                    Self.centred("left_eye", eyes.left.x, eyes.left.y, config),
                    Self.centred("right_eye", eyes.right.x, eyes.right.y, config),
                ]
            }
        default:
            rois = config.rois
        }

        var cutRects: [String: CGRect] = [:]
        for roi in rois {
            guard let rect = Self.sensorRect(roi, width: width, height: height) else { continue }
            // Core Image puts the origin at the bottom-left.
            let ciRect = CGRect(
                x: rect.minX, y: CGFloat(height) - rect.maxY, width: rect.width, height: rect.height
            )
            let cropped = image
                .cropped(to: ciRect)
                .transformed(by: CGAffineTransform(translationX: -ciRect.minX, y: -ciRect.minY))
            guard let data = jpeg(cropped, quality: config.roiQuality) else { continue }
            descriptors.append([
                "name": roi.name, "kind": "roi", "format": "jpeg", "bytes": data.count,
                "width": Int(rect.width), "height": Int(rect.height),
                "rect": [Int(rect.minX), Int(rect.minY), Int(rect.width), Int(rect.height)],
            ])
            payloads.append(data)
            cutRects[roi.name] = rect
        }

        var header: [String: Any] = [
            "type": "frame",
            "seq": ticket.seq,
            "t": input.t,
            "mode": input.mode,
            "dropped": ticket.dropped,
            "camera": input.camera,
            "lens": input.lens,
            "roiSource": config.roiSource,
        ]
        if let gravity = input.gravity { header["gravity"] = gravity }
        if let rotation = input.rotationRate { header["rotationRate"] = rotation }
        if let arkit = input.arkit, config.arkit { header["arkit"] = arkit }
        if let cap = ticket.thermalCapFps { header["thermalCapFps"] = cap }

        if config.depth, let depth = input.depth, let map = DepthMap.metres(depth.data) {
            var block: [String: Any] = [
                "source": depth.source,
                "t": depth.t,
                "width": CVPixelBufferGetWidth(map),
                "height": CVPixelBufferGetHeight(map),
            ]
            var atRois: [String: Any] = [:]
            for (name, rect) in cutRects {
                let x = Double(rect.midX) / Double(width)
                let y = Double(rect.midY) / Double(height)
                atRois[name] = DepthMap.median(map, x: x, y: y) ?? NSNull()
            }
            block["atRois"] = atRois
            // Send the map itself only when it is new (TrueDepth runs slower
            // than the video).
            if depth.t != lastDepthT, let packed = DepthMap.packed(map) {
                lastDepthT = depth.t
                block["part"] = "depth"
                descriptors.append([
                    "name": "depth", "kind": "depth", "format": "depth32", "bytes": packed.data.count,
                    "width": packed.width, "height": packed.height, "rect": [0, 0, width, height],
                ])
                payloads.append(packed.data)
            }
            header["depth"] = block
        }

        if !descriptors.isEmpty { header["parts"] = descriptors }
        header["tSent"] = CACurrentMediaTime()
        return Self.message(header: header, parts: payloads)
    }

    private func jpeg(_ image: CIImage, quality: Double) -> Data? {
        ciContext.jpegRepresentation(
            of: image,
            colorSpace: colorSpace,
            options: [
                CIImageRepresentationOption(
                    rawValue: kCGImageDestinationLossyCompressionQuality as String
                ): quality,
            ]
        )
    }

    // MARK: - Status (status queue)

    private func sendStatus() {
        lock.lock()
        let writer = self.writer
        lock.unlock()
        guard let writer = writer else { return }
        let state = stateProvider?() ?? [:]
        let header: [String: Any] = [
            "type": "status",
            "t": CACurrentMediaTime(),
            "state": state,
            "stream": stats(),
        ]
        if let message = Self.message(header: header, parts: []) {
            writer.sendReliable(message)
        }
    }

    // MARK: - Helpers

    /// A rectangle of `roiSize` centred on a normalised point.
    private static func centred(_ name: String, _ x: CGFloat, _ y: CGFloat, _ config: StreamConfig) -> StreamROI {
        StreamROI(
            name: name,
            x: Double(x) - config.roiWidth / 2,
            y: Double(y) - config.roiHeight / 2,
            w: config.roiWidth,
            h: config.roiHeight
        )
    }

    /// The ROI in sensor pixels, clamped to the frame and rounded outwards to
    /// even integers. Nil if nothing of it is inside the frame.
    static func sensorRect(_ roi: StreamROI, width: Int, height: Int) -> CGRect? {
        guard roi.x.isFinite, roi.y.isFinite, roi.w.isFinite, roi.h.isFinite else { return nil }
        func floorEven(_ value: Double) -> Int { Int((value / 2).rounded(.down)) * 2 }
        func ceilEven(_ value: Double) -> Int { Int((value / 2).rounded(.up)) * 2 }
        let evenWidth = width - width % 2
        let evenHeight = height - height % 2
        let x0 = min(max(floorEven(roi.x * Double(width)), 0), evenWidth)
        let y0 = min(max(floorEven(roi.y * Double(height)), 0), evenHeight)
        let x1 = min(max(ceilEven((roi.x + roi.w) * Double(width)), 0), evenWidth)
        let y1 = min(max(ceilEven((roi.y + roi.h) * Double(height)), 0), evenHeight)
        guard x1 - x0 >= 2, y1 - y0 >= 2 else { return nil }
        return CGRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0)
    }

    /// One PGZ1 message: magic, header length (big-endian), JSON header, parts.
    static func message(header: [String: Any], parts: [Data]) -> Data? {
        let clean = JSONSafe.clean(header)
        guard JSONSerialization.isValidJSONObject(clean),
              let json = try? JSONSerialization.data(withJSONObject: clean, options: [])
        else { return nil }
        var length = UInt32(json.count).bigEndian
        var data = Data("PGZ1".utf8)
        data.reserveCapacity(8 + json.count + parts.reduce(0) { $0 + $1.count })
        withUnsafeBytes(of: &length) { data.append(contentsOf: $0) }
        data.append(json)
        for part in parts {
            data.append(part)
        }
        return data
    }
}

/// JSON never carries NaN or infinity: such numbers become null.
enum JSONSafe {
    static func clean(_ value: Any) -> Any {
        if let dictionary = value as? [String: Any] {
            var result: [String: Any] = [:]
            for (key, item) in dictionary {
                result[key] = clean(item)
            }
            return result
        }
        if let array = value as? [Any] {
            return array.map { clean($0) }
        }
        if let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() {
            return number.doubleValue.isFinite ? number : NSNull()
        }
        if let double = value as? Double {
            return double.isFinite ? double : NSNull()
        }
        if let float = value as? Float {
            return float.isFinite ? float : NSNull()
        }
        return value
    }
}
