import CoreVideo
import Darwin
import Foundation
import SimulatorPrivateBridge

final class HelperSession: @unchecked Sendable {
  private let input: FileHandle
  private let output: FileHandle
  private let developerDir: String?
  private let decoder = FramedIO.Decoder()
  private var generation: UInt64?
  private var token: String?
  private var privateContext: SHPrivateContextRef?
  private var capabilities = SHCapabilityReport()
  private var videoSequence: UInt32 = 0
  private let encoder = H264Session()
  private let videoLock = NSLock()
  private var videoURLSession: URLSession?
  private var videoTask: URLSessionWebSocketTask?
  private var _videoHandler: ((Data) -> Void)?

  var videoHandler: ((Data) -> Void)? {
    get {
      videoLock.lock()
      defer { videoLock.unlock() }
      return _videoHandler
    }
    set {
      videoLock.lock()
      _videoHandler = newValue
      videoLock.unlock()
    }
  }

  init(input: FileHandle, output: FileHandle, developerDir: String? = nil) {
    self.input = input
    self.output = output
    self.developerDir = developerDir
    encoder.onEncoded = { [weak self] encoded in
      self?.emitVideo(encoded)
    }
  }

  deinit {
    encoder.onEncoded = nil
    closeVideo()
    if let privateContext {
      var error: UnsafeMutablePointer<CChar>?
      _ = SHStopCapture(privateContext, &error)
      if let error { SHFreeError(error) }
      SHDestroyPrivateContext(privateContext)
    }
  }

  func run() throws {
    defer { closeVideo() }
    var buffer = [UInt8](repeating: 0, count: 4096)
    while true {
      let n = buffer.withUnsafeMutableBytes { raw in
        Darwin.read(input.fileDescriptor, raw.baseAddress, raw.count)
      }
      if n == 0 {
        return
      }
      if n < 0 {
        if errno == EINTR {
          continue
        }
        throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
      }
      let chunk = Data(buffer[0..<n])
      let bodies = try decoder.append(chunk)
      for body in bodies {
        try handle(body)
      }
    }
  }

  private func handle(_ body: Data) throws {
    let request: ControlRequest
    do {
      request = try ControlProtocol.decodeRequest(body)
    } catch {
      return
    }

    do {
      try ControlProtocol.check(request, generation: generation, token: token)
    } catch ControlProtocolError.generationMismatch {
      try writeResponse(id: request.id, ok: false, error: "generation_mismatch")
      return
    } catch ControlProtocolError.tokenMismatch {
      try writeResponse(id: request.id, ok: false, error: "token_mismatch")
      return
    } catch {
      try writeResponse(id: request.id, ok: false, error: "protocol_error")
      return
    }

    switch request.method {
    case "handshake":
      generation = request.generation
      token = request.token
      ensureContext(udid: jsonString(request.payload["udid"]))
      try writeResponse(
        id: request.id,
        ok: true,
        result: [
          "v": ProtocolLimits.version,
          "capabilities": currentCapabilities(),
        ]
      )
    case "ping":
      try writeResponse(id: request.id, ok: true, result: ["pong": true])
    case "attach":
      guard let udid = jsonString(request.payload["udid"]), !udid.isEmpty else {
        try writeResponse(id: request.id, ok: false, error: "device_missing")
        return
      }
      ensureContext(udid: udid)
      try writeResponse(
        id: request.id,
        ok: true,
        result: ["capabilities": currentCapabilities()]
      )
    case "startStream":
      try writeBridgeResult(id: request.id, ok: startStream(request.payload))
    case "stopStream":
      closeVideo()
      try writeBridgeResult(id: request.id, ok: stopCapture())
    case "requestKeyframe":
      encoder.requestKeyframe()
      encoder.requestJPEGSeed()
      try writeResponse(id: request.id, ok: true)
    case "setBitrate":
      if let bps = jsonUInt64(request.payload["bps"]) ?? jsonUInt64(request.payload["bitrate"]) {
        encoder.setBitrate(Int(bps))
        try writeResponse(id: request.id, ok: true)
      } else {
        try writeResponse(id: request.id, ok: false, error: "protocol_error")
      }
    case "touch":
      try writeBridgeResult(id: request.id, ok: sendTouch(request.payload))
    case "scrollTo":
      try writeBridgeResult(id: request.id, ok: sendScrollTo(request.payload))
    case "key":
      try writeBridgeResult(id: request.id, ok: sendKey(request.payload))
    case "text":
      try writeBridgeResult(id: request.id, ok: sendText(request.payload))
    case "pressButton":
      try writeBridgeResult(id: request.id, ok: pressButton(request.payload))
    case "accessibility":
      try handleAccessibility(request)
    default:
      try writeResponse(id: request.id, ok: false, error: "unknown_method")
    }
  }

