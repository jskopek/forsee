import AVFoundation
import Foundation
import QuartzCore
import SwiftUI
import UIKit

/// Starts the web server and routes its requests to the camera and the
/// session store. The controller page on the computer drives everything
/// through these routes; the phone's own screen only shows status.
final class AppModel: ObservableObject {
    static let port: UInt16 = 8080
    static let appVersion = "0.2"

    @Published var addresses: [String] = []
    @Published var statusLine = "Starting…"
    @Published var streamLine = ""
    @Published var isRecording = false
    @Published var preview: UIImage?
    @Published var lastError: String?

    private let capture = CaptureCoordinator()
    private let store = SessionStore()
    private var server: HTTPServer?
    private var timer: Timer?
    private var started = false

    private let systemLock = NSLock()
    private var systemInfo: [String: Any] = [:]

    // HTTP queue only.
    private var cameras: [[String: Any]]?

    func start() {
        guard !started else { return }
        started = true

        UIApplication.shared.isIdleTimerDisabled = true
        UIDevice.current.isBatteryMonitoringEnabled = true
        AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
            if !granted {
                DispatchQueue.main.async {
                    self?.lastError = "Camera access was denied. Allow it in Settings."
                }
            }
        }
        capture.startMotion()

        do {
            let server = try HTTPServer(port: Self.port) { [weak self] request, respond in
                guard let self = self else {
                    respond(.error(503, "The app is shutting down"))
                    return
                }
                self.route(request, respond: respond)
            }
            server.onFailure = { [weak self] message in
                DispatchQueue.main.async {
                    self?.lastError = "The web server stopped: \(message)"
                }
            }
            server.start()
            self.server = server
        } catch {
            lastError = "Could not start the web server: \(error.localizedDescription)"
        }

        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            self?.refresh()
        }
        refresh()
    }

    /// Main thread. Updates the phone's own screen and the cached system facts.
    private func refresh() {
        addresses = DeviceInfo.ipv4Addresses().map { "http://\($0):\(Self.port)" }
        statusLine = capture.summaryLine()
        streamLine = capture.streamer.summaryLine()
        isRecording = capture.isRecording
        if let data = capture.previewJPEG(.full) {
            preview = UIImage(data: data)
        } else {
            preview = nil
        }

        let info = DeviceInfo.systemSnapshot()
        systemLock.lock()
        systemInfo = info
        systemLock.unlock()
    }

    // MARK: - Routes (HTTP queue)

    private func route(_ request: HTTPRequest, respond: @escaping (HTTPResponse) -> Void) {
        switch (request.method, request.path) {
        case ("GET", "/"), ("GET", "/index.html"):
            respond(controllerPage())

        case ("GET", "/api/time"):
            respond(.json(["t": CACurrentMediaTime()]))

        case ("GET", "/api/status"):
            respond(.json(status()))

        case ("POST", "/api/configure"):
            let body = request.json
            let cameraId = body["cameraId"] as? String ?? ""
            let maxWidth = (body["maxWidth"] as? NSNumber)?.intValue ?? 3840
            let fps = (body["fps"] as? NSNumber)?.doubleValue ?? 30
            let zoom = (body["zoom"] as? NSNumber)?.doubleValue ?? 1
            do {
                try capture.configure(cameraId: cameraId, maxWidth: maxWidth, fps: fps, zoom: zoom)
                respond(.json(status()))
            } catch {
                respond(.error(400, Self.describe(error)))
            }

        case ("POST", "/api/stop"):
            if capture.isRecording {
                respond(.error(409, "Stop the recording first"))
            } else {
                capture.stop()
                respond(.json(status()))
            }

        case ("POST", "/api/focus"):
            let body = request.json
            var point: CGPoint?
            if let x = (body["x"] as? NSNumber)?.doubleValue,
               let y = (body["y"] as? NSNumber)?.doubleValue {
                point = CGPoint(x: min(max(x, 0), 1), y: min(max(y, 0), 1))
            }
            let locked = (body["locked"] as? NSNumber)?.boolValue
            do {
                try capture.setFocus(locked: locked, point: point)
                respond(.json(status()))
            } catch {
                respond(.error(400, Self.describe(error)))
            }

        case ("GET", "/stream"):
            // Built here, on the HTTP queue, because the camera list lives here.
            let response = HTTPResponse(
                status: 200,
                contentType: "application/x-pgz1",
                body: .stream { [weak self] writer in
                    guard let self = self else {
                        writer.close()
                        return
                    }
                    self.capture.streamer.attach(writer, hello: self.hello())
                }
            )
            respond(response)

        case ("GET", "/api/stream/config"):
            respond(.json(capture.streamer.configJSON))

        case ("POST", "/api/stream/config"):
            guard let body = request.jsonObject else {
                respond(.error(400, "The body must be a JSON object"))
                return
            }
            do {
                respond(.json(try capture.streamer.updateConfig(body)))
            } catch {
                respond(.error(400, Self.describe(error)))
            }

        case ("POST", "/api/zoom"):
            guard let body = request.jsonObject,
                  let zoom = body["zoom"] as? NSNumber,
                  CFGetTypeID(zoom) != CFBooleanGetTypeID()
            else {
                respond(.error(400, "The body must be {\"zoom\": number}"))
                return
            }
            do {
                try capture.setZoom(zoom.doubleValue)
                respond(.json(status()))
            } catch {
                respond(.error(Self.statusCode(for: error), Self.describe(error)))
            }

        case ("POST", "/api/lens"):
            guard let body = request.jsonObject else {
                respond(.error(400, "The body must be a JSON object"))
                return
            }
            do {
                try capture.setLens(body)
                respond(.json(status()))
            } catch {
                respond(.error(Self.statusCode(for: error), Self.describe(error)))
            }

        case ("POST", "/api/session/start"):
            let body = request.json
            var meta = body["meta"] as? [String: Any] ?? [:]
            systemLock.lock()
            meta["phone"] = systemInfo
            systemLock.unlock()
            meta["app"] = ["name": "EyeCapture", "version": Self.appVersion]
            meta["createdAt"] = ISO8601DateFormatter().string(from: Date())
            do {
                let id = try store.createSession(label: body["label"] as? String ?? "", meta: meta)
                respond(.json(["sessionId": id]))
            } catch {
                respond(.error(400, Self.describe(error)))
            }

        case ("POST", "/api/events"):
            let body = request.json
            let sessionId = body["sessionId"] as? String ?? ""
            let events = body["events"] as? [[String: Any]] ?? []
            do {
                try store.appendEvents(
                    sessionId: sessionId, events: events, receivedAt: CACurrentMediaTime()
                )
                respond(.json(["stored": events.count]))
            } catch {
                respond(.error(400, Self.describe(error)))
            }

        case ("POST", "/api/record/start"):
            let body = request.json
            guard let directory = store.directory(for: body["sessionId"] as? String ?? "") else {
                respond(.error(400, "Unknown session"))
                return
            }
            guard !capture.isRecording else {
                respond(.error(409, "Already recording"))
                return
            }
            let label = body["segment"] as? String ?? "segment"
            let name = store.uniqueSegmentName(in: directory, base: label)
            capture.startRecording(directory: directory, name: name, label: label)
            respond(.json(["segment": name]))

        case ("POST", "/api/record/stop"):
            capture.stopRecording { summary in
                respond(.json(summary))
            }

        case ("GET", "/preview.jpg"):
            let kind: PreviewKind = request.query["kind"] == "crop" ? .crop : .full
            var crop: CropSpec?
            if kind == .crop {
                var spec = CropSpec()
                if let value = Double(request.query["cx"] ?? "") { spec.centerX = min(max(value, 0), 1) }
                if let value = Double(request.query["cy"] ?? "") { spec.centerY = min(max(value, 0), 1) }
                if let value = Double(request.query["w"] ?? "") { spec.width = value }
                crop = spec
            }
            if let data = capture.previewJPEG(kind, crop: crop) {
                respond(HTTPResponse(status: 200, contentType: "image/jpeg", body: .data(data)))
            } else {
                respond(.error(503, "No preview yet"))
            }

        case ("GET", "/api/sessions"):
            respond(.json(["sessions": store.list()]))

        case ("POST", "/api/sessions/delete"):
            let id = request.json["sessionId"] as? String ?? ""
            do {
                try store.delete(sessionId: id)
                respond(.json(["sessions": store.list()]))
            } catch {
                respond(.error(400, Self.describe(error)))
            }

        default:
            if request.method == "GET", request.path.hasPrefix("/files/") {
                respond(file(for: request.path))
            } else {
                respond(.error(404, "No such route"))
            }
        }
    }

    private func status() -> [String: Any] {
        if cameras == nil {
            cameras = capture.cameraList()
        }
        systemLock.lock()
        let system = systemInfo
        systemLock.unlock()
        return [
            "app": ["name": "EyeCapture", "version": Self.appVersion],
            "time": CACurrentMediaTime(),
            "system": system,
            "cameras": cameras ?? [],
            "state": capture.statusJSON(),
        ]
    }

    /// The first message on `/stream`.
    private func hello() -> [String: Any] {
        let current = status()
        systemLock.lock()
        let system = systemInfo
        systemLock.unlock()
        return [
            "type": "hello",
            "protocol": 1,
            "t": CACurrentMediaTime(),
            "app": ["name": "EyeCapture", "version": Self.appVersion],
            "device": [
                "model": system["model"] as? String ?? DeviceInfo.modelIdentifier(),
                "system": system["system"] as? String ?? "",
            ],
            "capabilities": capture.streamCapabilities(),
            "cameras": current["cameras"] ?? [Any](),
            "streamConfig": capture.streamer.configJSON,
            "state": current["state"] ?? [String: Any](),
        ]
    }

    private func controllerPage() -> HTTPResponse {
        guard let url = Bundle.main.url(forResource: "controller", withExtension: "html"),
              let data = try? Data(contentsOf: url)
        else {
            return .error(404, "controller.html is missing from the app bundle")
        }
        return HTTPResponse(status: 200, contentType: "text/html; charset=utf-8", body: .data(data))
    }

    /// Serves /files/<session>/<file>.
    private func file(for path: String) -> HTTPResponse {
        let parts = path.split(separator: "/").map { String($0) }
        guard parts.count == 3,
              let url = store.fileURL(sessionId: parts[1], name: parts[2])
        else {
            return .error(404, "No such file")
        }
        return HTTPResponse(
            status: 200, contentType: SessionStore.contentType(for: parts[2]), body: .file(url)
        )
    }

    private static func statusCode(for error: Error) -> Int {
        if let captureError = error as? CaptureError, case .notRunningCamera = captureError {
            return 409
        }
        return 400
    }

    private static func describe(_ error: Error) -> String {
        if let captureError = error as? CaptureError {
            return captureError.description
        }
        return error.localizedDescription
    }
}
