import AVFoundation
import Foundation

/// Writes one segment: an HEVC video plus a CSV with one row per video frame.
///
/// Row N of the CSV describes frame N of the video. The `t` column is the
/// frame's capture time on the phone clock (seconds since boot), which is the
/// same clock the controller page synchronises to.
///
/// Used from the frame queue only.
final class SegmentRecorder {
    let name: String
    let movieURL: URL
    let width: Int
    let height: Int
    let bitrate: Int

    private let writer: AVAssetWriter
    private let input: AVAssetWriterInput
    private let adaptor: AVAssetWriterInputPixelBufferAdaptor
    private let csv: FileHandle
    private var csvBuffer = Data()
    private var started = false
    private var lastTime = CMTime.invalid

    private(set) var framesWritten = 0
    private(set) var framesSkipped = 0
    private(set) var firstFrameTime: Double?
    private(set) var lastFrameTime: Double?

    init(
        directory: URL, name: String, width: Int, height: Int, fps: Double, columns: [String]
    ) throws {
        let movieURL = directory.appendingPathComponent("\(name).mov")
        let writer = try AVAssetWriter(outputURL: movieURL, fileType: .mov)

        // About 0.2 bits per pixel: roughly 50 Mbit/s for 4K at 30 fps. High on
        // purpose, so fine iris detail survives compression.
        let rate = max(fps, 1)
        let bitrate = min(max(Int(Double(width * height) * rate * 0.2), 4_000_000), 120_000_000)
        let compression: [String: Any] = [
            AVVideoAverageBitRateKey: bitrate,
            AVVideoExpectedSourceFrameRateKey: Int(rate.rounded()),
            AVVideoMaxKeyFrameIntervalKey: Int(rate.rounded()),
            // No reordering, so decode order equals capture order.
            AVVideoAllowFrameReorderingKey: false,
        ]
        let settings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.hevc,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: compression,
        ]
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        input.expectsMediaDataInRealTime = true
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: input, sourcePixelBufferAttributes: nil
        )
        guard writer.canAdd(input) else {
            throw NSError(
                domain: "EyeCapture", code: 3,
                userInfo: [NSLocalizedDescriptionKey: "The video writer rejected the input"]
            )
        }
        writer.add(input)

        let csvURL = directory.appendingPathComponent("\(name).frames.csv")
        let header = (["frame", "t"] + columns).joined(separator: ",") + "\n"
        FileManager.default.createFile(atPath: csvURL.path, contents: Data(header.utf8))
        let csv = try FileHandle(forWritingTo: csvURL)
        try csv.seekToEnd()

        self.name = name
        self.movieURL = movieURL
        self.width = width
        self.height = height
        self.bitrate = bitrate
        self.writer = writer
        self.input = input
        self.adaptor = adaptor
        self.csv = csv
    }

    func append(_ pixelBuffer: CVPixelBuffer, time: CMTime, values: [Double]) {
        if !started {
            guard writer.startWriting() else {
                framesSkipped += 1
                return
            }
            writer.startSession(atSourceTime: time)
            started = true
        }
        // Timestamps must increase, and the writer must be able to keep up.
        if lastTime.isValid, CMTimeCompare(time, lastTime) <= 0 {
            framesSkipped += 1
            return
        }
        guard writer.status == .writing, input.isReadyForMoreMediaData,
              adaptor.append(pixelBuffer, withPresentationTime: time)
        else {
            framesSkipped += 1
            return
        }
        lastTime = time

        let seconds = CMTimeGetSeconds(time)
        if firstFrameTime == nil { firstFrameTime = seconds }
        lastFrameTime = seconds

        var line = "\(framesWritten)," + String(format: "%.6f", seconds)
        for value in values {
            line += ","
            if value.isFinite {
                line += String(format: "%.9g", value)
            }
        }
        line += "\n"
        csvBuffer.append(Data(line.utf8))
        if csvBuffer.count > 64 * 1024 {
            flushCSV()
        }
        framesWritten += 1
    }

    /// Finishes the files. `completion` receives an error message, or nil on success.
    func finish(completion: @escaping (String?) -> Void) {
        flushCSV()
        try? csv.close()
        guard started, writer.status == .writing else {
            completion(writer.error?.localizedDescription ?? "no frames were written")
            return
        }
        input.markAsFinished()
        let writer = self.writer
        writer.finishWriting {
            completion(writer.status == .completed ? nil : writer.error?.localizedDescription)
        }
    }

    private func flushCSV() {
        guard !csvBuffer.isEmpty else { return }
        try? csv.write(contentsOf: csvBuffer)
        csvBuffer.removeAll(keepingCapacity: true)
    }
}
