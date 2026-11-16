import ARKit
import AVFoundation
import CoreImage
import Foundation
import ImageIO
import QuartzCore
import simd
import UIKit

enum CaptureError: Error, CustomStringConvertible {
    case unknownCamera(String)
    case noFormat
    case cannotAddInput
    case cannotAddOutput
    case faceTrackingUnsupported
    case busyRecording
    /// Zoom and lens settings need a running AVFoundation camera (HTTP 409).
    case notRunningCamera(String)
    /// A bad value in a lens request (HTTP 400).
    case badRequest(String)

    var description: String {
        switch self {
        case .unknownCamera(let id): return "Unknown camera \(id)"
        case .noFormat: return "The camera has no usable video format"
        case .cannotAddInput: return "The capture session rejected the camera"
        case .cannotAddOutput: return "The capture session rejected the video output"
        case .faceTrackingUnsupported: return "This device does not support ARKit face tracking"
        case .busyRecording: return "Stop the recording before changing camera"
        case .notRunningCamera(let what): return "\(what) needs a running camera (not ARKit, not idle)"
        case .badRequest(let message): return message
        }
    }
}

enum PreviewKind: Hashable {
    /// The whole frame, scaled down.
    case full
    /// A region at native resolution, to judge focus and iris detail.
    case crop
}

/// Where the native-resolution crop is taken. `centerX`/`centerY` are 0...1
/// from the top-left of the frame; `width` is in sensor pixels.
struct CropSpec {
    var centerX = 0.5
    var centerY = 0.5
    var width = 640.0
}

