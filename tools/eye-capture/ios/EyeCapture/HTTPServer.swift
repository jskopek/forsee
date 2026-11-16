import Foundation
import Network

/// A parsed HTTP request.
struct HTTPRequest {
    let method: String
    let path: String
    let query: [String: String]
    let body: Data

    /// The body as a JSON object, or an empty object if it is not one.
    var json: [String: Any] {
        guard !body.isEmpty,
              let object = try? JSONSerialization.jsonObject(with: body),
              let dictionary = object as? [String: Any]
        else { return [:] }
        return dictionary
    }

    /// The body as a JSON object; an empty body is an empty object. Nil when
    /// the body is something else, so routes can answer 400.
    var jsonObject: [String: Any]? {
        guard !body.isEmpty else { return [:] }
        guard let object = try? JSONSerialization.jsonObject(with: body) else { return nil }
        return object as? [String: Any]
    }
}

struct HTTPResponse {
    enum Body {
        case data(Data)
        /// Streamed from disk in chunks, so large videos never sit in memory.
        case file(URL)
        /// A long-lived response with no length: the headers are sent, then
        /// the handler gets a writer that sends messages until either side
        /// closes. Called on the server queue; it must not block.
        case stream((StreamWriter) -> Void)
    }

    var status: Int = 200
    var contentType: String = "application/json"
    var body: Body = .data(Data())

    static func json(_ object: Any, status: Int = 200) -> HTTPResponse {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        else {
            return HTTPResponse(
                status: 500,
                contentType: "application/json",
                body: .data(Data("{\"error\":\"response was not valid JSON\"}".utf8))
            )
        }
        return HTTPResponse(status: status, contentType: "application/json", body: .data(data))
    }

    static func error(_ status: Int, _ message: String) -> HTTPResponse {
        json(["error": message], status: status)
    }
}

/// A very small HTTP/1.1 server on top of Network.framework. It supports
/// keep-alive, request bodies with Content-Length, and streamed file responses.
/// That is all the controller page and the download script need.
final class HTTPServer {
    typealias Handler = (HTTPRequest, @escaping (HTTPResponse) -> Void) -> Void

    private let listener: NWListener
    private let queue = DispatchQueue(label: "eyecapture.http")
    private let handler: Handler
    private var connections: [ObjectIdentifier: HTTPConnection] = [:]

    /// Called on the server queue if the listener fails (for example, port in use).
    var onFailure: ((String) -> Void)?

    init(port: UInt16, handler: @escaping Handler) throws {
        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        guard let nwPort = NWEndpoint.Port(rawValue: port) else {
            throw NSError(
                domain: "EyeCapture", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Invalid port \(port)"]
            )
        }
        self.listener = try NWListener(using: parameters, on: nwPort)
        self.handler = handler
    }

    func start() {
        listener.stateUpdateHandler = { [weak self] state in
            if case .failed(let error) = state {
                self?.onFailure?("\(error)")
            }
        }
        listener.newConnectionHandler = { [weak self] nwConnection in
            guard let self = self else { return }
            let connection = HTTPConnection(
                connection: nwConnection,
                queue: self.queue,
                handler: self.handler,
                onClose: { [weak self] id in self?.connections[id] = nil }
            )
            self.connections[ObjectIdentifier(connection)] = connection
            connection.start()
        }
        listener.start(queue: queue)
    }
}

/// One client connection. All of its work happens on the server queue.
private final class HTTPConnection {
    private let connection: NWConnection
    private let queue: DispatchQueue
    private let handler: HTTPServer.Handler
    private let onClose: (ObjectIdentifier) -> Void

    private var buffer = Data()
    private var isHandlingRequest = false
    private var closeAfterResponse = false
    private var isClosed = false
    private var streamWriter: StreamWriter?

    private static let headerTerminator = Data("\r\n\r\n".utf8)
    private static let maxHeaderBytes = 64 * 1024
    private static let maxBodyBytes = 16 * 1024 * 1024
    private static let fileChunkBytes = 512 * 1024

    init(
        connection: NWConnection,
        queue: DispatchQueue,
        handler: @escaping HTTPServer.Handler,
        onClose: @escaping (ObjectIdentifier) -> Void
    ) {
        self.connection = connection
        self.queue = queue
        self.handler = handler
        self.onClose = onClose
    }

