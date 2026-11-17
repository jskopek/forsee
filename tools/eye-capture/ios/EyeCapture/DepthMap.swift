import AVFoundation
import CoreVideo
import Foundation

/// A depth map from the TrueDepth camera (ARKit) or the LiDAR scanner, in
/// metres, with the time it was captured. The map covers the same field of
/// view as the video buffer, in the same (landscape sensor) orientation, at a
/// much lower resolution.
struct DepthSample {
    let data: AVDepthData
    let t: Double
    let source: String
}

enum DepthMap {
    /// The map as float32 metres. Nil if it cannot be converted.
    static func metres(_ depth: AVDepthData) -> CVPixelBuffer? {
        let converted: AVDepthData
        if depth.depthDataType == kCVPixelFormatType_DepthFloat32 {
            converted = depth
        } else {
            converted = depth.converting(toDepthDataType: kCVPixelFormatType_DepthFloat32)
        }
        let buffer = converted.depthDataMap
        guard CVPixelBufferGetPixelFormatType(buffer) == kCVPixelFormatType_DepthFloat32 else {
            return nil
        }
        return buffer
    }

    /// Packs the map row by row as little-endian float32, without row padding.
    static func packed(_ buffer: CVPixelBuffer) -> (data: Data, width: Int, height: Int)? {
        let width = CVPixelBufferGetWidth(buffer)
        let height = CVPixelBufferGetHeight(buffer)
        guard width > 0, height > 0 else { return nil }
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(buffer) else { return nil }
        let rowBytes = CVPixelBufferGetBytesPerRow(buffer)
        let packedRow = width * MemoryLayout<Float32>.size
        guard rowBytes >= packedRow else { return nil }
        var data = Data(count: packedRow * height)
        data.withUnsafeMutableBytes { (output: UnsafeMutableRawBufferPointer) in
            guard let destination = output.baseAddress else { return }
            for row in 0..<height {
                memcpy(destination + row * packedRow, base + row * rowBytes, packedRow)
            }
        }
        // iOS devices are little-endian, so the bytes are already in wire order.
        return (data, width, height)
    }

    /// Median of the valid depths in a small window around a point given in
    /// normalised coordinates (0...1 from the top-left). Nil if none is valid.
    static func median(_ buffer: CVPixelBuffer, x: Double, y: Double, radius: Int = 2) -> Double? {
        let width = CVPixelBufferGetWidth(buffer)
        let height = CVPixelBufferGetHeight(buffer)
        guard width > 0, height > 0, x.isFinite, y.isFinite else { return nil }
        let centerX = min(max(Int(x * Double(width)), 0), width - 1)
        let centerY = min(max(Int(y * Double(height)), 0), height - 1)

        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(buffer) else { return nil }
        let rowBytes = CVPixelBufferGetBytesPerRow(buffer)

        var values: [Float32] = []
        for row in max(centerY - radius, 0)...min(centerY + radius, height - 1) {
            let pointer = (base + row * rowBytes).assumingMemoryBound(to: Float32.self)
            for column in max(centerX - radius, 0)...min(centerX + radius, width - 1) {
                let value = pointer[column]
                if value.isFinite, value > 0 {
                    values.append(value)
                }
            }
        }
        guard !values.isEmpty else { return nil }
        values.sort()
        return Double(values[values.count / 2])
    }
}
