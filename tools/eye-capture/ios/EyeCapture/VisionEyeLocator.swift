import CoreGraphics
import CoreVideo
import Foundation
import ImageIO
import Vision

/// Finds the eyes with Apple's Vision face landmarks, for `roiSource` =
/// `"vision"`. Experimental and off by default: it is only used when the
/// engine asks for it.
///
/// Vision is slow compared with the frame interval, so it runs at most a few
/// times a second and the last answer is reused in between. Used from one
/// queue only (the stream's encode queue).
final class VisionEyeLocator {
    struct Eyes {
        /// Normalised buffer coordinates, origin top-left.
        let left: CGPoint
        let right: CGPoint
        let t: Double
    }

    private static let interval = 0.2
    private static let maxAge = 1.0
    private static let retryDelay = 0.8

    private var lastRun = -Double.infinity
    private var last: Eyes?
    /// The orientation that last found a face. The buffer is landscape and
    /// the phone may be mounted either way up, so all four are tried.
    private var orientation: CGImagePropertyOrientation = .up

    /// The person's eyes in normalised buffer coordinates, or nil if no face
    /// was found recently.
    func locate(_ pixelBuffer: CVPixelBuffer, t: Double) -> Eyes? {
        if t - lastRun >= Self.interval {
            lastRun = t
            if let found = detect(pixelBuffer, t: t) {
                last = found
            } else {
                // Trying every orientation is costly: wait longer before
                // the next attempt when no face is in view.
                lastRun = t + Self.retryDelay
            }
        }
        guard let eyes = last, abs(t - eyes.t) <= Self.maxAge else { return nil }
        return eyes
    }

    private func detect(_ pixelBuffer: CVPixelBuffer, t: Double) -> Eyes? {
        let all: [CGImagePropertyOrientation] = [.up, .down, .right, .left]
        let order = [orientation] + all.filter { $0 != orientation }
        for candidate in order {
            if let eyes = detect(pixelBuffer, orientation: candidate, t: t) {
                orientation = candidate
                return eyes
            }
        }
        return nil
    }

    private func detect(
        _ pixelBuffer: CVPixelBuffer, orientation: CGImagePropertyOrientation, t: Double
    ) -> Eyes? {
        let request = VNDetectFaceLandmarksRequest()
        let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: orientation, options: [:])
        do {
            try handler.perform([request])
        } catch {
            return nil
        }
        guard let faces = request.results, !faces.isEmpty else { return nil }
        // The largest face is the person at the screen.
        let face = faces.max {
            $0.boundingBox.width * $0.boundingBox.height < $1.boundingBox.width * $1.boundingBox.height
        }
        guard let face = face, let landmarks = face.landmarks else { return nil }

        var centres: [CGPoint] = []
        for region in [landmarks.leftPupil, landmarks.rightPupil] {
            if let point = Self.centre(of: region, in: face.boundingBox) {
                centres.append(point)
            }
        }
        if centres.count < 2 {
            centres = []
            for region in [landmarks.leftEye, landmarks.rightEye] {
                if let point = Self.centre(of: region, in: face.boundingBox) {
                    centres.append(point)
                }
            }
        }
        guard centres.count == 2 else { return nil }

        // Points are in the upright image, origin bottom-left. Facing the
        // camera, the person's own left eye is on the right of an upright,
        // unmirrored picture, whatever Vision calls it.
        let upright = centres.map { CGPoint(x: $0.x, y: 1 - $0.y) }
        let sorted = upright.sorted { $0.x < $1.x }
        let left = Self.toBuffer(sorted[1], orientation: orientation)
        let right = Self.toBuffer(sorted[0], orientation: orientation)
        return Eyes(left: left, right: right, t: t)
    }

    /// Mean of a landmark region, in normalised image coordinates.
    private static func centre(of region: VNFaceLandmarkRegion2D?, in box: CGRect) -> CGPoint? {
        guard let region = region, region.pointCount > 0 else { return nil }
        var sumX = 0.0
        var sumY = 0.0
        for point in region.normalizedPoints {
            sumX += Double(point.x)
            sumY += Double(point.y)
        }
        let count = Double(region.pointCount)
        return CGPoint(
            x: box.minX + CGFloat(sumX / count) * box.width,
            y: box.minY + CGFloat(sumY / count) * box.height
        )
    }

    /// Maps a point in the upright image (origin top-left) back to the
    /// buffer as delivered (origin top-left).
    private static func toBuffer(_ point: CGPoint, orientation: CGImagePropertyOrientation) -> CGPoint {
        switch orientation {
        case .down:
            return CGPoint(x: 1 - point.x, y: 1 - point.y)
        case .right:
            return CGPoint(x: point.y, y: 1 - point.x)
        case .left:
            return CGPoint(x: 1 - point.y, y: point.x)
        default:
            return point
        }
    }
}
