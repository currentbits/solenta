import XCTest
@testable import SolentaSimulatorHelper

final class VideoEnvelopeTests: XCTestCase {
  func testRoundTripKeyframe() throws {
    let record = VideoRecord(
      type: .key,
      flags: 0,
      generation: 3,
      sequence: 9,
      timestampUs: 42,
      width: 1179,
      height: 2556,
      payload: Data([1, 2, 3])
    )
    XCTAssertEqual(try VideoEncoder.decode(try VideoEncoder.encode(record)), record)
  }

  func testHeaderLayoutSLV1() throws {
    let payload = Data([0xaa])
    let encoded = try VideoEncoder.encode(
      VideoRecord(
        type: .key,
        flags: 0,
        generation: 0x11223344,
        sequence: 0x55667788,
        timestampUs: 0x0102_0304_0506_0708,
        width: 1179,
        height: 2556,
        payload: payload
      )
    )
    XCTAssertEqual(String(data: encoded.prefix(4), encoding: .ascii), "SLV1")
    XCTAssertEqual(encoded[4], 2)
    XCTAssertEqual(encoded[5], 0)
    XCTAssertEqual(readBE16(encoded, offset: 6), 0)
    XCTAssertEqual(readBE32(encoded, offset: 8), 0x11223344)
    XCTAssertEqual(readBE32(encoded, offset: 12), 0x55667788)
    XCTAssertEqual(readBE64(encoded, offset: 16), 0x0102_0304_0506_0708)
    XCTAssertEqual(readBE16(encoded, offset: 24), 1179)
    XCTAssertEqual(readBE16(encoded, offset: 26), 2556)
    XCTAssertEqual(readBE32(encoded, offset: 28), 1)
    XCTAssertEqual(encoded.subdata(in: 32..<encoded.count), payload)
  }

  func testRejectsBadMagicUnknownTypeReservedAndLength() throws {
    var record = try VideoEncoder.encode(
      VideoRecord(
        type: .key,
        flags: 0,
        generation: 1,
        sequence: 1,
        timestampUs: 1,
        width: 10,
        height: 10,
        payload: Data([1])
      )
    )
    record[0] = 0x58
    XCTAssertThrowsError(try VideoEncoder.decode(record)) { error in
      XCTAssertEqual(error as? VideoEncoderError, .badMagic)
    }

    record = try VideoEncoder.encode(
      VideoRecord(
        type: .key,
        flags: 0,
        generation: 1,
        sequence: 1,
        timestampUs: 1,
        width: 10,
        height: 10,
        payload: Data([1])
      )
    )
    record[4] = 99
    XCTAssertThrowsError(try VideoEncoder.decode(record)) { error in
      XCTAssertEqual(error as? VideoEncoderError, .unknownType)
    }

    record[4] = 2
    record[6] = 1
    XCTAssertThrowsError(try VideoEncoder.decode(record)) { error in
      XCTAssertEqual(error as? VideoEncoderError, .reservedNonzero)
    }

    XCTAssertThrowsError(try VideoEncoder.decode(record.subdata(in: 0..<(record.count - 1)))) { error in
      XCTAssertEqual(error as? VideoEncoderError, .lengthMismatch)
    }
  }

  func testRejectsZeroDimensionsAndOversizePayload() {
    XCTAssertThrowsError(
      try VideoEncoder.encode(
        VideoRecord(
          type: .key,
          flags: 0,
          generation: 1,
          sequence: 1,
          timestampUs: 1,
          width: 0,
          height: 10,
          payload: Data([1])
        )
      )
    ) { error in
      XCTAssertEqual(error as? VideoEncoderError, .zeroDimensions)
    }

    let payload = Data(count: ProtocolLimits.maxVideoBytes + 1)
    XCTAssertThrowsError(
      try VideoEncoder.encode(
        VideoRecord(
          type: .delta,
          flags: 0,
          generation: 1,
          sequence: 1,
          timestampUs: 1,
          width: 10,
          height: 10,
          payload: payload
        )
      )
    ) { error in
      XCTAssertEqual(error as? VideoEncoderError, .videoTooLarge)
    }
  }

  func testAvccAllowsZeroDimensions() throws {
    let record = VideoRecord(
      type: .avcC,
      flags: 0,
      generation: 1,
      sequence: 0,
      timestampUs: 0,
      width: 0,
      height: 0,
      payload: Data([1, 2])
    )
    XCTAssertEqual(try VideoEncoder.decode(try VideoEncoder.encode(record)), record)
  }
}
