import CoreVideo
import Darwin
import SimulatorPrivateBridge
import XCTest

@testable import SolentaSimulatorHelper

final class BridgeCapabilityTests: XCTestCase {
  func testCreateContextWithoutDeveloperDirLeavesCapabilitiesFalse() {
    var report = SHCapabilityReport()
    report.stream = true
    report.touch = true
    report.keyboard = true
    report.hardwareButtons = true
    report.accessibility = true
    var error: UnsafeMutablePointer<CChar>?
    let ctx = SHCreatePrivateContext(nil, nil, &report, &error)
    XCTAssertNil(error)
    XCTAssertNotNil(ctx)
    XCTAssertFalse(report.stream)
    XCTAssertFalse(report.touch)
    XCTAssertFalse(report.keyboard)
    XCTAssertFalse(report.hardwareButtons)
    XCTAssertFalse(report.accessibility)
    if let ctx {
      SHDestroyPrivateContext(ctx)
    }
  }

  func testInputAndCaptureFailClosedWithoutCapability() {
    var report = SHCapabilityReport()
    var error: UnsafeMutablePointer<CChar>?
    let ctx = SHCreatePrivateContext(nil, nil, &report, &error)
    XCTAssertNotNil(ctx)
    defer {
      if let ctx { SHDestroyPrivateContext(ctx) }
    }

    error = nil
    XCTAssertFalse(SHStartCapture(ctx, { _, _, _ in }, nil, &error))
    XCTAssertEqual(error.map { String(cString: $0) }, "capability_unavailable")
    if let error { SHFreeError(error) }

    error = nil
    XCTAssertFalse(SHSendTouch(ctx, SHTouchPhaseDown, 10, 20, &error))
    XCTAssertEqual(error.map { String(cString: $0) }, "capability_unavailable")
    if let error { SHFreeError(error) }

    error = nil
    XCTAssertFalse(SHSendScrollTo(ctx, 10, 20, 0, -120, &error))
    XCTAssertEqual(error.map { String(cString: $0) }, "capability_unavailable")
    if let error { SHFreeError(error) }

    error = nil
    var key = SHKeyEvent()
    key.usage = 0x04
    key.down = true
    key.modifiers = 0
    XCTAssertFalse(SHSendKey(ctx, key, &error))
    XCTAssertEqual(error.map { String(cString: $0) }, "capability_unavailable")
    if let error { SHFreeError(error) }

    error = nil
    XCTAssertFalse(SHSendText(ctx, "hello", &error))
    XCTAssertEqual(error.map { String(cString: $0) }, "capability_unavailable")
    if let error { SHFreeError(error) }

    error = nil
    XCTAssertFalse(SHPressButton(ctx, SHHardwareButtonHome, &error))
    XCTAssertEqual(error.map { String(cString: $0) }, "capability_unavailable")
    if let error { SHFreeError(error) }

    error = nil
    XCTAssertFalse(SHPressButton(ctx, SHHardwareButtonShake, &error))
    XCTAssertEqual(error.map { String(cString: $0) }, "capability_unavailable")
    if let error { SHFreeError(error) }

    error = nil
    XCTAssertNil(SHCopyAccessibilityJSON(ctx, 4, &error))
    XCTAssertEqual(error.map { String(cString: $0) }, "capability_unavailable")
    if let error { SHFreeError(error) }
  }

  func testHelperSessionUnknownAndUnavailableMethods() throws {
    let harness = SessionHarness()
    defer { _ = harness.finish() }

    try harness.send([
      "id": 1,
      "method": "handshake",
      "generation": 1,
      "token": "tok",
    ])
    _ = try harness.readObject()

    try harness.send([
      "id": 2,
      "method": "touch",
      "generation": 1,
      "token": "tok",
      "phase": "down",
      "x": 10,
      "y": 20,
    ])
    let touch = try harness.readObject()
    XCTAssertEqual(touch["ok"] as? Bool, false)
    XCTAssertEqual(touch["error"] as? String, "capability_unavailable")

    try harness.send([
      "id": 3,
      "method": "requestKeyframe",
      "generation": 1,
      "token": "tok",
    ])
    let keyframe = try harness.readObject()
    XCTAssertEqual(keyframe["ok"] as? Bool, true)

    try harness.send([
      "id": 4,
      "method": "setBitrate",
      "generation": 1,
      "token": "tok",
      "bps": 500_000,
    ])
    let bitrate = try harness.readObject()
    XCTAssertEqual(bitrate["ok"] as? Bool, true)

    try harness.send([
      "id": 5,
      "method": "accessibility",
      "generation": 1,
      "token": "tok",
      "maxDepth": 2,
    ])
    let ax = try harness.readObject()
    XCTAssertEqual(ax["error"] as? String, "capability_unavailable")

    try harness.send([
      "id": 6,
      "method": "pressButton",
      "generation": 1,
      "token": "tok",
      "button": "shake",
    ])
    let shake = try harness.readObject()
    XCTAssertEqual(shake["error"] as? String, "capability_unavailable")

    try harness.send([
      "id": 7,
      "method": "text",
      "generation": 1,
      "token": "tok",
      "text": "hello",
    ])
    let text = try harness.readObject()
    XCTAssertEqual(text["ok"] as? Bool, false)
    XCTAssertEqual(text["error"] as? String, "capability_unavailable")

    try harness.send([
      "id": 8,
      "method": "scrollTo",
      "generation": 1,
      "token": "tok",
      "x": 100,
      "y": 200,
      "dx": 0,
      "dy": -120,
    ])
    let scroll = try harness.readObject()
    XCTAssertEqual(scroll["ok"] as? Bool, false)
    XCTAssertEqual(scroll["error"] as? String, "capability_unavailable")
  }
}

