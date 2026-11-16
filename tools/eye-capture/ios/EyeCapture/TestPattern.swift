import CoreGraphics
import CoreVideo
import Foundation
import QuartzCore
import simd

/// A synthetic camera: frames with known geometry, for the iOS Simulator (which has no
/// camera) and for checking the wire format end to end. Selected with `POST /api/configure`
/// `{"cameraId": "test-pattern"}` (camera mode) or `"test-pattern-arkit"` (ARKit mode with a
/// synthetic `arkit` block). Its frames go through the same path as real ones: stream crop,
/// JPEG encoding, PGZ1 framing, back-pressure, recording and previews.
///
/// The picture (sensor orientation, full resolution `W × H`, zoom 1) is a light grey
/// background (luma 180, with fixed fine noise of ±12 so JPEG sizes and encode times are like a
/// camera's; it does not move with zoom) with two flat dark discs (luma 40), each with a small bright spot up and to the right of its
/// centre. In normalised sensor coordinates the disc centres are
///
///     right_eye: (0.40 + dx, 0.46 + dy)    left_eye: (0.60 + dx, 0.54 + dy)
///     dx = 0.04 · cos(2π t / 8)            dy = 0.03 · sin(2π t / 8)
///
/// with `t` the frame's capture time. The disc radius is `0.025 · W`; the spot sits at
/// `(+0.35 r, −0.35 r)` from the centre with radius `0.2 r`. Zoom scales the picture about the
/// image centre: a point `p` (sensor pixels at zoom 1) is drawn at `c + (p − c) · zoom`, `c =
/// (W/2, H/2)`, which is what the reported intrinsics (`fx = fy = (W/2) / tan(30°)`, `cx = W/2`,
/// `cy = H/2`, unzoomed, `intrinsicsIncludeZoom: false`) imply. Every frame also carries the
/// exact positions it drew in a `testPattern` header block, so a receiver needs no formula.
///
/// The disc on the image's right is `left_eye`: that is where the person's own left eye
/// appears in an unmirrored image of a face looking at the camera, as ARKit names it.
enum TestPattern {
    static let cameraId = "test-pattern"
    static let arkitCameraId = "test-pattern-arkit"
    static let fieldOfView = 60.0
    static let maxFps = 60.0
    static let zoomRange: [Double] = [1, 3]
    /// Gravity sent when the device has no motion data (the Simulator): the phone held
    /// landscape with its top to the left, which makes the sensor image upright.
    static let gravity: [Double] = [-1, 0, 0]
    /// The synthetic face's distance from the camera in ARKit mode, metres.
    static let depthMetres = 0.45
    /// Sizes offered, largest first (4:3 like the phone's video formats).
    static let formats: [(width: Int, height: Int)] = [(1920, 1440), (1280, 960), (640, 480)]

    static let backgroundLuma: UInt8 = 180
    static let discLuma: UInt8 = 40
    static let spotLuma: UInt8 = 250

    struct Disc {
        let name: String
        /// Centre in sensor pixels (continuous convention: pixel (i, j) covers [i, i+1)).
        let x: Double
        let y: Double
        let r: Double
        let spotX: Double
        let spotY: Double
        let spotR: Double

        var json: [String: Any] {
            ["name": name, "x": x, "y": y, "r": r, "spotX": spotX, "spotY": spotY, "spotR": spotR]
        }
    }

    static func isTestCamera(_ id: String) -> Bool {
        id == cameraId || id == arkitCameraId
    }

    /// The size for a `maxWidth` request: the largest format no wider, else the smallest.
    static func size(maxWidth: Int) -> (width: Int, height: Int) {
        formats.first { $0.width <= maxWidth } ?? formats[formats.count - 1]
    }

    /// Entries for the `cameras` list.
    static func cameraEntries() -> [[String: Any]] {
        let formatList: [[String: Any]] = formats.map {
            ["width": $0.width, "height": $0.height, "maxFps": maxFps]
        }
        return [
            [
                "id": cameraId,
                "name": "Test pattern (synthetic camera)",
                "position": "back",
                "type": "wide",
                "minFocusDistanceMM": 100,
                "canFocus": false,
                "formats": formatList,
                "zoomPresets": [2.0],
                "fieldOfView": fieldOfView,
                "testPattern": true,
            ],
            [
                "id": arkitCameraId,
                "name": "Test pattern with a synthetic ARKit face",
                "position": "front",
                "type": "arkit",
                "minFocusDistanceMM": -1,
                "canFocus": false,
                "formats": formatList,
                "zoomPresets": [Double](),
                "fieldOfView": fieldOfView,
                "testPattern": true,
            ],
        ]
    }

