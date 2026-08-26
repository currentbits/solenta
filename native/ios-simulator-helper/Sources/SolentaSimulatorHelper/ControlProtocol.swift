import Foundation

enum ControlProtocolError: Error, Equatable {
  case invalidJSON
  case missingID
  case missingMethod
  case generationMismatch
  case tokenMismatch
}

struct ControlRequest: Equatable {
  var id: UInt64
  var method: String
  var generation: UInt64?
  var token: String?
  var payload: [String: Any] = [:]

  static func == (lhs: ControlRequest, rhs: ControlRequest) -> Bool {
    lhs.id == rhs.id
      && lhs.method == rhs.method
      && lhs.generation == rhs.generation
      && lhs.token == rhs.token
  }
}

enum ControlProtocol {
  static func decodeRequest(_ body: Data) throws -> ControlRequest {
    let object: [String: Any]
    do {
      guard let parsed = try JSONSerialization.jsonObject(with: body) as? [String: Any] else {
        throw ControlProtocolError.invalidJSON
      }
      object = parsed
    } catch is ControlProtocolError {
      throw ControlProtocolError.invalidJSON
    } catch {
      throw ControlProtocolError.invalidJSON
    }

    guard let id = jsonUInt64(object["id"]) else {
      throw ControlProtocolError.missingID
    }
    guard let method = object["method"] as? String, !method.isEmpty else {
      throw ControlProtocolError.missingMethod
    }
    let token = object["token"] as? String
    return ControlRequest(
      id: id,
      method: method,
      generation: jsonUInt64(object["generation"]),
      token: token,
      payload: object
    )
  }

  static func check(
    _ request: ControlRequest,
    generation: UInt64?,
    token: String?
  ) throws {
    if let expected = generation, request.generation != expected {
      throw ControlProtocolError.generationMismatch
    }
    if let expected = token, request.token != expected {
      throw ControlProtocolError.tokenMismatch
    }
  }

  static func encodeResponse(
    id: UInt64,
    ok: Bool,
    error: String? = nil,
    result: [String: Any]? = nil
  ) throws -> Data {
    var object: [String: Any] = [
      "id": NSNumber(value: id),
      "ok": ok,
    ]
    if let error {
      object["error"] = error
    }
    if let result {
      object["result"] = result
    }
    return try FramedIO.encode(object)
  }
}

func jsonUInt64(_ value: Any?) -> UInt64? {
  if value == nil || value is NSNull {
    return nil
  }
  if let number = value as? NSNumber {
    return number.uint64Value
  }
  if let int = value as? Int {
    return UInt64(int)
  }
  if let uint = value as? UInt64 {
    return uint
  }
  if let string = value as? String {
    return UInt64(string)
  }
  return nil
}