/// Owns the camera. It runs one source at a time: either a single physical
/// camera through AVFoundation (so iOS never silently switches lens), or the
/// front TrueDepth camera through ARKit face tracking, which adds Apple's own
/// eye and head estimates as a baseline to compare against.
///
/// Threading: `configure`, `stop` and `setFocus` are called from the HTTP
/// queue. Frames arrive on `frameQueue`, which also owns the recorder. State
/// shared between threads sits behind `lock`.
final class CaptureCoordinator: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate,
    AVCaptureDepthDataOutputDelegate, ARSessionDelegate {
    static let arkitCameraId = "arkit-face"

    static let cameraColumns = [
        "lens_position", "iso", "exposure_s", "adjusting_focus", "adjusting_exposure",
    ]

    static let blendShapes: [(String, ARFaceAnchor.BlendShapeLocation)] = [
        ("blink_left", .eyeBlinkLeft), ("blink_right", .eyeBlinkRight),
        ("look_down_left", .eyeLookDownLeft), ("look_down_right", .eyeLookDownRight),
        ("look_in_left", .eyeLookInLeft), ("look_in_right", .eyeLookInRight),
        ("look_out_left", .eyeLookOutLeft), ("look_out_right", .eyeLookOutRight),
        ("look_up_left", .eyeLookUpLeft), ("look_up_right", .eyeLookUpRight),
        ("squint_left", .eyeSquintLeft), ("squint_right", .eyeSquintRight),
        ("wide_left", .eyeWideLeft), ("wide_right", .eyeWideRight),
    ]

    /// Matrices are written column by column: `<name>_c<column>r<row>`.
    static let arkitColumns: [String] = {
        var columns = ["face_tracked"]
        columns.append(contentsOf: matrixColumns("face"))
        columns.append(contentsOf: matrixColumns("left_eye"))
        columns.append(contentsOf: matrixColumns("right_eye"))
        columns.append(contentsOf: ["look_at_x", "look_at_y", "look_at_z"])
        columns.append(contentsOf: matrixColumns("camera"))
        for (name, _) in blendShapes {
            columns.append(name)
        }
        return columns
    }()

    private struct Segment {
        let directory: URL
        let name: String
        let label: String
    }

    private struct State {
        var mode = "idle"
        var cameraId = ""
        var cameraName = ""
        var cameraType = ""
        var position = ""
        var width = 0
        var height = 0
        var requestedFps = 0.0
        var measuredFps = 0.0
        var zoom = 1.0
        var zoomRange: [Double] = []
        var nativeZoomFactors: [Double] = []
        var zoomChangedAt = -Double.infinity
        var depthSource = ""
        var lens: [String: Any] = [:]
        var lowLight = false
        var fieldOfView = Double.nan
        var minFocusDistanceMM = -1
        var binned = false
        var focusLocked = false
        var lensPosition = Double.nan
        var iso = Double.nan
        var exposureSeconds = Double.nan
        var adjustingFocus = false
        var faceTracked = false
        var interrupted = ""
        var recording = false
        var segment = ""
        var framesWritten = 0
        var framesSkipped = 0
        var framesDropped = 0
        var lastError = ""
    }

    private let captureSession = AVCaptureSession()
    private let videoOutput = AVCaptureVideoDataOutput()
    private let depthOutput = AVCaptureDepthDataOutput()
    private let arSession = ARSession()
    private let frameQueue = DispatchQueue(label: "eyecapture.frames", qos: .userInitiated)
    private let ciContext = CIContext()
    private let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
    private let motion = MotionLogger()
    private let lock = NSLock()

    /// The live stream (`GET /stream`).
    let streamer = FrameStreamer()

    private lazy var devices: [AVCaptureDevice] = AVCaptureDevice.DiscoverySession(
        // The LiDAR entry is the back wide camera plus the LiDAR scanner. It
        // only exists on phones that have one.
        deviceTypes: [
            .builtInWideAngleCamera, .builtInUltraWideCamera, .builtInTelephotoCamera,
            .builtInLiDARDepthCamera,
        ],
        mediaType: .video,
        position: .unspecified
    ).devices

    // Guarded by `lock`.
    private var state = State()
    private var device: AVCaptureDevice?
    private var intrinsics: [String: Double]?
    private var previewWantedUntil: [PreviewKind: CFTimeInterval] = [:]
    private var previewData: [PreviewKind: Data] = [:]
    private var cropSpec = CropSpec()

    // Frame queue only.
    private var recorder: SegmentRecorder?
    private var pendingSegment: Segment?
    private var activeSegment: Segment?
    private var segmentInfo: [String: Any] = [:]
    private var droppedAtSegmentStart = 0
    private var lastPreviewTime: CFTimeInterval = 0
    private var fpsWindowStart: CFTimeInterval = 0
    private var fpsWindowFrames = 0
    private var latestDepth: DepthSample?

    override init() {
        super.init()
        var sources = ["mac"]
        if ARFaceTrackingConfiguration.isSupported { sources.append("arkit") }
        sources.append("vision")
        streamer.setSupportedRoiSources(sources)
        streamer.stateProvider = { [weak self] in self?.statusJSON() ?? [:] }

        // Frames stop without any error when the camera is interrupted (the app went to
        // the background, another app took the camera, the phone got too hot). Say so
        // in the status, and restart the session after a runtime error.
        let center = NotificationCenter.default
        center.addObserver(
            self, selector: #selector(captureRuntimeError(_:)),
            name: .AVCaptureSessionRuntimeError, object: captureSession
        )
        center.addObserver(
            self, selector: #selector(captureInterrupted(_:)),
            name: .AVCaptureSessionWasInterrupted, object: captureSession
        )
        center.addObserver(
            self, selector: #selector(captureInterruptionEnded(_:)),
            name: .AVCaptureSessionInterruptionEnded, object: captureSession
        )
    }

    // MARK: - Interruptions

    private let restartQueue = DispatchQueue(label: "eyecapture.session-restart")

    @objc private func captureRuntimeError(_ note: Notification) {
        let error = note.userInfo?[AVCaptureSessionErrorKey] as? NSError
        lock.lock()
        state.lastError = "Camera error: \(error?.localizedDescription ?? "unknown")"
        let mode = state.mode
        lock.unlock()
        guard mode == "camera" else { return }
        restartQueue.async { [weak self] in
            guard let self = self, !self.captureSession.isRunning else { return }
            self.captureSession.startRunning()
        }
    }

    @objc private func captureInterrupted(_ note: Notification) {
        var reason = "interrupted"
        if let raw = note.userInfo?[AVCaptureSessionInterruptionReasonKey] as? Int {
            switch raw {
            case AVCaptureSession.InterruptionReason.videoDeviceNotAvailableInBackground.rawValue:
                reason = "the app is in the background"
            case AVCaptureSession.InterruptionReason.videoDeviceInUseByAnotherClient.rawValue:
                reason = "another app is using the camera"
            case AVCaptureSession.InterruptionReason.videoDeviceNotAvailableDueToSystemPressure.rawValue:
                reason = "the phone is too hot"
            default:
                reason = "interrupted (reason \(raw))"
            }
        }
        lock.lock()
        state.interrupted = reason
        state.lastError = "Camera stopped: \(reason)"
        lock.unlock()
    }

    @objc private func captureInterruptionEnded(_ note: Notification) {
        lock.lock()
        state.interrupted = ""
        if state.lastError.hasPrefix("Camera stopped:") { state.lastError = "" }
        lock.unlock()
    }

    func sessionWasInterrupted(_ session: ARSession) {
        lock.lock()
        state.interrupted = "ARKit was interrupted"
        state.lastError = "Camera stopped: ARKit was interrupted"
        lock.unlock()
    }

    func sessionInterruptionEnded(_ session: ARSession) {
        lock.lock()
        state.interrupted = ""
        if state.lastError.hasPrefix("Camera stopped:") { state.lastError = "" }
        lock.unlock()
    }

    // MARK: - Camera list

    func startMotion() {
        motion.start()
    }

    /// Every camera the page can choose, with what each can do.
    func cameraList() -> [[String: Any]] {
        var list: [[String: Any]] = devices.map { device -> [String: Any] in
            var best: [String: (width: Int, height: Int, fps: Double)] = [:]
            var zoomPresets = Set<Double>()
            for format in device.formats where Self.isUsable(format) {
                let size = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
                let key = "\(size.width)x\(size.height)"
                let fps = format.videoSupportedFrameRateRanges.map { $0.maxFrameRate }.max() ?? 0
                if fps > (best[key]?.fps ?? 0) {
                    best[key] = (Int(size.width), Int(size.height), fps)
                }
                for factor in format.secondaryNativeResolutionZoomFactors {
                    zoomPresets.insert(Double(factor))
                }
            }
            let formats = best.values
                .sorted { $0.width * $0.height > $1.width * $1.height }
                .map { ["width": $0.width, "height": $0.height, "maxFps": $0.fps] as [String: Any] }

            var entry: [String: Any] = [
                "id": device.uniqueID,
                "name": device.localizedName,
                "position": Self.positionName(device.position),
                "type": Self.typeName(device.deviceType),
                "minFocusDistanceMM": device.minimumFocusDistance,
                "canFocus": device.isFocusModeSupported(.continuousAutoFocus),
                "formats": formats,
                "zoomPresets": zoomPresets.sorted(),
            ]
            if device.deviceType == .builtInLiDARDepthCamera {
                entry["depthSource"] = "lidar"
                entry["name"] = "\(device.localizedName) (experimental: wide camera with LiDAR depth)"
            }
            if let format = Self.pickFormat(device, maxWidth: 3840, fps: 30) {
                entry["fieldOfView"] = Self.reportedFieldOfView(device, format)
            }
            return entry
        }

        if ARFaceTrackingConfiguration.isSupported {
            let formats = ARFaceTrackingConfiguration.supportedVideoFormats
                .sorted {
                    $0.imageResolution.width * $0.imageResolution.height
                        > $1.imageResolution.width * $1.imageResolution.height
                }
                .map {
                    [
                        "width": Int($0.imageResolution.width),
                        "height": Int($0.imageResolution.height),
                        "maxFps": Double($0.framesPerSecond),
                    ] as [String: Any]
                }
            list.append([
                "id": Self.arkitCameraId,
                "name": "Front TrueDepth camera with ARKit face tracking",
                "position": "front",
                "type": "arkit",
                "minFocusDistanceMM": -1,
                "canFocus": false,
                "formats": formats,
                "zoomPresets": [Double](),
                "depthSource": "truedepth",
            ])
        }
        return list
    }

    /// What this phone can stream, for `hello.capabilities`.
    func streamCapabilities() -> [String: Any] {
        let arkit = ARFaceTrackingConfiguration.isSupported
        let lidar = devices.contains { $0.deviceType == .builtInLiDARDepthCamera }
        var roiSources = ["mac"]
        if arkit { roiSources.append("arkit") }
        roiSources.append("vision")
        var depthSources: [String] = []
        if arkit { depthSources.append("truedepth") }
        if lidar { depthSources.append("lidar") }
        let fps60 = devices.contains { device in
            device.formats.contains { format in
                Self.isUsable(format) && format.videoSupportedFrameRateRanges.contains { $0.maxFrameRate >= 59 }
            }
        }
        return [
            "arkit": arkit,
            "depth": !depthSources.isEmpty,
            "depthSources": depthSources,
            "roiSources": roiSources,
            "formats": ["jpeg"],
            "depthFormats": ["depth32"],
            "maxRois": StreamConfig.maxRois,
            "fps60": fps60,
            "zoom": true,
            "lensControl": true,
        ]
    }

    // MARK: - Configuration

    /// Switches to a camera and starts it. Blocks until the camera is running.
    func configure(cameraId: String, maxWidth: Int, fps: Double, zoom: Double) throws {
        lock.lock()
        let isRecording = state.recording
        lock.unlock()
        guard !isRecording else { throw CaptureError.busyRecording }

        stopSources()
        if cameraId == Self.arkitCameraId {
            try startARKit(maxWidth: maxWidth, fps: fps)
        } else {
            try startCamera(cameraId: cameraId, maxWidth: maxWidth, fps: fps, zoom: zoom)
        }
    }

    /// Stops whichever source is running.
    func stop() {
        stopSources()
    }

    private func stopSources() {
        if captureSession.isRunning {
            captureSession.stopRunning()
        }
        arSession.pause()
        lock.lock()
        let keptError = state.lastError
        state = State()
        state.lastError = keptError
        device = nil
        intrinsics = nil
        previewData = [:]
        lock.unlock()
        frameQueue.async { self.latestDepth = nil }
    }

    private func startCamera(cameraId: String, maxWidth: Int, fps: Double, zoom: Double) throws {
        guard let device = devices.first(where: { $0.uniqueID == cameraId }) else {
            throw CaptureError.unknownCamera(cameraId)
        }
        let wantsDepth = device.deviceType == .builtInLiDARDepthCamera
        guard let format = Self.pickFormat(device, maxWidth: maxWidth, fps: fps, needsDepth: wantsDepth)
            ?? Self.pickFormat(device, maxWidth: maxWidth, fps: 30, needsDepth: wantsDepth)
            ?? Self.pickFormat(device, maxWidth: Int.max, fps: 30, needsDepth: wantsDepth)
        else {
            throw CaptureError.noFormat
        }
        let maxRate = format.videoSupportedFrameRateRanges.map { $0.maxFrameRate }.max() ?? 30
        let rate = min(max(fps, 1), maxRate).rounded()

        captureSession.beginConfiguration()
        var committed = false
        defer {
            if !committed { captureSession.commitConfiguration() }
        }

        captureSession.sessionPreset = .inputPriority
        for input in captureSession.inputs {
            captureSession.removeInput(input)
        }
        let input = try AVCaptureDeviceInput(device: device)
        guard captureSession.canAddInput(input) else { throw CaptureError.cannotAddInput }
        captureSession.addInput(input)

        if !captureSession.outputs.contains(videoOutput) {
            videoOutput.videoSettings = [
                kCVPixelBufferPixelFormatTypeKey as String:
                    kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
            ]
            videoOutput.alwaysDiscardsLateVideoFrames = true
            videoOutput.setSampleBufferDelegate(self, queue: frameQueue)
            guard captureSession.canAddOutput(videoOutput) else { throw CaptureError.cannotAddOutput }
            captureSession.addOutput(videoOutput)
        }
        var depthFormat: AVCaptureDevice.Format?
        if wantsDepth {
            depthFormat = Self.pickDepthFormat(format)
            if depthFormat != nil, !captureSession.outputs.contains(depthOutput),
               captureSession.canAddOutput(depthOutput) {
                depthOutput.setDelegate(self, callbackQueue: frameQueue)
                depthOutput.alwaysDiscardsLateDepthData = true
                depthOutput.isFilteringEnabled = true
                captureSession.addOutput(depthOutput)
            }
        } else if captureSession.outputs.contains(depthOutput) {
            captureSession.removeOutput(depthOutput)
        }
        let depthRunning = depthFormat != nil && captureSession.outputs.contains(depthOutput)

        // Hold the device lock until the session is running, so the session
        // cannot replace the format we chose.
        try device.lockForConfiguration()
        defer { device.unlockForConfiguration() }

        device.activeFormat = format
        if depthRunning, let depthFormat = depthFormat {
            device.activeDepthDataFormat = depthFormat
        }
        let frameDuration = CMTime(value: 1, timescale: CMTimeScale(rate))
        device.activeVideoMinFrameDuration = frameDuration
        device.activeVideoMaxFrameDuration = frameDuration
        let maxZoom = min(device.maxAvailableVideoZoomFactor, format.videoMaxZoomFactor)
        let appliedZoom = min(max(CGFloat(zoom), device.minAvailableVideoZoomFactor), maxZoom)
        device.videoZoomFactor = appliedZoom
        if device.isFocusModeSupported(.continuousAutoFocus) {
            device.focusMode = .continuousAutoFocus
        }
        if device.isExposureModeSupported(.continuousAutoExposure) {
            device.exposureMode = .continuousAutoExposure
        }
        if device.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) {
            device.whiteBalanceMode = .continuousAutoWhiteBalance
        }

        if let connection = videoOutput.connection(with: .video) {
            // Raw sensor image: no stabilisation crop, no mirroring.
            if connection.isVideoStabilizationSupported {
                connection.preferredVideoStabilizationMode = .off
            }
            if connection.isVideoMirroringSupported {
                connection.automaticallyAdjustsVideoMirroring = false
                connection.isVideoMirrored = false
            }
            if connection.isCameraIntrinsicMatrixDeliverySupported {
                connection.isCameraIntrinsicMatrixDeliveryEnabled = true
            }
        }

        captureSession.commitConfiguration()
        committed = true
        captureSession.startRunning()

        let size = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
        lock.lock()
        self.device = device
        state.mode = "camera"
        state.cameraId = device.uniqueID
        state.cameraName = device.localizedName
        state.position = Self.positionName(device.position)
        state.width = Int(size.width)
        state.height = Int(size.height)
        state.requestedFps = rate
        state.zoom = Double(appliedZoom)
        state.zoomRange = [Double(device.minAvailableVideoZoomFactor), Double(maxZoom)]
        state.nativeZoomFactors = format.secondaryNativeResolutionZoomFactors.map { Double($0) }
        state.cameraType = Self.typeName(device.deviceType)
        state.depthSource = depthRunning ? "lidar" : ""
        state.fieldOfView = Self.reportedFieldOfView(device, format)
        state.minFocusDistanceMM = device.minimumFocusDistance
        state.binned = format.isVideoBinned
        state.lastError = ""
        lock.unlock()
    }

    /// Horizontal field of view of the delivered buffer. With geometric distortion
    /// correction on (the default where supported: the ultra wide and some front
    /// cameras) the buffer is the corrected, narrower image, so report its field of
    /// view rather than the uncorrected `videoFieldOfView`.
    static func reportedFieldOfView(_ device: AVCaptureDevice, _ format: AVCaptureDevice.Format) -> Double {
        if device.isGeometricDistortionCorrectionSupported && device.isGeometricDistortionCorrectionEnabled {
            let corrected = Double(format.geometricDistortionCorrectedVideoFieldOfView)
            if corrected > 0 { return corrected }
        }
        return Double(format.videoFieldOfView)
    }

    private func startARKit(maxWidth: Int, fps: Double) throws {
        guard ARFaceTrackingConfiguration.isSupported else {
            throw CaptureError.faceTrackingUnsupported
        }
        let configuration = ARFaceTrackingConfiguration()
        configuration.isLightEstimationEnabled = false

        let formats = ARFaceTrackingConfiguration.supportedVideoFormats
        let allowed = formats.filter { Int($0.imageResolution.width) <= maxWidth }
        let candidates = allowed.isEmpty ? formats : allowed
        // Most pixels first, then the frame rate closest to the request.
        let chosen = candidates.max { first, second in
            let firstPixels = first.imageResolution.width * first.imageResolution.height
            let secondPixels = second.imageResolution.width * second.imageResolution.height
            if firstPixels != secondPixels { return firstPixels < secondPixels }
            return abs(Double(first.framesPerSecond) - fps) > abs(Double(second.framesPerSecond) - fps)
        }
        if let chosen = chosen {
            configuration.videoFormat = chosen
        }

        arSession.delegate = self
        arSession.delegateQueue = frameQueue
        arSession.run(configuration, options: [.resetTracking, .removeExistingAnchors])

        let format = configuration.videoFormat
        lock.lock()
        state.mode = "arkit"
        state.cameraId = Self.arkitCameraId
        state.cameraName = "Front TrueDepth camera with ARKit face tracking"
        state.position = "front"
        state.width = Int(format.imageResolution.width)
        state.height = Int(format.imageResolution.height)
        state.requestedFps = Double(format.framesPerSecond)
        state.zoom = 1
        state.zoomRange = [1, 1]
        state.cameraType = "arkit"
        state.depthSource = "truedepth"
        state.lastError = ""
        lock.unlock()
    }

    // MARK: - Zoom and lens

    /// Changes zoom on the running camera without restarting it. Returns the
    /// zoom actually applied (clamped to the device's range).
    @discardableResult
    func setZoom(_ zoom: Double) throws -> Double {
        lock.lock()
        let device = self.device
        let mode = state.mode
        lock.unlock()
        guard mode == "camera", let device = device else {
            throw CaptureError.notRunningCamera("Zoom")
        }
        guard zoom.isFinite, zoom > 0 else {
            throw CaptureError.badRequest("zoom must be a positive number")
        }
        try device.lockForConfiguration()
        defer { device.unlockForConfiguration() }
        if device.isRampingVideoZoom {
            device.cancelVideoZoomRamp()
        }
        let maxZoom = min(device.maxAvailableVideoZoomFactor, device.activeFormat.videoMaxZoomFactor)
        let applied = min(max(CGFloat(zoom), device.minAvailableVideoZoomFactor), maxZoom)
        device.videoZoomFactor = applied
        lock.lock()
        state.zoom = Double(applied)
        state.zoomChangedAt = CACurrentMediaTime()
        lock.unlock()
        return Double(applied)
    }

    /// Exposure and focus options for the running camera. Body keys, all
    /// optional: `focusLocked`, `exposureLocked`, `whiteBalanceLocked`,
    /// `faceDrivenAutoFocus` (bools), `exposureBias` (EV), `maxExposureS`
    /// (seconds, caps the auto-exposure shutter; null removes the cap).
    func setLens(_ body: [String: Any]) throws {
        let known: Set<String> = [
            "focusLocked", "exposureLocked", "whiteBalanceLocked", "faceDrivenAutoFocus",
            "exposureBias", "maxExposureS",
        ]
        for key in body.keys where !known.contains(key) {
            throw CaptureError.badRequest("Unknown lens setting \(key)")
        }
        func flag(_ key: String) throws -> Bool? {
            guard let value = body[key] else { return nil }
            guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else {
                throw CaptureError.badRequest("\(key) must be true or false")
            }
            return number.boolValue
        }
        func number(_ key: String) throws -> Double? {
            guard let value = body[key], !(value is NSNull) else { return nil }
            guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
                  number.doubleValue.isFinite
            else {
                throw CaptureError.badRequest("\(key) must be a number")
            }
            return number.doubleValue
        }
        let focusLocked = try flag("focusLocked")
        let exposureLocked = try flag("exposureLocked")
        let whiteBalanceLocked = try flag("whiteBalanceLocked")
        let faceDriven = try flag("faceDrivenAutoFocus")
        let bias = try number("exposureBias")
        let maxExposure = try number("maxExposureS")
        let clearsMaxExposure = body["maxExposureS"] is NSNull

        lock.lock()
        let device = self.device
        let mode = state.mode
        lock.unlock()
        guard mode == "camera", let device = device else {
            throw CaptureError.notRunningCamera("Lens settings")
        }

        if let focusLocked = focusLocked {
            try setFocus(locked: focusLocked, point: nil)
        }

        try device.lockForConfiguration()
        defer { device.unlockForConfiguration() }

        if let locked = exposureLocked {
            if locked, device.isExposureModeSupported(.locked) {
                device.exposureMode = .locked
            } else if !locked, device.isExposureModeSupported(.continuousAutoExposure) {
                device.exposureMode = .continuousAutoExposure
            }
        }
        if let locked = whiteBalanceLocked {
            if locked, device.isWhiteBalanceModeSupported(.locked) {
                device.whiteBalanceMode = .locked
            } else if !locked, device.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) {
                device.whiteBalanceMode = .continuousAutoWhiteBalance
            }
        }
        if let bias = bias {
            let clamped = min(max(Float(bias), device.minExposureTargetBias), device.maxExposureTargetBias)
            device.setExposureTargetBias(clamped, completionHandler: nil)
        }
        if maxExposure != nil || clearsMaxExposure {
            let auto = device.exposureMode == .continuousAutoExposure || device.exposureMode == .autoExpose
            guard auto else {
                throw CaptureError.badRequest("maxExposureS needs automatic exposure; unlock exposure first")
            }
            if let seconds = maxExposure, seconds > 0 {
                let format = device.activeFormat
                var duration = CMTime(seconds: seconds, preferredTimescale: 1_000_000)
                if CMTimeCompare(duration, format.minExposureDuration) < 0 {
                    duration = format.minExposureDuration
                }
                if CMTimeCompare(duration, format.maxExposureDuration) > 0 {
                    duration = format.maxExposureDuration
                }
                device.activeMaxExposureDuration = duration
            } else {
                // Invalid restores the default cap.
                device.activeMaxExposureDuration = .invalid
            }
        }
        if let faceDriven = faceDriven {
            if device.isFocusModeSupported(.continuousAutoFocus) {
                device.automaticallyAdjustsFaceDrivenAutoFocusEnabled = false
                device.isFaceDrivenAutoFocusEnabled = faceDriven
            }
            if device.isExposureModeSupported(.continuousAutoExposure) {
                device.automaticallyAdjustsFaceDrivenAutoExposureEnabled = false
                device.isFaceDrivenAutoExposureEnabled = faceDriven
            }
        }
    }

    /// Locks or releases focus, and optionally focuses and exposes on a point
    /// (0...1 from the top-left of the frame). Has no effect in ARKit mode.
    func setFocus(locked: Bool?, point: CGPoint?) throws {
        lock.lock()
        let device = self.device
        let mode = state.mode
        lock.unlock()
        guard mode == "camera", let device = device else {
            throw CaptureError.notRunningCamera("Focus")
        }

        try device.lockForConfiguration()
        defer { device.unlockForConfiguration() }

        if let point = point {
            if device.isFocusPointOfInterestSupported {
                device.focusPointOfInterest = point
            }
            if device.isExposurePointOfInterestSupported {
                device.exposurePointOfInterest = point
            }
            if device.isFocusModeSupported(.continuousAutoFocus) {
                device.focusMode = .continuousAutoFocus
            }
            if device.isExposureModeSupported(.continuousAutoExposure) {
                device.exposureMode = .continuousAutoExposure
            }
        }
        if let locked = locked {
            if locked, device.isFocusModeSupported(.locked) {
                device.focusMode = .locked
            } else if !locked, device.isFocusModeSupported(.continuousAutoFocus) {
                device.focusMode = .continuousAutoFocus
            }
            lock.lock()
            state.focusLocked = locked
            lock.unlock()
        } else if point != nil {
            lock.lock()
            state.focusLocked = false
            lock.unlock()
        }
    }

    // MARK: - Recording

    /// Starts a segment. The files are created when the next frame arrives.
    func startRecording(directory: URL, name: String, label: String) {
        lock.lock()
        state.recording = true
        state.segment = name
        state.framesWritten = 0
        state.framesSkipped = 0
        lock.unlock()
        frameQueue.async {
            self.pendingSegment = Segment(directory: directory, name: name, label: label)
        }
    }

    /// Stops the segment and reports what was written.
    func stopRecording(completion: @escaping ([String: Any]) -> Void) {
        frameQueue.async {
            self.finishRecording(completion: completion)
        }
    }

    private func finishRecording(completion: @escaping ([String: Any]) -> Void) {
        pendingSegment = nil
        motion.endLog()

        lock.lock()
        state.recording = false
        let dropped = state.framesDropped - droppedAtSegmentStart
        lock.unlock()

        guard let recorder = recorder, let segment = activeSegment else {
            completion(["error": "No frames arrived, so nothing was recorded"])
            return
        }
        self.recorder = nil
        self.activeSegment = nil

        var info = segmentInfo
        info["framesWritten"] = recorder.framesWritten
        info["framesSkipped"] = recorder.framesSkipped
        info["framesDropped"] = dropped
        if let first = recorder.firstFrameTime, let last = recorder.lastFrameTime {
            info["firstFrameTime"] = first
            info["lastFrameTime"] = last
            info["durationSeconds"] = last - first
            if last > first, recorder.framesWritten > 1 {
                info["meanFps"] = Double(recorder.framesWritten - 1) / (last - first)
            }
        }
        info["thermalStateAtEnd"] = DeviceInfo.thermalName(ProcessInfo.processInfo.thermalState)
        lock.lock()
        if let intrinsics = intrinsics {
            info["intrinsics"] = intrinsics
        }
        lock.unlock()

        let jsonURL = segment.directory.appendingPathComponent("\(segment.name).json")
        recorder.finish { error in
            if let error = error {
                info["error"] = error
            }
            if JSONSerialization.isValidJSONObject(info),
               let data = try? JSONSerialization.data(
                   withJSONObject: info, options: [.prettyPrinted, .sortedKeys]
               ) {
                try? data.write(to: jsonURL)
            }
            completion(info)
        }
    }

    // MARK: - Status and preview

    func statusJSON() -> [String: Any] {
        lock.lock()
        let state = self.state
        let intrinsics = self.intrinsics
        lock.unlock()

        var json: [String: Any] = [
            "mode": state.mode,
            "cameraId": state.cameraId,
            "cameraName": state.cameraName,
            "position": state.position,
            "width": state.width,
            "height": state.height,
            "requestedFps": state.requestedFps,
            "measuredFps": state.measuredFps,
            "zoom": state.zoom,
            "minFocusDistanceMM": state.minFocusDistanceMM,
            "binned": state.binned,
            "focusLocked": state.focusLocked,
            "adjustingFocus": state.adjustingFocus,
            "faceTracked": state.faceTracked,
            "interrupted": state.interrupted,
            "recording": state.recording,
            "segment": state.segment,
            "framesWritten": state.framesWritten,
            "framesSkipped": state.framesSkipped,
            "framesDropped": state.framesDropped,
            "lastError": state.lastError,
        ]
        if state.fieldOfView.isFinite { json["fieldOfView"] = state.fieldOfView }
        if state.lensPosition.isFinite { json["lensPosition"] = state.lensPosition }
        if state.iso.isFinite { json["iso"] = state.iso }
        if state.exposureSeconds.isFinite { json["exposureSeconds"] = state.exposureSeconds }
        if let intrinsics = intrinsics { json["intrinsics"] = intrinsics }
        if let gravity = motion.gravity() { json["gravity"] = gravity }
        if !state.zoomRange.isEmpty { json["zoomRange"] = state.zoomRange }
        if !state.nativeZoomFactors.isEmpty { json["nativeZoomFactors"] = state.nativeZoomFactors }
        if !state.cameraType.isEmpty { json["cameraType"] = state.cameraType }
        if !state.depthSource.isEmpty { json["depthSource"] = state.depthSource }
        if !state.lens.isEmpty { json["lens"] = state.lens }
        json["lowLight"] = state.lowLight
        json["stream"] = streamer.stats()
        return json
    }

    var isRecording: Bool {
        lock.lock()
        defer { lock.unlock() }
        return state.recording
    }

    /// One-line summary for the phone's own screen.
    func summaryLine() -> String {
        lock.lock()
        let state = self.state
        lock.unlock()
        guard state.mode != "idle" else { return "Idle. Choose a camera on the controller page." }
        var line = "\(state.cameraName), \(state.width)×\(state.height)"
        line += String(format: ", %.0f fps", state.measuredFps)
        if state.zoom > 1.01 { line += String(format: ", %.1fx", state.zoom) }
        if state.lowLight { line += ". Low light: expect noise and blur" }
        return line
    }

    /// The latest preview image. Asking keeps previews being made for 2 s.
    func previewJPEG(_ kind: PreviewKind, crop: CropSpec? = nil) -> Data? {
        lock.lock()
        defer { lock.unlock() }
        previewWantedUntil[kind] = CACurrentMediaTime() + 2
        if let crop = crop {
            cropSpec = crop
        }
        return previewData[kind]
    }

    // MARK: - Frames

    func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let time = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)

        lock.lock()
        let device = self.device
        lock.unlock()

        var values: [Double] = [.nan, .nan, .nan, 0, 0]
        if let device = device {
            values = [
                Double(device.lensPosition),
                Double(device.iso),
                CMTimeGetSeconds(device.exposureDuration),
                device.isAdjustingFocus ? 1 : 0,
                device.isAdjustingExposure ? 1 : 0,
            ]
        }

        // Intrinsics come with every frame; they shift with focus.
        var matrix: matrix_float3x3?
        if let attachment = CMGetAttachment(
               sampleBuffer, key: kCMSampleBufferAttachmentKey_CameraIntrinsicMatrix,
               attachmentModeOut: nil
           ),
           let data = attachment as? Data,
           data.count >= MemoryLayout<matrix_float3x3>.size {
            let loaded = data.withUnsafeBytes { $0.loadUnaligned(as: matrix_float3x3.self) }
            matrix = loaded
            storeIntrinsics(loaded, pixelBuffer: pixelBuffer)
        }

        let lens = device.map { Self.lensInfo($0) } ?? [:]
        lock.lock()
        state.lensPosition = values[0]
        state.iso = values[1]
        state.exposureSeconds = values[2]
        state.adjustingFocus = values[3] > 0
        state.lens = lens
        state.lowLight = lens["lowLight"] as? Bool ?? false
        lock.unlock()

        let t = CMTimeGetSeconds(time)
        if let ticket = streamer.begin(t: t) {
            lock.lock()
            let snapshot = state
            lock.unlock()
            var lensBlock = lens
            lensBlock["focusLocked"] = snapshot.focusLocked
            var camera: [String: Any] = [
                "id": snapshot.cameraId,
                "position": snapshot.position,
                "type": snapshot.cameraType,
                "zoom": device.map { Double($0.videoZoomFactor) } ?? snapshot.zoom,
                // Capture time, not delivery time: the ISP pipeline delay is close to the
                // window, and a frame captured before the change must not count as stable.
                "zoomStable": t - snapshot.zoomChangedAt > 0.25,
                "width": CVPixelBufferGetWidth(pixelBuffer),
                "height": CVPixelBufferGetHeight(pixelBuffer),
            ]
            if snapshot.fieldOfView.isFinite { camera["fieldOfView"] = snapshot.fieldOfView }
            if let matrix = matrix {
                Self.addIntrinsics(matrix, to: &camera, source: "attachment", includesZoom: false)
            }
            var depth: DepthSample?
            if let latest = latestDepth, abs(latest.t - t) < 0.1 {
                depth = latest
            }
            let input = StreamFrameInput(
                pixelBuffer: pixelBuffer, t: t, mode: "camera", camera: camera, lens: lensBlock,
                gravity: motion.gravity(), rotationRate: motion.rotationRate(), arkit: nil,
                eyePixels: nil, depth: depth
            )
            streamer.submit(ticket, input: input)
        }

        handleFrame(pixelBuffer, time: time, values: values, columns: Self.cameraColumns)
    }

    func depthDataOutput(
        _ output: AVCaptureDepthDataOutput,
        didOutput depthData: AVDepthData,
        timestamp: CMTime,
        connection: AVCaptureConnection
    ) {
        latestDepth = DepthSample(data: depthData, t: CMTimeGetSeconds(timestamp), source: "lidar")
    }

    func captureOutput(
        _ output: AVCaptureOutput,
        didDrop sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        lock.lock()
        state.framesDropped += 1
        lock.unlock()
    }

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        let time = CMTime(seconds: frame.timestamp, preferredTimescale: 1_000_000)
        var face: ARFaceAnchor?
        for anchor in frame.anchors {
            if let candidate = anchor as? ARFaceAnchor {
                face = candidate
                break
            }
        }
        let tracked = face?.isTracked ?? false

        var values: [Double] = [tracked ? 1 : 0]
        values += Self.flatten(face?.transform)
        values += Self.flatten(face?.leftEyeTransform)
        values += Self.flatten(face?.rightEyeTransform)
        if let lookAt = face?.lookAtPoint {
            values += [Double(lookAt.x), Double(lookAt.y), Double(lookAt.z)]
        } else {
            values += [.nan, .nan, .nan]
        }
        values += Self.flatten(frame.camera.transform)
        for (_, location) in Self.blendShapes {
            values.append(face?.blendShapes[location]?.doubleValue ?? .nan)
        }

        lock.lock()
        state.faceTracked = tracked
        lock.unlock()
        storeIntrinsics(frame.camera.intrinsics, pixelBuffer: frame.capturedImage)

        if let ticket = streamer.begin(t: frame.timestamp) {
            streamARKitFrame(frame, face: face, tracked: tracked, ticket: ticket)
        }

        handleFrame(frame.capturedImage, time: time, values: values, columns: Self.arkitColumns)
    }

    private func streamARKitFrame(
        _ frame: ARFrame, face: ARFaceAnchor?, tracked: Bool, ticket: FrameStreamer.Ticket
    ) {
        let pixelBuffer = frame.capturedImage
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        var camera: [String: Any] = [
            "id": Self.arkitCameraId,
            "position": "front",
            "type": "arkit",
            "zoom": 1.0,
            "zoomStable": true,
            "width": width,
            "height": height,
        ]
        Self.addIntrinsics(frame.camera.intrinsics, to: &camera, source: "arkit", includesZoom: true)

        var arkit: [String: Any] = [
            "tracked": tracked,
            "face": face.map { Self.flatten($0.transform) as Any } ?? NSNull(),
            "leftEye": face.map { Self.flatten($0.leftEyeTransform) as Any } ?? NSNull(),
            "rightEye": face.map { Self.flatten($0.rightEyeTransform) as Any } ?? NSNull(),
            "camera": Self.flatten(frame.camera.transform),
        ]
        if let lookAt = face?.lookAtPoint {
            arkit["lookAt"] = [Double(lookAt.x), Double(lookAt.y), Double(lookAt.z)]
        } else {
            arkit["lookAt"] = NSNull()
        }
        var shapes: [String: Any] = [:]
        for (name, location) in Self.blendShapes {
            if let value = face?.blendShapes[location]?.doubleValue {
                shapes[name] = value
            }
        }
        arkit["blendShapes"] = shapes

        var eyePixels: (left: CGPoint, right: CGPoint)?
        if tracked, let face = face {
            let viewport = CGSize(width: width, height: height)
            let left = Self.project(face.transform * face.leftEyeTransform, camera: frame.camera, viewport: viewport)
            let right = Self.project(face.transform * face.rightEyeTransform, camera: frame.camera, viewport: viewport)
            if let left = left, let right = right {
                eyePixels = (left, right)
                arkit["eyePixels"] = [
                    "left": [Double(left.x), Double(left.y)],
                    "right": [Double(right.x), Double(right.y)],
                ]
            }
        }

        let lens: [String: Any] = [
            "exposureS": frame.camera.exposureDuration,
            "exposureOffset": Double(frame.camera.exposureOffset),
        ]
        var depth: DepthSample?
        if let data = frame.capturedDepthData {
            depth = DepthSample(data: data, t: frame.capturedDepthDataTimestamp, source: "truedepth")
        }
        let input = StreamFrameInput(
            pixelBuffer: pixelBuffer, t: frame.timestamp, mode: "arkit", camera: camera, lens: lens,
            gravity: motion.gravity(), rotationRate: motion.rotationRate(), arkit: arkit,
            eyePixels: eyePixels, depth: depth
        )
        streamer.submit(ticket, input: input)
    }

    func session(_ session: ARSession, didFailWithError error: Error) {
        lock.lock()
        state.lastError = "ARKit: \(error.localizedDescription)"
        lock.unlock()
    }

    private func handleFrame(
        _ pixelBuffer: CVPixelBuffer, time: CMTime, values: [Double], columns: [String]
    ) {
        let now = CACurrentMediaTime()

        fpsWindowFrames += 1
        if now - fpsWindowStart >= 1 {
            let measured = Double(fpsWindowFrames) / (now - fpsWindowStart)
            fpsWindowStart = now
            fpsWindowFrames = 0
            lock.lock()
            state.measuredFps = measured
            lock.unlock()
        }

        if recorder == nil, let segment = pendingSegment {
            pendingSegment = nil
            beginSegment(segment, pixelBuffer: pixelBuffer, columns: columns)
        }
        if let recorder = recorder {
            recorder.append(pixelBuffer, time: time, values: values)
            lock.lock()
            state.framesWritten = recorder.framesWritten
            state.framesSkipped = recorder.framesSkipped
            lock.unlock()
        }

        makePreviews(pixelBuffer, now: now)
    }

    private func beginSegment(_ segment: Segment, pixelBuffer: CVPixelBuffer, columns: [String]) {
        lock.lock()
        let state = self.state
        lock.unlock()

        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        do {
            let newRecorder = try SegmentRecorder(
                directory: segment.directory, name: segment.name,
                width: width, height: height,
                fps: state.requestedFps, columns: columns
            )
            recorder = newRecorder
            activeSegment = segment
            droppedAtSegmentStart = state.framesDropped
            motion.beginLog(
                url: segment.directory.appendingPathComponent("\(segment.name).motion.csv")
            )

            var clocks: [String: Any] = [
                "caCurrentMediaTime": CACurrentMediaTime(),
                "hostClock": CMTimeGetSeconds(CMClockGetTime(CMClockGetHostTimeClock())),
            ]
            if state.mode == "camera", let clock = captureSession.synchronizationClock {
                clocks["captureSessionClock"] = CMTimeGetSeconds(CMClockGetTime(clock))
            }

            let allColumns = ["frame", "t"] + columns
            var info: [String: Any] = [
                "segment": segment.name,
                "label": segment.label,
                "mode": state.mode,
                "cameraId": state.cameraId,
                "cameraName": state.cameraName,
                "position": state.position,
                "width": width,
                "height": height,
                "requestedFps": state.requestedFps,
                "zoom": state.zoom,
                "minFocusDistanceMM": state.minFocusDistanceMM,
                "binned": state.binned,
                "focusLocked": state.focusLocked,
                "bitrate": newRecorder.bitrate,
                "columns": allColumns,
                "timeBase": "Seconds since the phone booted. Same clock as /api/time and motion.csv.",
                "matrixLayout": "Column-major: <name>_c<column>r<row>.",
                "clockCheck": clocks,
                "startedAt": ISO8601DateFormatter().string(from: Date()),
                "device": DeviceInfo.modelIdentifier(),
            ]
            if state.fieldOfView.isFinite {
                info["fieldOfView"] = state.fieldOfView
            }
            if let gravity = motion.gravity() {
                info["gravityAtStart"] = gravity
            }
            segmentInfo = info
        } catch {
            lock.lock()
            self.state.lastError = "Could not start recording: \(error.localizedDescription)"
            self.state.recording = false
            lock.unlock()
        }
    }

    private func storeIntrinsics(_ matrix: matrix_float3x3, pixelBuffer: CVPixelBuffer) {
        let values: [String: Double] = [
            "fx": Double(matrix.columns.0.x),
            "fy": Double(matrix.columns.1.y),
            "cx": Double(matrix.columns.2.x),
            "cy": Double(matrix.columns.2.y),
            "width": Double(CVPixelBufferGetWidth(pixelBuffer)),
            "height": Double(CVPixelBufferGetHeight(pixelBuffer)),
        ]
        guard values.values.allSatisfy({ $0.isFinite }) else { return }
        lock.lock()
        intrinsics = values
        lock.unlock()
    }

    private func makePreviews(_ pixelBuffer: CVPixelBuffer, now: CFTimeInterval) {
        // Previews share the frame queue with the recorder, so make far fewer
        // of them while recording.
        let interval = recorder == nil ? 0.15 : 1.0
        guard now - lastPreviewTime >= interval else { return }

        lock.lock()
        let wantsFull = (previewWantedUntil[.full] ?? 0) > now
        let wantsCrop = (previewWantedUntil[.crop] ?? 0) > now
        let crop = cropSpec
        lock.unlock()
        guard wantsFull || wantsCrop else { return }
        lastPreviewTime = now

        let image = CIImage(cvPixelBuffer: pixelBuffer)
        let extent = image.extent
        guard extent.width > 0, extent.height > 0 else { return }

        var full: Data?
        var detail: Data?
        if wantsFull {
            let scale = min(1, 640 / extent.width)
            let scaled = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
            full = jpeg(scaled, quality: 0.6)
        }
        if wantsCrop {
            let width = min(max(CGFloat(crop.width), 64), extent.width)
            let height = min(width * 0.625, extent.height)
            // Core Image puts the origin at the bottom-left; the crop centre
            // is given from the top-left.
            let centerX = CGFloat(crop.centerX) * extent.width
            let centerY = (1 - CGFloat(crop.centerY)) * extent.height
            let originX = min(max(centerX - width / 2, 0), extent.width - width)
            let originY = min(max(centerY - height / 2, 0), extent.height - height)
            let rect = CGRect(x: originX, y: originY, width: width, height: height)
            let cropped = image
                .cropped(to: rect)
                .transformed(by: CGAffineTransform(translationX: -rect.minX, y: -rect.minY))
            detail = jpeg(cropped, quality: 0.9)
        }

        lock.lock()
        if let full = full { previewData[.full] = full }
        if let detail = detail { previewData[.crop] = detail }
        lock.unlock()
    }

    private func jpeg(_ image: CIImage, quality: CGFloat) -> Data? {
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

    // MARK: - Helpers

    private static func isUsable(_ format: AVCaptureDevice.Format) -> Bool {
        let subType = CMFormatDescriptionGetMediaSubType(format.formatDescription)
        return subType == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
            || subType == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    }

    /// The largest 8-bit format no wider than `maxWidth` that can run at `fps`.
    private static func pickFormat(
        _ device: AVCaptureDevice, maxWidth: Int, fps: Double, needsDepth: Bool = false
    ) -> AVCaptureDevice.Format? {
        let candidates = device.formats.filter { format in
            guard isUsable(format) else { return false }
            if needsDepth, pickDepthFormat(format) == nil { return false }
            let size = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
            guard Int(size.width) <= maxWidth else { return false }
            return format.videoSupportedFrameRateRanges.contains {
                $0.minFrameRate <= fps + 0.01 && $0.maxFrameRate >= fps - 0.01
            }
        }
        func score(_ format: AVCaptureDevice.Format) -> (Int, Int, Int) {
            let size = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
            let subType = CMFormatDescriptionGetMediaSubType(format.formatDescription)
            return (
                Int(size.width) * Int(size.height),
                format.isVideoBinned ? 0 : 1,
                subType == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange ? 1 : 0
            )
        }
        return candidates.max { score($0) < score($1) }
    }

    /// The largest float depth format a video format offers, if any.
    private static func pickDepthFormat(_ format: AVCaptureDevice.Format) -> AVCaptureDevice.Format? {
        let floats = format.supportedDepthDataFormats.filter { depth in
            let subType = CMFormatDescriptionGetMediaSubType(depth.formatDescription)
            return subType == kCVPixelFormatType_DepthFloat32 || subType == kCVPixelFormatType_DepthFloat16
        }
        return floats.max { first, second in
            let a = CMVideoFormatDescriptionGetDimensions(first.formatDescription)
            let b = CMVideoFormatDescriptionGetDimensions(second.formatDescription)
            return Int(a.width) * Int(a.height) < Int(b.width) * Int(b.height)
        }
    }

    /// Exposure and focus facts for one frame (the `lens` header block).
    private static func lensInfo(_ device: AVCaptureDevice) -> [String: Any] {
        let format = device.activeFormat
        let exposure = CMTimeGetSeconds(device.exposureDuration)
        let offset = Double(device.exposureTargetOffset)
        let iso = Double(device.iso)
        // At (or near) the highest ISO and still too dark: noisy and, without
        // a shutter cap, blurred.
        let lowLight = iso >= Double(format.maxISO) * 0.95 && offset < -1
        var info: [String: Any] = [
            "position": Double(device.lensPosition),
            "adjustingFocus": device.isAdjustingFocus,
            "adjustingExposure": device.isAdjustingExposure,
            "iso": iso,
            "exposureS": exposure,
            "exposureBias": Double(device.exposureTargetBias),
            "exposureOffset": offset,
            "exposureLocked": device.exposureMode == .locked,
            "whiteBalanceLocked": device.whiteBalanceMode == .locked,
            "faceDrivenAutoFocus": device.isFaceDrivenAutoFocusEnabled,
            "lowLight": lowLight,
        ]
        let cap = device.activeMaxExposureDuration
        if cap.isValid {
            info["maxExposureS"] = CMTimeGetSeconds(cap)
        }
        return info
    }

    private static func addIntrinsics(
        _ matrix: matrix_float3x3, to camera: inout [String: Any], source: String, includesZoom: Bool
    ) {
        let values = [
            Double(matrix.columns.0.x), Double(matrix.columns.1.y),
            Double(matrix.columns.2.x), Double(matrix.columns.2.y),
        ]
        guard values.allSatisfy({ $0.isFinite && $0 != 0 }) else { return }
        camera["fx"] = values[0]
        camera["fy"] = values[1]
        camera["cx"] = values[2]
        camera["cy"] = values[3]
        camera["intrinsicsSource"] = source
        camera["intrinsicsIncludeZoom"] = includesZoom
    }

    /// A transform's origin projected into the captured image's pixels, or
    /// nil if it is behind the camera.
    private static func project(_ transform: simd_float4x4, camera: ARCamera, viewport: CGSize) -> CGPoint? {
        let world = transform.columns.3
        let inCamera = camera.transform.inverse * world
        guard inCamera.z < 0 else { return nil }  // ARKit cameras look down -z.
        let point = camera.projectPoint(
            simd_float3(world.x, world.y, world.z), orientation: .landscapeRight, viewportSize: viewport
        )
        guard point.x.isFinite, point.y.isFinite else { return nil }
        return point
    }

    private static func positionName(_ position: AVCaptureDevice.Position) -> String {
        switch position {
        case .front: return "front"
        case .back: return "back"
        default: return "unknown"
        }
    }

    private static func typeName(_ type: AVCaptureDevice.DeviceType) -> String {
        switch type {
        case .builtInUltraWideCamera: return "ultrawide"
        case .builtInTelephotoCamera: return "tele"
        default: return "wide"
        }
    }

    private static func matrixColumns(_ name: String) -> [String] {
        var columns: [String] = []
        for column in 0..<4 {
            for row in 0..<4 {
                columns.append("\(name)_c\(column)r\(row)")
            }
        }
        return columns
    }

    private static func flatten(_ matrix: simd_float4x4?) -> [Double] {
        guard let matrix = matrix else { return [Double](repeating: .nan, count: 16) }
        let columns = [matrix.columns.0, matrix.columns.1, matrix.columns.2, matrix.columns.3]
        var values: [Double] = []
        values.reserveCapacity(16)
        for column in columns {
            values.append(Double(column.x))
            values.append(Double(column.y))
            values.append(Double(column.z))
            values.append(Double(column.w))
        }
        return values
    }
}
