import CoreMotion
import Foundation

/// Logs the phone's own motion while recording. Gravity gives the tilt of the
/// mount, and the rotation rate shows whether the phone was bumped mid-run.
final class MotionLogger {
    private let manager = CMMotionManager()
    private let queue = OperationQueue()
    private let lock = NSLock()

    // Guarded by `lock`.
    private var handle: FileHandle?
    private var latestGravity: [Double]?
    private var latestRotation: [Double]?

    func start() {
        guard manager.isDeviceMotionAvailable, !manager.isDeviceMotionActive else { return }
        queue.maxConcurrentOperationCount = 1
        manager.deviceMotionUpdateInterval = 1.0 / 50.0
        manager.startDeviceMotionUpdates(to: queue) { [weak self] motion, _ in
            guard let self = self, let motion = motion else { return }
            let gravity = [motion.gravity.x, motion.gravity.y, motion.gravity.z]
            let rotation = [motion.rotationRate.x, motion.rotationRate.y, motion.rotationRate.z]
            let line = String(
                format: "%.6f,%.5f,%.5f,%.5f,%.5f,%.5f,%.5f,%.5f,%.5f,%.5f\n",
                motion.timestamp,
                motion.gravity.x, motion.gravity.y, motion.gravity.z,
                motion.rotationRate.x, motion.rotationRate.y, motion.rotationRate.z,
                motion.userAcceleration.x, motion.userAcceleration.y, motion.userAcceleration.z
            )
            self.lock.lock()
            self.latestGravity = gravity
            self.latestRotation = rotation
            let handle = self.handle
            self.lock.unlock()
            try? handle?.write(contentsOf: Data(line.utf8))
        }
    }

    /// Gravity in the phone's frame (x right, y up, z out of the screen), in g.
    func gravity() -> [Double]? {
        lock.lock()
        defer { lock.unlock() }
        return latestGravity
    }

    /// Rotation rate in the same frame as gravity, in rad/s.
    func rotationRate() -> [Double]? {
        lock.lock()
        defer { lock.unlock() }
        return latestRotation
    }

    func beginLog(url: URL) {
        let header = "t,gravity_x,gravity_y,gravity_z,rotation_x,rotation_y,rotation_z,accel_x,accel_y,accel_z\n"
        FileManager.default.createFile(atPath: url.path, contents: Data(header.utf8))
        guard let newHandle = try? FileHandle(forWritingTo: url) else { return }
        _ = try? newHandle.seekToEnd()
        lock.lock()
        let old = handle
        handle = newHandle
        lock.unlock()
        try? old?.close()
    }

    func endLog() {
        lock.lock()
        let old = handle
        handle = nil
        lock.unlock()
        // Close on the motion queue so a write in flight finishes first.
        queue.addOperation {
            try? old?.close()
        }
    }
}
