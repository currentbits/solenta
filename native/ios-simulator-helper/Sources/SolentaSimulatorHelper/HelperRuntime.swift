import Darwin
import Foundation
import MachO
import SimulatorPrivateBridge

enum HelperError: Error, CustomStringConvertible {
  case usage(String)
  case sandbox(String)

  var description: String {
    switch self {
    case .usage(let message):
      return message
    case .sandbox(let message):
      return "sandbox_failed: \(message)"
    }
  }
}

struct Options: Equatable {
  var sandboxProfile: String
  var developerDir: String
  var controlInFD: Int32 = 3
  var controlOutFD: Int32 = 4
  var sandboxSelfTest = false

  static func parse(_ arguments: [String]) throws -> Options {
    var args = arguments
    if let first = args.first, !first.hasPrefix("--") {
      args.removeFirst()
    }

    var profile: String?
    var developerDir: String?
    var inFD: Int32 = 3
    var outFD: Int32 = 4
    var selfTest = false
    var index = 0
    while index < args.count {
      let arg = args[index]
      func takeValue() throws -> String {
        index += 1
        guard index < args.count else {
          throw HelperError.usage("missing value for \(arg)")
        }
        return args[index]
      }
      switch arg {
      case "--sandbox-profile":
        profile = try takeValue()
      case "--developer-dir":
        developerDir = try takeValue()
      case "--control-in-fd":
        guard let value = Int32(try takeValue()) else {
          throw HelperError.usage("invalid --control-in-fd")
        }
        inFD = value
      case "--control-out-fd":
        guard let value = Int32(try takeValue()) else {
          throw HelperError.usage("invalid --control-out-fd")
        }
        outFD = value
      case "--sandbox-self-test":
        selfTest = true
      default:
        throw HelperError.usage("unknown argument: \(arg)")
      }
      index += 1
    }

    guard let profile, profile.hasPrefix("/") else {
      throw HelperError.usage("missing --sandbox-profile <absolute path>")
    }
    guard let developerDir, developerDir.hasPrefix("/") else {
      throw HelperError.usage("missing --developer-dir <absolute path>")
    }
    return Options(
      sandboxProfile: profile,
      developerDir: developerDir,
      controlInFD: inFD,
      controlOutFD: outFD,
      sandboxSelfTest: selfTest
    )
  }
}

enum Sandbox {
  static func enter(profile: String, parameters: [String: String]) throws {
    let text = try String(contentsOfFile: profile, encoding: .utf8)
    var pairs: [String] = []
    for key in parameters.keys.sorted() {
      pairs.append(key)
      pairs.append(parameters[key] ?? "")
    }

    let outcome: (Bool, String?) = try text.withCString { profileC in
      try withCStringPointerArray(pairs) { ptrs in
        var error: UnsafeMutablePointer<CChar>?
        let ok = SHSandboxEnter(profileC, ptrs, &error)
        var message: String?
        if let error {
          message = String(cString: error)
          SHFreeError(error)
        }
        return (ok, message)
      }
    }
    if !outcome.0 {
      throw HelperError.sandbox(outcome.1 ?? "unknown")
    }
  }
}

func withCStringPointerArray<R>(
  _ strings: [String],
  _ body: (UnsafeMutablePointer<UnsafePointer<CChar>?>) throws -> R
) throws -> R {
  var heap: [UnsafeMutablePointer<CChar>?] = strings.map { strdup($0) }
  heap.append(nil)
  defer {
    for pointer in heap {
      free(pointer)
    }
  }
  var immutable: [UnsafePointer<CChar>?] = heap.map { pointer in
    pointer.map { UnsafePointer($0) }
  }
  return try immutable.withUnsafeMutableBufferPointer { buffer in
    try body(buffer.baseAddress!)
  }
}

func currentHelperPath() -> String {
  var size = UInt32(PATH_MAX)
  var buffer = [CChar](repeating: 0, count: Int(PATH_MAX))
  if _NSGetExecutablePath(&buffer, &size) == 0 {
    if let end = buffer.firstIndex(of: 0) {
      return String(decoding: buffer[..<end].map { UInt8(bitPattern: $0) }, as: UTF8.self)
    }
  }
  return CommandLine.arguments[0]
}

func sandboxParameters(developerDir: String) -> [String: String] {
  let tmp = FileManager.default.temporaryDirectory.path
  return [
    "DEVELOPER_DIR": developerDir,
    "HELPER_PATH": currentHelperPath(),
    "CACHE_DIR": tmp,
    "TMPDIR": ProcessInfo.processInfo.environment["TMPDIR"] ?? tmp,
  ]
}

