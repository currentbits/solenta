import Foundation
import Network
import XCTest

@testable import SolentaSimulatorHelper

final class VideoStreamTests: XCTestCase {
  func testVideoSessionConfigurationIsLongLived() {
    let config = HelperSession.videoSessionConfiguration()
    let requestTimeout = config.timeoutIntervalForRequest
    let resourceTimeout = config.timeoutIntervalForResource
    XCTAssertTrue(
      requestTimeout == 0 || requestTimeout >= 3600,
      "request timeout must not be a short idle deadline, got \(requestTimeout)"
    )
    XCTAssertTrue(
      resourceTimeout == 0 || resourceTimeout >= 3600,
      "resource timeout must not be a short idle deadline, got \(resourceTimeout)"
    )
  }

  func testStartStreamAssignsHandlerAndSendsBinaryOverLoopbackWebSocket() throws {
    let server = try LoopbackWSServer()
    defer { server.close() }

    let harness = SessionHarness()
    defer { _ = harness.finish() }

    try harness.send([
      "id": 1,
      "method": "handshake",
      "generation": 7,
      "token": "control-tok",
    ])
    _ = try harness.readObject()

    try harness.send([
      "id": 2,
      "method": "startStream",
      "generation": 7,
      "token": "control-tok",
      "url": "ws://127.0.0.1:\(server.port)",
      "helperToken": "helper-tok",
    ])
    let started = try harness.readObject()
    XCTAssertEqual(started["ok"] as? Bool, false)
    XCTAssertEqual(started["error"] as? String, "capability_unavailable")
    XCTAssertNotNil(harness.session.videoHandler)

    let auth = try server.waitForText(timeout: 3)
    let object = try JSONSerialization.jsonObject(with: Data(auth.utf8)) as! [String: Any]
    XCTAssertEqual(object["token"] as? String, "helper-tok")
    XCTAssertEqual(jsonUInt64(object["generation"]), 7)

    harness.session.emitVideo(
      H264Session.Encoded(
        kind: .avcC,
        payload: Data([1, 2, 3]),
        width: 0,
        height: 0,
        timestampUs: 42
      )
    )
    let binary = try server.waitForBinary(timeout: 3)
    let record = try VideoEncoder.decode(binary)
    XCTAssertEqual(record.type, .avcC)
    XCTAssertEqual(record.payload, Data([1, 2, 3]))
    XCTAssertEqual(record.generation, 7)

    try harness.send([
      "id": 3,
      "method": "stopStream",
      "generation": 7,
      "token": "control-tok",
    ])
    _ = try harness.readObject()
    XCTAssertNil(harness.session.videoHandler)
  }
}

private final class LoopbackWSServer: @unchecked Sendable {
  private let listener: NWListener
  private let queue = DispatchQueue(label: "solenta.test.ws")
  private let lock = NSLock()
  private var connection: NWConnection?
  private var texts: [String] = []
  private var binaries: [Data] = []
  private var textWaiters: [DispatchSemaphore] = []
  private var binaryWaiters: [DispatchSemaphore] = []
  private(set) var port: UInt16 = 0

  init() throws {
    let params = NWParameters.tcp
    params.allowLocalEndpointReuse = true
    if let ip = params.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options {
      ip.version = .v4
    }
    let ws = NWProtocolWebSocket.Options()
    ws.autoReplyPing = true
    params.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)
    let listener = try NWListener(using: params, on: 0)
    self.listener = listener

    let ready = DispatchSemaphore(value: 0)
    let failBox = FailBox()
    listener.stateUpdateHandler = { state in
      switch state {
      case .ready:
        ready.signal()
      case .failed(let error):
        failBox.error = error
        ready.signal()
      default:
        break
      }
    }
    listener.newConnectionHandler = { [weak self] conn in
      self?.attach(conn)
    }
    listener.start(queue: queue)
    if ready.wait(timeout: .now() + 2) != .success {
      listener.cancel()
      throw LoopbackWSServerError.notReady
    }
    if let failed = failBox.error {
      listener.cancel()
      throw LoopbackWSServerError.failed(String(describing: failed))
    }
    guard let bound = listener.port?.rawValue, bound > 0 else {
      listener.cancel()
      throw LoopbackWSServerError.notReady
    }
    port = bound
  }

  func waitForText(timeout: TimeInterval) throws -> String {
    lock.lock()
    if !texts.isEmpty {
      let value = texts.removeFirst()
      lock.unlock()
      return value
    }
    let sem = DispatchSemaphore(value: 0)
    textWaiters.append(sem)
    lock.unlock()
    if sem.wait(timeout: .now() + timeout) != .success {
      throw LoopbackWSServerError.timeout("text")
    }
    lock.lock()
    defer { lock.unlock() }
    guard !texts.isEmpty else {
      throw LoopbackWSServerError.timeout("text")
    }
    return texts.removeFirst()
  }

  func waitForBinary(timeout: TimeInterval) throws -> Data {
    lock.lock()
    if !binaries.isEmpty {
      let value = binaries.removeFirst()
      lock.unlock()
      return value
    }
    let sem = DispatchSemaphore(value: 0)
    binaryWaiters.append(sem)
    lock.unlock()
    if sem.wait(timeout: .now() + timeout) != .success {
      throw LoopbackWSServerError.timeout("binary")
    }
    lock.lock()
    defer { lock.unlock() }
    guard !binaries.isEmpty else {
      throw LoopbackWSServerError.timeout("binary")
    }
    return binaries.removeFirst()
  }

  func close() {
    lock.lock()
    let conn = connection
    connection = nil
    lock.unlock()
    conn?.cancel()
    listener.cancel()
  }

  private func attach(_ conn: NWConnection) {
    lock.lock()
    let existing = connection
    connection = conn
    lock.unlock()
    existing?.cancel()
    conn.start(queue: queue)
    receive(on: conn)
  }

  private func receive(on conn: NWConnection) {
    conn.receiveMessage { [weak self] content, context, _, error in
      guard let self else { return }
      if let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition)
        as? NWProtocolWebSocket.Metadata,
        let content
      {
        self.lock.lock()
        switch metadata.opcode {
        case .binary:
          self.binaries.append(content)
          let waiters = self.binaryWaiters
          self.binaryWaiters.removeAll()
          self.lock.unlock()
          waiters.forEach { $0.signal() }
        case .text:
          self.texts.append(String(data: content, encoding: .utf8) ?? "")
          let waiters = self.textWaiters
          self.textWaiters.removeAll()
          self.lock.unlock()
          waiters.forEach { $0.signal() }
        default:
          self.lock.unlock()
        }
      }
      if error == nil {
        self.receive(on: conn)
      }
    }
  }
}

private enum LoopbackWSServerError: Error {
  case notReady
  case failed(String)
  case timeout(String)
}

private final class FailBox: @unchecked Sendable {
  var error: Error?
}