    func start() {
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .failed, .cancelled:
                self?.didClose()
            default:
                break
            }
        }
        connection.start(queue: queue)
        receive()
    }

    private func receive() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) {
            [weak self] data, _, isComplete, error in
            guard let self = self, !self.isClosed else { return }
            if let data = data, !data.isEmpty {
                if self.streamWriter == nil {
                    self.buffer.append(data)
                    self.processBuffer()
                }
                // While streaming, anything the client sends is ignored.
            }
            if error != nil {
                self.close()
                return
            }
            if isComplete, self.streamWriter != nil {
                self.close()
                return
            }
            if isComplete {
                // The client finished sending. Answer any request in flight, then close.
                if self.isHandlingRequest {
                    self.closeAfterResponse = true
                } else {
                    self.close()
                }
                return
            }
            self.receive()
        }
    }

    private func processBuffer() {
        guard !isHandlingRequest, !isClosed else { return }
        guard let terminator = buffer.range(of: Self.headerTerminator) else {
            if buffer.count > Self.maxHeaderBytes { close() }
            return
        }

        let headerData = buffer.subdata(in: buffer.startIndex..<terminator.lowerBound)
        guard let headerText = String(data: headerData, encoding: .utf8) else {
            close()
            return
        }
        let lines = headerText.components(separatedBy: "\r\n")
        let requestLine = lines[0].split(separator: " ")
        guard requestLine.count >= 2 else {
            close()
            return
        }

        var contentLength = 0
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let name = line[..<colon].lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            if name == "content-length" {
                contentLength = Int(value) ?? 0
            }
        }
        guard contentLength >= 0, contentLength <= Self.maxBodyBytes else {
            close()
            return
        }

        let bodyStart = terminator.upperBound
        let bodyEnd = bodyStart + contentLength
        guard buffer.endIndex >= bodyEnd else { return }  // Wait for the rest of the body.

        let body = buffer.subdata(in: bodyStart..<bodyEnd)
        buffer.removeSubrange(buffer.startIndex..<bodyEnd)

        let method = String(requestLine[0]).uppercased()
        let target = String(requestLine[1])
        var path = target
        var query: [String: String] = [:]
        if let components = URLComponents(string: "http://phone" + target) {
            path = components.path
            for item in components.queryItems ?? [] {
                query[item.name] = item.value ?? ""
            }
        }

        isHandlingRequest = true
        let request = HTTPRequest(method: method, path: path, query: query, body: body)
        handler(request) { [weak self] response in
            guard let self = self else { return }
            self.queue.async { self.send(response) }
        }
    }

    private func send(_ response: HTTPResponse) {
        guard !isClosed else { return }

        var length = 0
        var inlineBody = Data()
        var fileHandle: FileHandle?
        switch response.body {
        case .stream(let opener):
            sendStream(response, opener: opener)
            return
        case .data(let data):
            inlineBody = data
            length = data.count
        case .file(let url):
            let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
            guard let size = attributes?[.size] as? NSNumber,
                  let handle = try? FileHandle(forReadingFrom: url)
            else {
                send(.error(404, "file not found"))
                return
            }
            fileHandle = handle
            length = size.intValue
        }

        var head = "HTTP/1.1 \(response.status) \(Self.reason(response.status))\r\n"
        head += "Content-Type: \(response.contentType)\r\n"
        head += "Content-Length: \(length)\r\n"
        head += "Cache-Control: no-store\r\n"
        head += "Connection: keep-alive\r\n"
        head += "\r\n"

        var first = Data(head.utf8)
        if fileHandle == nil {
            first.append(inlineBody)
        }
        connection.send(content: first, completion: .contentProcessed { [weak self] error in
            guard let self = self else { return }
            if error != nil {
                try? fileHandle?.close()
                self.close()
                return
            }
            if let handle = fileHandle {
                self.sendFile(handle)
            } else {
                self.responseFinished()
            }
        })
    }

    /// Sends the headers of a streamed response, then hands the connection to
    /// a `StreamWriter`. The connection never serves another request.
    private func sendStream(_ response: HTTPResponse, opener: @escaping (StreamWriter) -> Void) {
        var head = "HTTP/1.1 \(response.status) \(Self.reason(response.status))\r\n"
        head += "Content-Type: \(response.contentType)\r\n"
        head += "Cache-Control: no-store\r\n"
        head += "Connection: close\r\n"
        head += "\r\n"
        buffer.removeAll()
        let writer = StreamWriter(connection: connection)
        streamWriter = writer
        connection.send(content: Data(head.utf8), completion: .contentProcessed { [weak self] error in
            guard let self = self else { return }
            if error != nil {
                self.close()
                return
            }
            guard !self.isClosed else { return }
            opener(writer)
        })
    }

    private func sendFile(_ handle: FileHandle) {
        guard !isClosed else {
            try? handle.close()
            return
        }
        let chunk: Data? = try? handle.read(upToCount: Self.fileChunkBytes)
        guard let data = chunk, !data.isEmpty else {
            try? handle.close()
            responseFinished()
            return
        }
        connection.send(content: data, completion: .contentProcessed { [weak self] error in
            guard let self = self else {
                try? handle.close()
                return
            }
            if error != nil {
                try? handle.close()
                self.close()
                return
            }
            self.sendFile(handle)
        })
    }

    private func responseFinished() {
        isHandlingRequest = false
        if closeAfterResponse {
            close()
        } else {
            processBuffer()  // A second request may already be buffered.
        }
    }

    private func close() {
        guard !isClosed else { return }
        connection.cancel()
        didClose()
    }

    private func didClose() {
        guard !isClosed else { return }
        isClosed = true
        streamWriter?.connectionDidClose()
        onClose(ObjectIdentifier(self))
    }

    private static func reason(_ status: Int) -> String {
        switch status {
        case 200: return "OK"
        case 400: return "Bad Request"
        case 404: return "Not Found"
        case 409: return "Conflict"
        case 503: return "Service Unavailable"
        default: return "Error"
        }
    }
}

