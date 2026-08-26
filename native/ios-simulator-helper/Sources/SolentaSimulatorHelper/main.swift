import Foundation

do {
  try runHelper()
} catch {
  let text = (error as? HelperError)?.description ?? String(describing: error)
  try? FileHandle.standardError.write(contentsOf: Data("\(text)\n".utf8))
  exit(1)
}