  private func writeResponse(id: UInt64, ok: Bool, error: String? = nil, result: [String: Any]? = nil) throws {
    try output.write(
      contentsOf: ControlProtocol.encodeResponse(id: id, ok: ok, error: error, result: result)
    )
  }

  private func writeBridgeResult(id: UInt64, ok: (Bool, String?)) throws {
    if ok.0 {
      try writeResponse(id: id, ok: true)
    } else {
      try writeResponse(id: id, ok: false, error: ok.1 ?? "capability_unavailable")
    }
  }

  private func currentCapabilities() -> [String: Bool] {
    [
      "stream": capabilities.stream,
      "touch": capabilities.touch,
      "keyboard": capabilities.keyboard,
      "hardwareButtons": capabilities.hardwareButtons,
      "accessibility": capabilities.accessibility,
    ]
  }

  private func ensureContext(udid: String?) {
    if let privateContext {
      var error: UnsafeMutablePointer<CChar>?
      _ = SHStopCapture(privateContext, &error)
      if let error { SHFreeError(error) }
      SHDestroyPrivateContext(privateContext)
      self.privateContext = nil
    }
    var report = SHCapabilityReport()
    var error: UnsafeMutablePointer<CChar>?
    let ctx = developerDir.withCStringOrNil { dir in
      udid.withCStringOrNil { id in
        SHCreatePrivateContext(dir, id, &report, &error)
      }
    }
    if let error {
      SHFreeError(error)
    }
    privateContext = ctx
    capabilities = report
  }

  private func startStream(_ payload: [String: Any]) -> (Bool, String?) {
    let urlString = jsonString(payload["url"])
    let videoToken = jsonString(payload["helperToken"]) ?? jsonString(payload["token"])
    let streamGeneration = jsonUInt64(payload["generation"])
    guard let urlString, !urlString.isEmpty,
          let videoToken, !videoToken.isEmpty,
          let streamGeneration
    else {
      return (false, "protocol_error")
    }
    guard let url = LoopbackVideoURL.parse(urlString) else {
      return (false, "protocol_error")
    }
    let connected = connectVideo(url: url, token: videoToken, generation: streamGeneration)
    if !connected.0 {
      return connected
    }
    return startCapture()
  }

  /// Long-lived config for the helper→broker video socket (mostly one-way after auth).
  static func videoSessionConfiguration() -> URLSessionConfiguration {
    let config = URLSessionConfiguration.ephemeral
    // Broker stays silent after auth; do not apply a short request/resource deadline.
    config.timeoutIntervalForRequest = 60 * 60 * 24 * 7
    config.timeoutIntervalForResource = 0
    return config
  }

  private func connectVideo(url: URL, token: String, generation: UInt64) -> (Bool, String?) {
    closeVideo()
    let session = URLSession(configuration: Self.videoSessionConfiguration())
    let task = session.webSocketTask(with: url)
    videoLock.lock()
    videoURLSession = session
    videoTask = task
    videoLock.unlock()
    task.resume()

    let auth: [String: Any] = [
      "token": token,
      "generation": NSNumber(value: generation),
    ]
    guard JSONSerialization.isValidJSONObject(auth),
          let body = try? JSONSerialization.data(withJSONObject: auth),
          let text = String(data: body, encoding: .utf8)
    else {
      closeVideo()
      return (false, "protocol_error")
    }

    let sem = DispatchSemaphore(value: 0)
    let errorBox = VideoSendErrorBox()
    task.send(.string(text)) { error in
      errorBox.error = error
      sem.signal()
    }
    // 5s wait applies only to the initial auth send completion, not the live session.
    let timedOut = sem.wait(timeout: .now() + 5) != .success
    if timedOut || errorBox.error != nil {
      closeVideo()
      return (false, "protocol_error")
    }

    videoHandler = { [weak self] data in
      guard let self else { return }
      self.videoLock.lock()
      let current = self.videoTask
      self.videoLock.unlock()
      current?.send(.data(data)) { _ in }
    }
    pumpVideoReceive(task)
    return (true, nil)
  }

