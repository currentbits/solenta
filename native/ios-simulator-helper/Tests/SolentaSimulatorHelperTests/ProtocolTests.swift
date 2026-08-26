import XCTest
@testable import SolentaSimulatorHelper

final class ProtocolTests: XCTestCase {
  func testEncodeReadyFrame() throws {
    let frame = try FramedIO.encode(["kind": "ready", "v": 1] as [String: Any])
    XCTAssertEqual(readBE32(frame, offset: 0), UInt32(frame.count - 4))
    let object = try JSONSerialization.jsonObject(with: frame.subdata(in: 4..<frame.count)) as! [String: Any]
    XCTAssertEqual(object["kind"] as? String, "ready")
    XCTAssertEqual(jsonUInt64(object["v"]), 1)
  }

  func testFragmentedFrames() throws {
    let decoder = FramedIO.Decoder()
    let frame = try FramedIO.encode(["id": 1, "method": "ping"] as [String: Any])
    XCTAssertEqual(try decoder.append(frame.subdata(in: 0..<2)), [])
    XCTAssertEqual(try decoder.append(frame.subdata(in: 2..<6)), [])
    let bodies = try decoder.append(frame.subdata(in: 6..<frame.count))
    XCTAssertEqual(bodies.count, 1)
    let request = try ControlProtocol.decodeRequest(bodies[0])
    XCTAssertEqual(request.id, 1)
    XCTAssertEqual(request.method, "ping")
  }

  func testCoalescedFrames() throws {
    let decoder = FramedIO.Decoder()
    let a = try FramedIO.encode(["id": 1, "method": "ping"] as [String: Any])
    let b = try FramedIO.encode(["id": 2, "method": "ping"] as [String: Any])
    var combined = Data()
    combined.append(a)
    combined.append(b)
    let bodies = try decoder.append(combined)
    XCTAssertEqual(bodies.count, 2)
    XCTAssertEqual(try ControlProtocol.decodeRequest(bodies[0]).id, 1)
    XCTAssertEqual(try ControlProtocol.decodeRequest(bodies[1]).id, 2)
  }

  func testAcceptsExact64KiBBody() throws {
    let overhead = Data("{\"d\":\"\"}".utf8).count
    let value = ["d": String(repeating: "a", count: FramedIO.maxControlBytes - overhead)]
    let encoded = try FramedIO.encode(value)
    XCTAssertEqual(readBE32(encoded, offset: 0), UInt32(FramedIO.maxControlBytes))
    let decoder = FramedIO.Decoder()
    let bodies = try decoder.append(encoded)
    XCTAssertEqual(bodies.count, 1)
    XCTAssertEqual(bodies[0].count, FramedIO.maxControlBytes)
  }

  func testRejectsEncodeOver64KiB() {
    let overhead = Data("{\"d\":\"\"}".utf8).count
    let value = ["d": String(repeating: "a", count: FramedIO.maxControlBytes - overhead + 1)]
    XCTAssertThrowsError(try FramedIO.encode(value)) { error in
      XCTAssertEqual(error as? FramedIOError, .controlTooLarge)
    }
  }

  func testRejectsOverLimitLengthPrefixBeforeBody() {
    let decoder = FramedIO.Decoder()
    var header = Data()
    appendBE32(&header, UInt32(FramedIO.maxControlBytes + 1))
    XCTAssertThrowsError(try decoder.append(header)) { error in
      XCTAssertEqual(error as? FramedIOError, .controlTooLarge)
    }
  }

  func testRequestDecodingExtractsGenerationAndToken() throws {
    let body = try JSONSerialization.data(
      withJSONObject: [
        "id": 9,
        "method": "handshake",
        "generation": 3,
        "token": "secret",
      ] as [String: Any]
    )
    let request = try ControlProtocol.decodeRequest(body)
    XCTAssertEqual(request.id, 9)
    XCTAssertEqual(request.method, "handshake")
    XCTAssertEqual(request.generation, 3)
    XCTAssertEqual(request.token, "secret")
  }

