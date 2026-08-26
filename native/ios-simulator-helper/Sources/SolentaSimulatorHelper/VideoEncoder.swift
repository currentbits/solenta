import Foundation

enum VideoRecordType: UInt8, Equatable {
  case avcC = 1
  case key = 2
  case delta = 3
  case jpeg = 4
}

enum VideoEncoderError: Error, Equatable {
  case badMagic
  case unknownType
  case reservedNonzero
  case lengthMismatch
  case zeroDimensions
  case videoTooLarge
}

struct VideoRecord: Equatable {
  var type: VideoRecordType
  var flags: UInt8
  var generation: UInt32
  var sequence: UInt32
  var timestampUs: UInt64
  var width: UInt16
  var height: UInt16
  var payload: Data
}

enum VideoEncoder {
  static let headerSize = 32
  static let magic = Data(ProtocolLimits.videoMagic.utf8)

  static func encode(_ record: VideoRecord) throws -> Data {
    if record.payload.count > ProtocolLimits.maxVideoBytes {
      throw VideoEncoderError.videoTooLarge
    }
    if record.type != .avcC && (record.width == 0 || record.height == 0) {
      throw VideoEncoderError.zeroDimensions
    }
    var out = Data(count: headerSize + record.payload.count)
    out.replaceSubrange(0..<4, with: magic)
    out[4] = record.type.rawValue
    out[5] = record.flags
    out[6] = 0
    out[7] = 0
    writeBE32(&out, offset: 8, record.generation)
    writeBE32(&out, offset: 12, record.sequence)
    writeBE64(&out, offset: 16, record.timestampUs)
    writeBE16(&out, offset: 24, record.width)
    writeBE16(&out, offset: 26, record.height)
    writeBE32(&out, offset: 28, UInt32(record.payload.count))
    if !record.payload.isEmpty {
      out.replaceSubrange(headerSize..<(headerSize + record.payload.count), with: record.payload)
    }
    return out
  }

  static func decode(_ data: Data) throws -> VideoRecord {
    if data.count < headerSize {
      throw VideoEncoderError.lengthMismatch
    }
    if data[0] != magic[0] || data[1] != magic[1] || data[2] != magic[2] || data[3] != magic[3] {
      throw VideoEncoderError.badMagic
    }
    guard let type = VideoRecordType(rawValue: data[4]) else {
      throw VideoEncoderError.unknownType
    }
    if data[6] != 0 || data[7] != 0 {
      throw VideoEncoderError.reservedNonzero
    }
    let payloadLength = readBE32(data, offset: 28)
    if payloadLength > UInt32(ProtocolLimits.maxVideoBytes) {
      throw VideoEncoderError.videoTooLarge
    }
    if data.count != headerSize + Int(payloadLength) {
      throw VideoEncoderError.lengthMismatch
    }
    let width = readBE16(data, offset: 24)
    let height = readBE16(data, offset: 26)
    if type != .avcC && (width == 0 || height == 0) {
      throw VideoEncoderError.zeroDimensions
    }
    return VideoRecord(
      type: type,
      flags: data[5],
      generation: readBE32(data, offset: 8),
      sequence: readBE32(data, offset: 12),
      timestampUs: readBE64(data, offset: 16),
      width: width,
      height: height,
      payload: data.subdata(in: headerSize..<(headerSize + Int(payloadLength)))
    )
  }
}

func writeBE16(_ data: inout Data, offset: Int, _ value: UInt16) {
  data[offset] = UInt8((value >> 8) & 0xff)
  data[offset + 1] = UInt8(value & 0xff)
}

func writeBE32(_ data: inout Data, offset: Int, _ value: UInt32) {
  data[offset] = UInt8((value >> 24) & 0xff)
  data[offset + 1] = UInt8((value >> 16) & 0xff)
  data[offset + 2] = UInt8((value >> 8) & 0xff)
  data[offset + 3] = UInt8(value & 0xff)
}

func writeBE64(_ data: inout Data, offset: Int, _ value: UInt64) {
  writeBE32(&data, offset: offset, UInt32((value >> 32) & 0xffff_ffff))
  writeBE32(&data, offset: offset + 4, UInt32(value & 0xffff_ffff))
}

func readBE16(_ data: Data, offset: Int) -> UInt16 {
  UInt16(data[offset]) << 8 | UInt16(data[offset + 1])
}

func readBE64(_ data: Data, offset: Int) -> UInt64 {
  UInt64(readBE32(data, offset: offset)) << 32 | UInt64(readBE32(data, offset: offset + 4))
}
