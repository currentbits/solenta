import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import ImageIO
import VideoToolbox

final class H264Session: @unchecked Sendable {
  static let defaultFPS: Int32 = 30
  static let defaultBitrate = 1_500_000
  static let keyframeInterval = 30
  static let jpegQuality: Double = 0.7

  struct Encoded: Equatable {
    var kind: VideoRecordType
    var payload: Data
    var width: Int
    var height: Int
    var timestampUs: UInt64
  }

  private let lock = NSLock()
  private var session: VTCompressionSession?
  private var width: Int32 = 0
  private var height: Int32 = 0
  private var bitrate: Int
  private var emittedDescription = false
  private var pendingForceKeyframe = true
  private var pendingJPEGSeed = true
  private var frameCount: Int64 = 0
  var onEncoded: ((Encoded) -> Void)?

  init(bitrate: Int = H264Session.defaultBitrate, onEncoded: ((Encoded) -> Void)? = nil) {
    self.bitrate = max(500_000, bitrate)
    self.onEncoded = onEncoded
  }

  deinit {
    if let session {
      VTCompressionSessionInvalidate(session)
    }
  }

  func setBitrate(_ bps: Int) {
    lock.lock()
    defer { lock.unlock() }
    bitrate = max(500_000, bps)
    guard let session else { return }
    VTSessionSetProperty(
      session,
      key: kVTCompressionPropertyKey_AverageBitRate,
      value: NSNumber(value: bitrate)
    )
  }

  func requestKeyframe() {
    lock.lock()
    pendingForceKeyframe = true
    lock.unlock()
  }

  func requestJPEGSeed() {
    lock.lock()
    pendingJPEGSeed = true
    lock.unlock()
  }

  func encode(pixelBuffer: CVPixelBuffer, timestampUs: Int64) {
    let w = Int32(CVPixelBufferGetWidth(pixelBuffer))
    let h = Int32(CVPixelBufferGetHeight(pixelBuffer))
    lock.lock()
    if session == nil || w != width || h != height {
      width = w
      height = h
      rebuildSession()
      pendingForceKeyframe = true
      pendingJPEGSeed = true
    }
    let emitJPEG = pendingJPEGSeed
    if emitJPEG {
      pendingJPEGSeed = false
    }
    let force = pendingForceKeyframe
    pendingForceKeyframe = false
    let currentSession = session
    frameCount += 1
    let pts = CMTime(value: frameCount, timescale: H264Session.defaultFPS)
    lock.unlock()

    if emitJPEG, let jpeg = encodeJPEG(pixelBuffer) {
      onEncoded?(
        Encoded(
          kind: .jpeg,
          payload: jpeg,
          width: Int(w),
          height: Int(h),
          timestampUs: UInt64(max(0, timestampUs))
        )
      )
    }

    guard let currentSession else { return }
    let frameProps: CFDictionary? = force
      ? [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue as Any] as CFDictionary
      : nil
    VTCompressionSessionEncodeFrame(
      currentSession,
      imageBuffer: pixelBuffer,
      presentationTimeStamp: pts,
      duration: .invalid,
      frameProperties: frameProps,
      infoFlagsOut: nil
    ) { [weak self] status, _, sampleBuffer in
      guard let self, status == noErr, let sampleBuffer else { return }
      self.emit(from: sampleBuffer, timestampUs: timestampUs, width: Int(w), height: Int(h))
    }
  }

  private func rebuildSession() {
    if let session {
      VTCompressionSessionInvalidate(session)
      self.session = nil
    }
    var sess: VTCompressionSession?
    let status = VTCompressionSessionCreate(
      allocator: kCFAllocatorDefault,
      width: width,
      height: height,
      codecType: kCMVideoCodecType_H264,
      encoderSpecification: nil,
      imageBufferAttributes: nil,
      compressedDataAllocator: kCFAllocatorDefault,
      outputCallback: nil,
      refcon: nil,
      compressionSessionOut: &sess
    )
    guard status == noErr, let sess else { return }
    let props: [(CFString, Any)] = [
      (kVTCompressionPropertyKey_RealTime, kCFBooleanTrue as Any),
      (kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_Baseline_AutoLevel),
      (kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse as Any),
      (kVTCompressionPropertyKey_AverageBitRate, NSNumber(value: bitrate)),
      (kVTCompressionPropertyKey_ExpectedFrameRate, NSNumber(value: H264Session.defaultFPS)),
      (kVTCompressionPropertyKey_MaxKeyFrameInterval, NSNumber(value: H264Session.keyframeInterval)),
    ]
    for (key, value) in props {
      VTSessionSetProperty(sess, key: key, value: value as CFTypeRef)
    }
    VTCompressionSessionPrepareToEncodeFrames(sess)
    session = sess
    emittedDescription = false
  }