    /// Unzoomed intrinsics for a `width × height` buffer.
    static func intrinsics(width: Int, height: Int) -> matrix_float3x3 {
        let f = Float(Double(width) / 2 / tan(fieldOfView / 2 * Double.pi / 180))
        return matrix_float3x3(columns: (
            simd_float3(f, 0, 0),
            simd_float3(0, f, 0),
            simd_float3(Float(width) / 2, Float(height) / 2, 1)
        ))
    }

    /// What frame `t` shows at `zoom`.
    static func discs(t: Double, width: Int, height: Int, zoom: Double) -> [Disc] {
        let w = Double(width)
        let h = Double(height)
        let phase = 2 * Double.pi * t / 8
        let dx = 0.04 * cos(phase)
        let dy = 0.03 * sin(phase)
        let r0 = 0.025 * w
        func disc(_ name: String, _ nx: Double, _ ny: Double) -> Disc {
            let x0 = nx * w
            let y0 = ny * h
            let x = w / 2 + (x0 - w / 2) * zoom
            let y = h / 2 + (y0 - h / 2) * zoom
            let r = r0 * zoom
            return Disc(
                name: name, x: x, y: y, r: r,
                spotX: x + 0.35 * r, spotY: y - 0.35 * r, spotR: 0.2 * r
            )
        }
        return [disc("right_eye", 0.40 + dx, 0.46 + dy), disc("left_eye", 0.60 + dx, 0.54 + dy)]
    }

    static let textureRows = 61
    static let textureAmplitude = 12

    /// Fixed noise for the background: `textureRows` rows of `width` luma values. Rows are
    /// reused cyclically; 61 rows do not line up with JPEG's 8 × 8 blocks.
    static func texture(width: Int) -> [UInt8] {
        var state: UInt32 = 0x2545F491
        var values = [UInt8](repeating: backgroundLuma, count: width * textureRows)
        let span = UInt32(2 * textureAmplitude + 1)
        for index in values.indices {
            state = state &* 1_664_525 &+ 1_013_904_223
            let noise = Int((state >> 16) % span) - textureAmplitude
            values[index] = UInt8(Int(backgroundLuma) + noise)
        }
        return values
    }

    /// Draws the picture into a bi-planar 4:2:0 buffer (the camera's format). `texture` is
    /// `texture(width:)` for the buffer's width.
    static func render(_ discs: [Disc], into buffer: CVPixelBuffer, texture: [UInt8]) {
        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        guard CVPixelBufferGetPlaneCount(buffer) >= 2,
              let luma = CVPixelBufferGetBaseAddressOfPlane(buffer, 0),
              let chroma = CVPixelBufferGetBaseAddressOfPlane(buffer, 1)
        else { return }
        let width = CVPixelBufferGetWidthOfPlane(buffer, 0)
        let height = CVPixelBufferGetHeightOfPlane(buffer, 0)
        let lumaStride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0)
        let chromaHeight = CVPixelBufferGetHeightOfPlane(buffer, 1)
        let chromaStride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 1)

        memset(chroma, 128, chromaStride * chromaHeight)
        let rows = luma.assumingMemoryBound(to: UInt8.self)
        if texture.count >= width * textureRows {
            texture.withUnsafeBufferPointer { source in
                guard let base = source.baseAddress else { return }
                for row in 0..<height {
                    memcpy(rows + row * lumaStride, base + (row % textureRows) * width, width)
                }
            }
        } else {
            for row in 0..<height {
                memset(rows + row * lumaStride, Int32(backgroundLuma), width)
            }
        }
        // A pixel is inside a circle when its centre (i + 0.5, j + 0.5) is.
        func fill(_ cx: Double, _ cy: Double, _ r: Double, _ value: UInt8) {
            let x0 = max(0, Int((cx - r).rounded(.down)))
            let x1 = min(width - 1, Int((cx + r).rounded(.up)))
            let y0 = max(0, Int((cy - r).rounded(.down)))
            let y1 = min(height - 1, Int((cy + r).rounded(.up)))
            guard x0 <= x1, y0 <= y1 else { return }
            let r2 = r * r
            for j in y0...y1 {
                let dy = Double(j) + 0.5 - cy
                let line = rows + j * lumaStride
                for i in x0...x1 {
                    let dx = Double(i) + 0.5 - cx
                    if dx * dx + dy * dy <= r2 { line[i] = value }
                }
            }
        }
        for disc in discs {
            fill(disc.x, disc.y, disc.r, discLuma)
            fill(disc.spotX, disc.spotY, disc.spotR, spotLuma)
        }
    }

    /// A synthetic face looking straight at the camera, its eyes where the discs are, at
    /// `depthMetres`. Returns the `arkit` header block (layout as PROTOCOL.md), the eye
    /// centres in sensor pixels, and the values of the recording's ARKit CSV columns.
    static func arkit(
        _ discs: [Disc], intrinsics k: matrix_float3x3, blendShapeNames: [String]
    ) -> (block: [String: Any], eyes: (left: CGPoint, right: CGPoint)?, face: simd_float4x4,
          leftEye: simd_float4x4, rightEye: simd_float4x4, lookAt: simd_float3) {
        let fx = Double(k.columns.0.x)
        let fy = Double(k.columns.1.y)
        let cx = Double(k.columns.2.x)
        let cy = Double(k.columns.2.y)
        let z = depthMetres
        // ARKit camera space: +x along the image's +u, +y up the image (-v), looking down -z.
        func point(_ disc: Disc) -> simd_float3 {
            simd_float3(Float((disc.x - cx) * z / fx), Float(-(disc.y - cy) * z / fy), Float(-z))
        }
        let left = discs.first { $0.name == "left_eye" }
        let right = discs.first { $0.name == "right_eye" }
        let leftPoint = left.map(point) ?? simd_float3(0.03, 0, Float(-z))
        let rightPoint = right.map(point) ?? simd_float3(-0.03, 0, Float(-z))
        let middle = (leftPoint + rightPoint) / 2
        func translation(_ v: simd_float3) -> simd_float4x4 {
            var m = matrix_identity_float4x4
            m.columns.3 = simd_float4(v.x, v.y, v.z, 1)
            return m
        }
        // The face is not rotated: its +z (out of the face) is the camera's +z, towards the
        // camera, and its +x is the image's +u. The camera is the world origin.
        let face = translation(middle)
        let leftEye = translation(leftPoint - middle)
        let rightEye = translation(rightPoint - middle)
        let lookAt = -middle
        var shapes: [String: Any] = [:]
        for name in blendShapeNames { shapes[name] = 0.0 }
        var block: [String: Any] = [
            "tracked": true,
            "face": flatten(face),
            "leftEye": flatten(leftEye),
            "rightEye": flatten(rightEye),
            "camera": flatten(matrix_identity_float4x4),
            "lookAt": [Double(lookAt.x), Double(lookAt.y), Double(lookAt.z)],
            "blendShapes": shapes,
        ]
        var eyes: (left: CGPoint, right: CGPoint)?
        if let left = left, let right = right {
            eyes = (CGPoint(x: left.x, y: left.y), CGPoint(x: right.x, y: right.y))
            block["eyePixels"] = ["left": [left.x, left.y], "right": [right.x, right.y]]
        }
        return (block, eyes, face, leftEye, rightEye, lookAt)
    }

    /// Column-major, as on the wire.
    static func flatten(_ m: simd_float4x4) -> [Double] {
        [m.columns.0, m.columns.1, m.columns.2, m.columns.3].flatMap {
            [Double($0.x), Double($0.y), Double($0.z), Double($0.w)]
        }
    }
}

