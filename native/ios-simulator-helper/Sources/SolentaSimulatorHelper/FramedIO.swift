import Foundation

enum FramedIOError: Error, Equatable {
  case controlTooLarge
  case invalidJSON
}

enum ProtocolLimits {
  static let version = 1
  static let maxControlBytes = 65536
  static let maxVideoBytes = 4_194_304
  static let videoMagic = "SLV1"
}

func appendBE32(_ data: inout Data, _ value: UInt32) {
  data.append(UInt8((value >> 24) & 0xff))
  data.append(UInt8((value >> 16) & 0xff))
  data.append(UInt8((value >> 8) & 0xff))
  data.append(UInt8(value & 0xff))
}

func readBE32(_ data: Data, offset: Int) -> UInt32 {
  UInt32(data[offset]) << 24
    | UInt32(data[offset + 1]) << 16
    | UInt32(data[offset + 2]) << 8
    | UInt32(data[offset + 3])
}

enum FramedIO {
  static let maxControlBytes = ProtocolLimits.maxControlBytes

  static func encode(_ object: Any) throws -> Data {
    guard JSONSerialization.isValidJSONObject(object) else {
      throw FramedIOError.invalidJSON
    }
    let body = try JSONSerialization.data(withJSONObject: object)
    return try encode(body: body)
  }

  static func encode(body: Data) throws -> Data {
    if body.count > maxControlBytes {
      throw FramedIOError.controlTooLarge
    }
    var out = Data(capacity: 4 + body.count)
    appendBE32(&out, UInt32(body.count))
    out.append(body)
    return out
  }

  final class Decoder {
    private var buffer = Data()

    func append(_ chunk: Data) throws -> [Data] {
      if !chunk.isEmpty {
        buffer.append(chunk)
      }
      var frames: [Data] = []
      while buffer.count >= 4 {
        let length = readBE32(buffer, offset: 0)
        if length > UInt32(Self.maxControlBytes) {
          throw FramedIOError.controlTooLarge
        }
        let total = 4 + Int(length)
        if buffer.count < total {
          return frames
        }
        frames.append(buffer.subdata(in: 4..<total))
        buffer.removeSubrange(0..<total)
      }
      return frames
    }
  }
}

private extension FramedIO.Decoder {
  static var maxControlBytes: Int { FramedIO.maxControlBytes }
}