  private func emit(from sample: CMSampleBuffer, timestampUs: Int64, width: Int, height: Int) {
    let isKeyframe = !sampleNotSync(sample)
    guard let dataBuf = CMSampleBufferGetDataBuffer(sample) else { return }
    var totalLength = 0
    var dataPointer: UnsafeMutablePointer<Int8>?
    guard CMBlockBufferGetDataPointer(
      dataBuf,
      atOffset: 0,
      lengthAtOffsetOut: nil,
      totalLengthOut: &totalLength,
      dataPointerOut: &dataPointer
    ) == noErr, let dataPointer, totalLength > 0 else {
      return
    }
    let avcc = Data(bytes: dataPointer, count: totalLength)
    let ts = UInt64(max(0, timestampUs))
    lock.lock()
    let shouldEmitDescription = isKeyframe && !emittedDescription
    if shouldEmitDescription {
      emittedDescription = true
    }
    lock.unlock()
    if shouldEmitDescription, let format = CMSampleBufferGetFormatDescription(sample),
       let avcC = avcCBlob(from: format)
    {
      onEncoded?(
        Encoded(kind: .avcC, payload: avcC, width: 0, height: 0, timestampUs: ts)
      )
    }
    onEncoded?(
      Encoded(
        kind: isKeyframe ? .key : .delta,
        payload: avcc,
        width: width,
        height: height,
        timestampUs: ts
      )
    )
  }

  private func sampleNotSync(_ sample: CMSampleBuffer) -> Bool {
    guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false),
          CFArrayGetCount(attachments) > 0,
          let dict = CFArrayGetValueAtIndex(attachments, 0)
    else {
      return false
    }
    let cfDict = unsafeBitCast(dict, to: CFDictionary.self)
    return CFDictionaryContainsKey(
      cfDict,
      Unmanaged.passUnretained(kCMSampleAttachmentKey_NotSync).toOpaque()
    )
  }

  static func avcCBlob(from format: CMFormatDescription) -> Data? {
    var spsCount = 0
    var spsPtr: UnsafePointer<UInt8>?
    var spsSize = 0
    var nalSize: Int32 = 0
    guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
      format,
      parameterSetIndex: 0,
      parameterSetPointerOut: &spsPtr,
      parameterSetSizeOut: &spsSize,
      parameterSetCountOut: &spsCount,
      nalUnitHeaderLengthOut: &nalSize
    ) == noErr, let spsPtr, spsSize >= 4 else {
      return nil
    }
    var ppsPtr: UnsafePointer<UInt8>?
    var ppsSize = 0
    guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
      format,
      parameterSetIndex: 1,
      parameterSetPointerOut: &ppsPtr,
      parameterSetSizeOut: &ppsSize,
      parameterSetCountOut: nil,
      nalUnitHeaderLengthOut: nil
    ) == noErr, let ppsPtr else {
      return nil
    }
    let sps = UnsafeBufferPointer(start: spsPtr, count: spsSize)
    let pps = UnsafeBufferPointer(start: ppsPtr, count: ppsSize)
    var blob = Data()
    blob.append(0x01)
    blob.append(sps[1])
    blob.append(sps[2])
    blob.append(sps[3])
    blob.append(0xFF)
    blob.append(0xE1)
    blob.append(UInt8((spsSize >> 8) & 0xFF))
    blob.append(UInt8(spsSize & 0xFF))
    blob.append(contentsOf: sps)
    blob.append(0x01)
    blob.append(UInt8((ppsSize >> 8) & 0xFF))
    blob.append(UInt8(ppsSize & 0xFF))
    blob.append(contentsOf: pps)
    return blob
  }

  private func avcCBlob(from format: CMFormatDescription) -> Data? {
    Self.avcCBlob(from: format)
  }

  static func encodeJPEG(_ pixelBuffer: CVPixelBuffer, quality: Double = jpegQuality) -> Data? {
    CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
    let width = CVPixelBufferGetWidth(pixelBuffer)
    let height = CVPixelBufferGetHeight(pixelBuffer)
    let stride = CVPixelBufferGetBytesPerRow(pixelBuffer)
    guard let base = CVPixelBufferGetBaseAddress(pixelBuffer) else { return nil }
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    guard let context = CGContext(
      data: base,
      width: width,
      height: height,
      bitsPerComponent: 8,
      bytesPerRow: stride,
      space: colorSpace,
      bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
    ), let image = context.makeImage() else {
      return nil
    }
    let out = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(out, "public.jpeg" as CFString, 1, nil) else {
      return nil
    }
    CGImageDestinationAddImage(
      dest,
      image,
      [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary
    )
    guard CGImageDestinationFinalize(dest) else { return nil }
    return out as Data
  }

  private func encodeJPEG(_ pixelBuffer: CVPixelBuffer) -> Data? {
    Self.encodeJPEG(pixelBuffer)
  }
}