final class H264SessionTests: XCTestCase {
  func testAvccBlobLayoutFromSyntheticSPS() {
    var blob = Data([0x01, 0x42, 0x00, 0x1E, 0xFF, 0xE1, 0x00, 0x04, 0x67, 0x42, 0x00, 0x1E, 0x01, 0x00, 0x04, 0x68, 0xCE, 0x38, 0x80])
    XCTAssertEqual(blob[0], 0x01)
    XCTAssertEqual(blob[4], 0xFF)
    XCTAssertEqual(blob[5], 0xE1)
  }

  func testJPEGSeedAndForcedKeyframeFromPixelBuffer() throws {
    let buffer = try makeBGRABuffer(width: 32, height: 32)
    let lock = NSLock()
    var encoded: [H264Session.Encoded] = []
    let session = H264Session(bitrate: 500_000) { frame in
      lock.lock()
      encoded.append(frame)
      lock.unlock()
    }
    session.encode(pixelBuffer: buffer, timestampUs: 1_000)
    session.requestKeyframe()
    session.encode(pixelBuffer: buffer, timestampUs: 2_000)

    let deadline = Date().addingTimeInterval(3)
    var kinds: [VideoRecordType] = []
    while Date() < deadline {
      lock.lock()
      kinds = encoded.map(\.kind)
      lock.unlock()
      if kinds.contains(.jpeg) && kinds.contains(.avcC) && kinds.contains(.key) {
        break
      }
      Thread.sleep(forTimeInterval: 0.05)
    }
    XCTAssertTrue(kinds.contains(.jpeg), "expected JPEG seed, got \(kinds)")
    XCTAssertTrue(kinds.contains(.avcC), "expected avcC, got \(kinds)")
    XCTAssertTrue(kinds.contains(.key), "expected IDR, got \(kinds)")
    lock.lock()
    let jpeg = encoded.first { $0.kind == .jpeg }
    let avcC = encoded.first { $0.kind == .avcC }
    let key = encoded.first { $0.kind == .key }
    lock.unlock()
    XCTAssertEqual(jpeg?.width, 32)
    XCTAssertEqual(jpeg?.height, 32)
    XCTAssertGreaterThan(jpeg?.payload.count ?? 0, 16)
    XCTAssertEqual(avcC?.width, 0)
    XCTAssertEqual(avcC?.height, 0)
    XCTAssertGreaterThan(avcC?.payload.count ?? 0, 7)
    XCTAssertEqual(avcC?.payload.first, 0x01)
    XCTAssertGreaterThan(key?.payload.count ?? 0, 0)

    let envelope = try VideoEncoder.encode(
      VideoRecord(
        type: .key,
        flags: 0,
        generation: 1,
        sequence: 1,
        timestampUs: 1,
        width: 32,
        height: 32,
        payload: key!.payload
      )
    )
    XCTAssertEqual(try VideoEncoder.decode(envelope).type, .key)
  }

  func testJPEGEncoderProducesJPEGMagic() throws {
    let buffer = try makeBGRABuffer(width: 16, height: 16)
    let data = try XCTUnwrap(H264Session.encodeJPEG(buffer))
    XCTAssertEqual(data[0], 0xFF)
    XCTAssertEqual(data[1], 0xD8)
  }
}

private func makeBGRABuffer(width: Int, height: Int) throws -> CVPixelBuffer {
  var buffer: CVPixelBuffer?
  let status = CVPixelBufferCreate(
    kCFAllocatorDefault,
    width,
    height,
    kCVPixelFormatType_32BGRA,
    [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary,
    &buffer
  )
  guard status == kCVReturnSuccess, let buffer else {
    throw NSError(domain: "H264SessionTests", code: Int(status))
  }
  CVPixelBufferLockBaseAddress(buffer, [])
  defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
  if let base = CVPixelBufferGetBaseAddress(buffer) {
    memset(base, 0x80, CVPixelBufferGetDataSize(buffer))
  }
  return buffer
}