enum SandboxSelfTest {
  static func run() -> [(name: String, denied: Bool)] {
    [
      (name: "deny-shell", denied: spawnDenied(path: "/bin/sh", arguments: ["-c", "true"])),
      (name: "deny-spawn", denied: spawnDenied(path: "/usr/bin/true", arguments: [])),
      (name: "deny-home-read", denied: homeReadDenied()),
      (name: "deny-home-write", denied: homeWriteDenied()),
      (name: "deny-listen", denied: listenDenied()),
      (name: "deny-non-loopback", denied: nonLoopbackDenied()),
      (name: "allow-loopback-client", denied: !loopbackClientAllowed()),
    ]
  }

  private static func spawnDenied(path: String, arguments: [String]) -> Bool {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: path)
    process.arguments = arguments
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    do {
      try process.run()
      process.waitUntilExit()
      return false
    } catch {
      return true
    }
  }

  private static func homeReadDenied() -> Bool {
    let path = (NSHomeDirectory() as NSString).appendingPathComponent("Library")
    let fd = open(path, O_RDONLY)
    if fd >= 0 {
      close(fd)
      return false
    }
    return true
  }

  private static func homeWriteDenied() -> Bool {
    let path = (NSHomeDirectory() as NSString)
      .appendingPathComponent("solenta-simulator-helper-sandbox-self-test")
    let fd = open(path, O_CREAT | O_WRONLY | O_TRUNC, 0o600)
    if fd >= 0 {
      close(fd)
      unlink(path)
      return false
    }
    return true
  }

  private static func listenDenied() -> Bool {
    let fd = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP)
    guard fd >= 0 else { return true }
    defer { close(fd) }
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = 0
    address.sin_addr = in_addr(s_addr: INADDR_ANY.bigEndian)
    let bindRC = withUnsafePointer(to: &address) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
      }
    }
    if bindRC != 0 {
      return true
    }
    return listen(fd, 1) != 0
  }

  private static func nonLoopbackDenied() -> Bool {
    let fd = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP)
    guard fd >= 0 else { return true }
    defer { close(fd) }
    let flags = fcntl(fd, F_GETFL, 0)
    if flags >= 0 {
      _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK)
    }
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = in_port_t(UInt16(443).bigEndian)
    address.sin_addr = in_addr(s_addr: inet_addr("8.8.8.8"))
    let rc = withUnsafePointer(to: &address) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
      }
    }
    if rc == 0 {
      return false
    }
    switch errno {
    case EPERM, EACCES:
      return true
    case EINPROGRESS, EALREADY, ECONNREFUSED, ETIMEDOUT, ENETUNREACH, EHOSTUNREACH:
      return false
    default:
      return true
    }
  }

  private static func loopbackClientAllowed() -> Bool {
    let fd = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP)
    guard fd >= 0 else { return false }
    defer { close(fd) }
    let flags = fcntl(fd, F_GETFL, 0)
    if flags >= 0 {
      _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK)
    }
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = in_port_t(UInt16(1).bigEndian)
    address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
    let rc = withUnsafePointer(to: &address) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
      }
    }
    if rc == 0 {
      return true
    }
    switch errno {
    case EPERM, EACCES:
      return false
    case EINPROGRESS, EALREADY, ECONNREFUSED, ETIMEDOUT:
      return true
    default:
      return false
    }
  }
}

func runHelper(_ arguments: [String] = CommandLine.arguments) throws {
  let options = try Options.parse(arguments)
  try Sandbox.enter(
    profile: options.sandboxProfile,
    parameters: sandboxParameters(developerDir: options.developerDir)
  )
  if options.sandboxSelfTest {
    var failed = false
    for result in SandboxSelfTest.run() {
      let isAllow = result.name.hasPrefix("allow-")
      let ok = isAllow ? !result.denied : result.denied
      let status: String
      if isAllow {
        status = ok ? "allowed" : "DENIED"
      } else {
        status = ok ? "denied" : "ALLOWED"
      }
      try FileHandle.standardOutput.write(
        contentsOf: Data("sandbox-self-test \(result.name) \(status)\n".utf8)
      )
      if !ok {
        failed = true
      }
    }
    try FileHandle.standardOutput.write(
      contentsOf: Data("sandbox-self-test summary \(failed ? "fail" : "pass")\n".utf8)
    )
    if failed {
      exit(1)
    }
    return
  }

  let input = FileHandle(fileDescriptor: options.controlInFD, closeOnDealloc: false)
  let output = FileHandle(fileDescriptor: options.controlOutFD, closeOnDealloc: false)
  try output.write(contentsOf: FramedIO.encode(["kind": "ready", "v": 1] as [String: Any]))
  try HelperSession(
    input: input,
    output: output,
    developerDir: options.developerDir
  ).run()
}