  func testGenerationAndTokenChecks() throws {
    let request = ControlRequest(id: 1, method: "ping", generation: 3, token: "abc")
    try ControlProtocol.check(request, generation: 3, token: "abc")
    XCTAssertThrowsError(try ControlProtocol.check(request, generation: 4, token: "abc")) { error in
      XCTAssertEqual(error as? ControlProtocolError, .generationMismatch)
    }
    XCTAssertThrowsError(try ControlProtocol.check(request, generation: 3, token: "nope")) { error in
      XCTAssertEqual(error as? ControlProtocolError, .tokenMismatch)
    }
  }

  func testOptionsParseDefaultsAndSelfTest() throws {
    let options = try Options.parse([
      "SolentaSimulatorHelper",
      "--sandbox-profile",
      "/tmp/helper.sb",
      "--developer-dir",
      "/Applications/Xcode.app/Contents/Developer",
      "--sandbox-self-test",
    ])
    XCTAssertEqual(options.controlInFD, 3)
    XCTAssertEqual(options.controlOutFD, 4)
    XCTAssertTrue(options.sandboxSelfTest)
    XCTAssertThrowsError(try Options.parse(["--developer-dir", "/tmp"])) { error in
      guard case HelperError.usage = error else {
        return XCTFail("expected usage error")
      }
    }
  }

  func testHelperSessionCorrelatesResponsesAndHandshakeCapabilities() throws {
    let harness = SessionHarness()
    defer { _ = harness.finish() }

    try harness.send([
      "id": 1,
      "method": "handshake",
      "generation": 7,
      "token": "tok",
    ])
    let handshake = try harness.readObject()
    XCTAssertEqual(jsonUInt64(handshake["id"]), 1)
    XCTAssertEqual(handshake["ok"] as? Bool, true)
    let result = handshake["result"] as! [String: Any]
    XCTAssertEqual(jsonUInt64(result["v"]), 1)
    let capabilities = result["capabilities"] as! [String: Any]
    XCTAssertEqual(capabilities["stream"] as? Bool, false)
    XCTAssertEqual(capabilities["touch"] as? Bool, false)
    XCTAssertEqual(capabilities["keyboard"] as? Bool, false)
    XCTAssertEqual(capabilities["hardwareButtons"] as? Bool, false)
    XCTAssertEqual(capabilities["accessibility"] as? Bool, false)

    try harness.send([
      "id": 2,
      "method": "ping",
      "generation": 7,
      "token": "tok",
    ])
    let ping = try harness.readObject()
    XCTAssertEqual(jsonUInt64(ping["id"]), 2)
    XCTAssertEqual(ping["ok"] as? Bool, true)
  }

  func testHelperSessionRejectsStaleGenerationAndToken() throws {
    let harness = SessionHarness()
    defer { _ = harness.finish() }

    try harness.send([
      "id": 1,
      "method": "handshake",
      "generation": 1,
      "token": "one",
    ])
    _ = try harness.readObject()

    try harness.send([
      "id": 2,
      "method": "ping",
      "generation": 2,
      "token": "one",
    ])
    let generationError = try harness.readObject()
    XCTAssertEqual(jsonUInt64(generationError["id"]), 2)
    XCTAssertEqual(generationError["ok"] as? Bool, false)
    XCTAssertEqual(generationError["error"] as? String, "generation_mismatch")

    try harness.send([
      "id": 3,
      "method": "ping",
      "generation": 1,
      "token": "two",
    ])
    let tokenError = try harness.readObject()
    XCTAssertEqual(jsonUInt64(tokenError["id"]), 3)
    XCTAssertEqual(tokenError["error"] as? String, "token_mismatch")
  }

  func testHelperSessionCleanEOF() throws {
    let harness = SessionHarness()
    let error = harness.finish()
    XCTAssertNil(error)
  }

  func testLoopbackVideoURLAllowsOnlyLoopbackWS() {
    let allowed = [
      "ws://127.0.0.1",
      "ws://127.0.0.1:9",
      "ws://127.0.0.1:1234/stream",
      "ws://localhost",
      "ws://localhost:9",
      "ws://LOCALHOST:8080/path",
    ]
    for string in allowed {
      let url = URL(string: string)
      XCTAssertNotNil(url, string)
      XCTAssertTrue(LoopbackVideoURL.isAllowed(url!), string)
      XCTAssertEqual(LoopbackVideoURL.parse(string)?.host?.lowercased(), url?.host?.lowercased())
    }

    let rejected = [
      "wss://127.0.0.1",
      "http://127.0.0.1",
      "ws://8.8.8.8",
      "ws://example.com",
      "ws://127.0.0.1.evil.com",
      "ws://[::1]",
      "ws://0.0.0.0",
      "ws://user:pass@127.0.0.1",
      "ws://127.0.0.2",
    ]
    for string in rejected {
      XCTAssertNil(LoopbackVideoURL.parse(string), string)
    }
  }