/// Produces test-pattern frames at a fixed rate on the given queue (the capture frame
/// queue, so frames are handled exactly where camera frames are).
final class TestPatternSource {
    private let queue: DispatchQueue
    private let width: Int
    private let height: Int
    private let fps: Double
    private var pool: CVPixelBufferPool?
    private var timer: DispatchSourceTimer?
    private let texture: [UInt8]
    /// Called on `queue` with each new buffer and its capture time (phone clock).
    private let onFrame: (CVPixelBuffer, Double) -> Void

    init(queue: DispatchQueue, width: Int, height: Int, fps: Double,
         onFrame: @escaping (CVPixelBuffer, Double) -> Void) {
        self.queue = queue
        self.width = width
        self.height = height
        self.fps = min(max(fps, 1), TestPattern.maxFps)
        self.onFrame = onFrame
        self.texture = TestPattern.texture(width: width)
        let attributes: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
            kCVPixelBufferWidthKey as String: width,
            kCVPixelBufferHeightKey as String: height,
            kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any](),
        ]
        CVPixelBufferPoolCreate(nil, nil, attributes as CFDictionary, &pool)
    }

    var frameRate: Double { fps }

    /// Draws `discs` into a buffer this source made.
    func render(_ discs: [TestPattern.Disc], into buffer: CVPixelBuffer) {
        TestPattern.render(discs, into: buffer, texture: texture)
    }

    func start() {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: 1 / fps, leeway: .milliseconds(1))
        timer.setEventHandler { [weak self] in self?.tick() }
        timer.resume()
        self.timer = timer
    }

    func stop() {
        timer?.cancel()
        timer = nil
    }

    deinit {
        timer?.cancel()
    }

    private func tick() {
        guard let pool = pool else { return }
        var buffer: CVPixelBuffer?
        // A pool that has run dry (every buffer still being encoded or recorded) means a
        // dropped frame, as with a real camera.
        let attributes = [kCVPixelBufferPoolAllocationThresholdKey as String: 8] as CFDictionary
        guard CVPixelBufferPoolCreatePixelBufferWithAuxAttributes(nil, pool, attributes, &buffer)
            == kCVReturnSuccess, let pixelBuffer = buffer
        else { return }
        onFrame(pixelBuffer, CACurrentMediaTime())
    }
}