  private func pumpVideoReceive(_ task: URLSessionWebSocketTask) {
    task.receive { [weak self] result in
      guard let self else { return }
      switch result {
      case .failure(let error):
        if Self.isIdleVideoReceiveError(error) {
          self.videoLock.lock()
          let current = self.videoTask
          self.videoLock.unlock()
          if current === task {
            self.pumpVideoReceive(task)
          }
        } else {
          self.closeVideo()
        }
      case .success:
        self.videoLock.lock()
        let current = self.videoTask
        self.videoLock.unlock()
        if current === task {
          self.pumpVideoReceive(task)
        }
      }
    }
  }

  /// Broker silence / request idle must not tear down the outbound video socket.
  private static func isIdleVideoReceiveError(_ error: Error) -> Bool {
    let ns = error as NSError
    return ns.domain == NSURLErrorDomain && ns.code == NSURLErrorTimedOut
  }

  private func closeVideo() {
    videoLock.lock()
    let task = videoTask
    let session = videoURLSession
    videoTask = nil
    videoURLSession = nil
    _videoHandler = nil
    videoLock.unlock()
    task?.cancel(with: .goingAway, reason: nil)
    session?.invalidateAndCancel()
  }

  private func startCapture() -> (Bool, String?) {
    guard let privateContext, capabilities.stream else {
      return (false, "capability_unavailable")
    }
    var error: UnsafeMutablePointer<CChar>?
    let ok = SHStartCapture(privateContext, HelperSession.frameCallback, Unmanaged.passUnretained(self).toOpaque(), &error)
    let message = error.map { String(cString: $0) }
    if let error { SHFreeError(error) }
    encoder.requestKeyframe()
    encoder.requestJPEGSeed()
    return (ok, message)
  }

  private func stopCapture() -> (Bool, String?) {
    guard let privateContext else {
      return (false, "capability_unavailable")
    }
    var error: UnsafeMutablePointer<CChar>?
    let ok = SHStopCapture(privateContext, &error)
    let message = error.map { String(cString: $0) }
    if let error { SHFreeError(error) }
    return (ok, message)
  }

  private func sendTouch(_ payload: [String: Any]) -> (Bool, String?) {
    guard let privateContext, capabilities.touch else {
      return (false, "capability_unavailable")
    }
    let phaseName = jsonString(payload["phase"]) ?? ""
    let phase: SHTouchPhase
    switch phaseName {
    case "down": phase = SHTouchPhaseDown
    case "move": phase = SHTouchPhaseMove
    case "up": phase = SHTouchPhaseUp
    default:
      return (false, "protocol_error")
    }
    guard let x = jsonDouble(payload["x"]), let y = jsonDouble(payload["y"]) else {
      return (false, "protocol_error")
    }
    var error: UnsafeMutablePointer<CChar>?
    let ok = SHSendTouch(privateContext, phase, x, y, &error)
    let message = error.map { String(cString: $0) }
    if let error { SHFreeError(error) }
    return (ok, message)
  }

  private func sendScrollTo(_ payload: [String: Any]) -> (Bool, String?) {
    guard let privateContext, capabilities.touch else {
      return (false, "capability_unavailable")
    }
    guard let x = jsonDouble(payload["x"]), let y = jsonDouble(payload["y"]) else {
      return (false, "protocol_error")
    }
    let dx = jsonDouble(payload["dx"]) ?? 0
    let dy = jsonDouble(payload["dy"]) ?? 0
    var error: UnsafeMutablePointer<CChar>?
    let ok = SHSendScrollTo(privateContext, x, y, dx, dy, &error)
    let message = error.map { String(cString: $0) }
    if let error { SHFreeError(error) }
    return (ok, message)
  }

  private func sendKey(_ payload: [String: Any]) -> (Bool, String?) {
    guard let privateContext, capabilities.keyboard else {
      return (false, "capability_unavailable")
    }
    guard let usage = jsonUInt64(payload["usage"]) else {
      return (false, "protocol_error")
    }
    var event = SHKeyEvent()
    event.usage = UInt16(truncatingIfNeeded: usage)
    event.down = jsonBool(payload["down"]) ?? true
    event.modifiers = UInt32(truncatingIfNeeded: jsonUInt64(payload["modifiers"]) ?? 0)
    var error: UnsafeMutablePointer<CChar>?
    let ok = SHSendKey(privateContext, event, &error)
    let message = error.map { String(cString: $0) }
    if let error { SHFreeError(error) }
    return (ok, message)
  }