  func testStartStreamWithoutURLOrTokenFailsClosed() throws {
    let harness = SessionHarness()
    defer { _ = harness.finish() }

    try harness.send(["id": 1, "method": "startStream"])
    let missing = try harness.readObject()
    XCTAssertEqual(missing["ok"] as? Bool, false)
    XCTAssertEqual(missing["error"] as? String, "protocol_error")
    XCTAssertNil(harness.session.videoHandler)

    try harness.send([
      "id": 2,
      "method": "handshake",
      "generation": 1,
      "token": "tok",
    ])
    _ = try harness.readObject()

    try harness.send([
      "id": 3,
      "method": "startStream",
      "generation": 1,
      "token": "tok",
    ])
    let noURL = try harness.readObject()
    XCTAssertEqual(noURL["ok"] as? Bool, false)
    XCTAssertEqual(noURL["error"] as? String, "protocol_error")
    XCTAssertNil(harness.session.videoHandler)

    try harness.send([
      "id": 4,
      "method": "startStream",
      "generation": 1,
      "token": "tok",
      "url": "ws://example.com:80",
    ])
    let remote = try harness.readObject()
    XCTAssertEqual(remote["ok"] as? Bool, false)
    XCTAssertEqual(remote["error"] as? String, "protocol_error")
    XCTAssertNil(harness.session.videoHandler)
  }

  func testEmitVideoCallsInjectedHandler() throws {
    let harness = SessionHarness()
    defer { _ = harness.finish() }

    try harness.send([
      "id": 1,
      "method": "handshake",
      "generation": 3,
      "token": "tok",
    ])
    _ = try harness.readObject()

    let lock = NSLock()
    var received: [Data] = []
    harness.session.videoHandler = { data in
      lock.lock()
      received.append(data)
      lock.unlock()
    }
    harness.session.emitVideo(
      H264Session.Encoded(
        kind: .avcC,
        payload: Data([9, 8, 7]),
        width: 0,
        height: 0,
        timestampUs: 11
      )
    )
    lock.lock()
    XCTAssertEqual(received.count, 1)
    let decoded = try VideoEncoder.decode(received[0])
    lock.unlock()
    XCTAssertEqual(decoded.type, .avcC)
    XCTAssertEqual(decoded.payload, Data([9, 8, 7]))
    XCTAssertEqual(decoded.generation, 3)
  }
}

final class SessionHarness: @unchecked Sendable {
  let session: HelperSession
  private let toHelper: FileHandle
  private let fromHelper: FileHandle
  private let decoder = FramedIO.Decoder()
  private let group = DispatchGroup()
  private var sessionError: Error?

  init() {
    let input = Pipe()
    let output = Pipe()
    toHelper = input.fileHandleForWriting
    fromHelper = output.fileHandleForReading
    session = HelperSession(
      input: input.fileHandleForReading,
      output: output.fileHandleForWriting
    )
    group.enter()
    DispatchQueue.global(qos: .userInitiated).async {
      defer { self.group.leave() }
      do {
        try self.session.run()
      } catch {
        self.sessionError = error
      }
    }
  }

  func send(_ object: [String: Any]) throws {
    try toHelper.write(contentsOf: FramedIO.encode(object))
  }

  func readObject() throws -> [String: Any] {
    let chunk = fromHelper.availableData
    if chunk.isEmpty {
      throw NSError(
        domain: "SessionHarness",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: "eof before frame"]
      )
    }
    let bodies = try decoder.append(chunk)
    guard let body = bodies.first else {
      throw NSError(
        domain: "SessionHarness",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: "incomplete frame"]
      )
    }
    return try JSONSerialization.jsonObject(with: body) as! [String: Any]
  }

  func finish(timeout: TimeInterval = 2) -> Error? {
    try? toHelper.close()
    _ = group.wait(timeout: .now() + timeout)
    return sessionError
  }
}