/// Writes framed messages to one streaming client. Thread-safe: messages can
/// be sent from any queue.
///
/// Back-pressure: at most one message is being written at a time. A droppable
/// message (a video frame) is refused while another is in flight, so frames
/// are never queued. Reliable messages (hello, status) wait their turn in a
/// short queue; a client that lets that queue fill up is disconnected.
final class StreamWriter {
    private let connection: NWConnection
    private let lock = NSLock()
    private static let maxPending = 16

    // Guarded by `lock`.
    private var writing = false
    private var pending: [Data] = []
    private var closed = false
    private var closeHandlers: [() -> Void] = []

    fileprivate init(connection: NWConnection) {
        self.connection = connection
    }

    /// True while a message is being written, or after the client went away.
    var isBusy: Bool {
        lock.lock()
        defer { lock.unlock() }
        return writing || closed
    }

    var isOpen: Bool {
        lock.lock()
        defer { lock.unlock() }
        return !closed
    }

    /// Runs once when the stream ends, whichever side ends it. Runs at once if
    /// it has already ended.
    func onClose(_ handler: @escaping () -> Void) {
        lock.lock()
        if closed {
            lock.unlock()
            handler()
            return
        }
        closeHandlers.append(handler)
        lock.unlock()
    }

    /// Sends the message unless another is still being written. Returns
    /// whether it was accepted.
    @discardableResult
    func sendDroppable(_ data: Data) -> Bool {
        lock.lock()
        guard !closed, !writing else {
            lock.unlock()
            return false
        }
        writing = true
        lock.unlock()
        write(data)
        return true
    }

    /// Sends the message after any in flight. Never dropped.
    func sendReliable(_ data: Data) {
        lock.lock()
        guard !closed else {
            lock.unlock()
            return
        }
        if writing {
            if pending.count >= Self.maxPending {
                lock.unlock()
                close()
                return
            }
            pending.append(data)
            lock.unlock()
            return
        }
        writing = true
        lock.unlock()
        write(data)
    }

    /// Ends the stream and closes the connection.
    func close() {
        finish()
        connection.cancel()
    }

    fileprivate func connectionDidClose() {
        finish()
    }

    private func finish() {
        lock.lock()
        guard !closed else {
            lock.unlock()
            return
        }
        closed = true
        pending.removeAll()
        let handlers = closeHandlers
        closeHandlers.removeAll()
        lock.unlock()
        for handler in handlers {
            handler()
        }
    }

    private func write(_ data: Data) {
        connection.send(content: data, completion: .contentProcessed { [weak self] error in
            guard let self = self else { return }
            if error != nil {
                self.close()
                return
            }
            self.lock.lock()
            if self.closed {
                self.lock.unlock()
                return
            }
            if self.pending.isEmpty {
                self.writing = false
                self.lock.unlock()
                return
            }
            let next = self.pending.removeFirst()
            self.lock.unlock()
            self.write(next)
        })
    }
}