  private func sendText(_ payload: [String: Any]) -> (Bool, String?) {
    guard let privateContext, capabilities.keyboard else {
      return (false, "capability_unavailable")
    }
    guard let text = jsonString(payload["text"]), !text.isEmpty else {
      return (false, "protocol_error")
    }
    var error: UnsafeMutablePointer<CChar>?
    let ok = text.withCString { SHSendText(privateContext, $0, &error) }
    let message = error.map { String(cString: $0) }
    if let error { SHFreeError(error) }
    return (ok, message)
  }

  private func pressButton(_ payload: [String: Any]) -> (Bool, String?) {
    guard let privateContext, capabilities.hardwareButtons else {
      return (false, "capability_unavailable")
    }
    let name = jsonString(payload["button"]) ?? ""
    let button: SHHardwareButton
    switch name {
    case "home": button = SHHardwareButtonHome
    case "lock": button = SHHardwareButtonLock
    case "volumeUp": button = SHHardwareButtonVolumeUp
    case "volumeDown": button = SHHardwareButtonVolumeDown
    case "action": button = SHHardwareButtonAction
    case "shake": button = SHHardwareButtonShake
    default:
      return (false, "protocol_error")
    }
    var error: UnsafeMutablePointer<CChar>?
    let ok = SHPressButton(privateContext, button, &error)
    let message = error.map { String(cString: $0) }
    if let error { SHFreeError(error) }
    return (ok, message)
  }

  private func handleAccessibility(_ request: ControlRequest) throws {
    guard let privateContext, capabilities.accessibility else {
      try writeResponse(id: request.id, ok: false, error: "capability_unavailable")
      return
    }
    let maxDepth = UInt32(truncatingIfNeeded: jsonUInt64(request.payload["maxDepth"]) ?? 8)
    var error: UnsafeMutablePointer<CChar>?
    guard let json = SHCopyAccessibilityJSON(privateContext, maxDepth, &error) else {
      let message = error.map { String(cString: $0) }
      if let error { SHFreeError(error) }
      try writeResponse(id: request.id, ok: false, error: message ?? "capability_unavailable")
      return
    }
    let text = String(cString: json)
    SHFreeError(json)
    guard let body = text.data(using: .utf8),
          let object = try JSONSerialization.jsonObject(with: body) as? [String: Any]
    else {
      try writeResponse(id: request.id, ok: false, error: "capability_unavailable")
      return
    }
    try writeResponse(id: request.id, ok: true, result: ["tree": object])
  }

  func emitVideo(_ encoded: H264Session.Encoded) {
    videoSequence &+= 1
    let record = VideoRecord(
      type: encoded.kind,
      flags: 0,
      generation: UInt32(truncatingIfNeeded: generation ?? 0),
      sequence: videoSequence,
      timestampUs: encoded.timestampUs,
      width: UInt16(clamping: encoded.width),
      height: UInt16(clamping: encoded.height),
      payload: encoded.payload
    )
    guard let data = try? VideoEncoder.encode(record) else { return }
    videoLock.lock()
    let handler = _videoHandler
    videoLock.unlock()
    handler?(data)
  }

  private static let frameCallback: SHFrameCallback = { user, pixelBuffer, timestampUs in
    guard let user, let pixelBuffer else { return }
    let session = Unmanaged<HelperSession>.fromOpaque(user).takeUnretainedValue()
    let buffer = Unmanaged<CVPixelBuffer>.fromOpaque(pixelBuffer).takeRetainedValue()
    session.encoder.encode(pixelBuffer: buffer, timestampUs: timestampUs)
  }
}

private final class VideoSendErrorBox: @unchecked Sendable {
  var error: Error?
}

func jsonString(_ value: Any?) -> String? {
  value as? String
}

func jsonBool(_ value: Any?) -> Bool? {
  if let flag = value as? Bool {
    return flag
  }
  if let number = value as? NSNumber {
    return number.boolValue
  }
  return nil
}

func jsonDouble(_ value: Any?) -> Double? {
  if let number = value as? NSNumber {
    return number.doubleValue
  }
  if let value = value as? Double {
    return value
  }
  if let value = value as? Int {
    return Double(value)
  }
  if let string = value as? String {
    return Double(string)
  }
  return nil
}

private extension Optional where Wrapped == String {
  func withCStringOrNil<R>(_ body: (UnsafePointer<CChar>?) -> R) -> R {
    switch self {
    case .some(let value):
      return value.withCString { body($0) }
    case .none:
      return body(nil)
    }
  }
}
