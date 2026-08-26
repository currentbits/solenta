import Foundation

enum LoopbackVideoURL {
  /// Accepts only unauthenticated `ws://127.0.0.1…` and `ws://localhost…`.
  static func isAllowed(_ url: URL) -> Bool {
    guard let scheme = url.scheme, scheme.caseInsensitiveCompare("ws") == .orderedSame else {
      return false
    }
    guard url.user == nil, url.password == nil else {
      return false
    }
    guard let host = url.host, !host.isEmpty else {
      return false
    }
    let lowered = host.lowercased()
    return lowered == "127.0.0.1" || lowered == "localhost"
  }

  static func parse(_ string: String) -> URL? {
    guard let url = URL(string: string), isAllowed(url) else {
      return nil
    }
    return url
  }
}
