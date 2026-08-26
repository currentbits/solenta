#import "SHPrivateContextInternal.h"

static CVPixelBufferRef copyPixelBuffer(CVPixelBufferRef source) {
  if (source == NULL) {
    return NULL;
  }
  size_t width = CVPixelBufferGetWidth(source);
  size_t height = CVPixelBufferGetHeight(source);
  if (width == 0 || height == 0) {
    return NULL;
  }
  OSType format = kCVPixelFormatType_32BGRA;
  NSDictionary *attrs = @{
    (id)kCVPixelBufferIOSurfacePropertiesKey: @{},
  };
  CVPixelBufferRef dest = NULL;
  if (CVPixelBufferCreate(
        kCFAllocatorDefault,
        width,
        height,
        format,
        (__bridge CFDictionaryRef)attrs,
        &dest
      ) != kCVReturnSuccess
      || dest == NULL) {
    return NULL;
  }
  if (CVPixelBufferLockBaseAddress(source, kCVPixelBufferLock_ReadOnly) != kCVReturnSuccess) {
    CVPixelBufferRelease(dest);
    return NULL;
  }
  if (CVPixelBufferLockBaseAddress(dest, 0) != kCVReturnSuccess) {
    CVPixelBufferUnlockBaseAddress(source, kCVPixelBufferLock_ReadOnly);
    CVPixelBufferRelease(dest);
    return NULL;
  }
  size_t srcStride = CVPixelBufferGetBytesPerRow(source);
  size_t dstStride = CVPixelBufferGetBytesPerRow(dest);
  size_t row = width * 4;
  if (row > srcStride) {
    row = srcStride;
  }
  if (row > dstStride) {
    row = dstStride;
  }
  const uint8_t *src = CVPixelBufferGetBaseAddress(source);
  uint8_t *dst = CVPixelBufferGetBaseAddress(dest);
  if (src && dst) {
    for (size_t y = 0; y < height; y++) {
      memcpy(dst + y * dstStride, src + y * srcStride, row);
    }
  }
  CVPixelBufferUnlockBaseAddress(dest, 0);
  CVPixelBufferUnlockBaseAddress(source, kCVPixelBufferLock_ReadOnly);
  return dest;
}

static CVPixelBufferRef pixelBufferFromSurface(IOSurfaceRef surface) {
  if (surface == NULL) {
    return NULL;
  }
  CVPixelBufferRef wrapped = NULL;
  NSDictionary *attrs = @{
    (id)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32BGRA),
  };
  if (CVPixelBufferCreateWithIOSurface(
        kCFAllocatorDefault,
        surface,
        (__bridge CFDictionaryRef)attrs,
        &wrapped
      ) != kCVReturnSuccess) {
    return NULL;
  }
  CVPixelBufferRef copy = copyPixelBuffer(wrapped);
  CVPixelBufferRelease(wrapped);
  return copy;
}

static BOOL callbackEncodingOK(id desc, SEL sel) {
  if (desc == nil || ![desc respondsToSelector:sel]) {
    return NO;
  }
  Method method = class_getInstanceMethod(object_getClass(desc), sel);
  if (method == NULL || method_getNumberOfArguments(method) != 7) {
    return NO;
  }
  char ret[8] = {0};
  method_getReturnType(method, ret, sizeof(ret));
  if (ret[0] != 'v') {
    return NO;
  }
  char a2[8] = {0};
  char a3[8] = {0};
  method_getArgumentType(method, 2, a2, sizeof(a2));
  method_getArgumentType(method, 3, a3, sizeof(a3));
  return a2[0] == '@' && a3[0] == '@';
}

static void captureLatest(SHPrivateContextRef ctx) {
  if (ctx == NULL || ctx->frameCallback == NULL || ctx->descriptors.count == 0) {
    return;
  }
  SEL surfSel = NSSelectorFromString(@"framebufferSurface");
  IOSurfaceRef best = NULL;
  size_t bestArea = 0;
  for (id desc in ctx->descriptors) {
    if (![desc respondsToSelector:surfSel]) {
      continue;
    }
    IMP imp = class_getMethodImplementation(object_getClass(desc), surfSel);
    if (imp == NULL) {
      continue;
    }
    typedef id (*Fn)(id, SEL);
    id surfaceObj = ((Fn)imp)(desc, surfSel);
    if (surfaceObj == nil) {
      continue;
    }
    IOSurfaceRef surface = (__bridge IOSurfaceRef)surfaceObj;
    size_t area = IOSurfaceGetWidth(surface) * IOSurfaceGetHeight(surface);
    if (area > bestArea) {
      best = surface;
      bestArea = area;
    }
  }
  if (best == NULL) {
    return;
  }
  CVPixelBufferRef copy = pixelBufferFromSurface(best);
  if (copy == NULL) {
    return;
  }
  int64_t timestampUs = (int64_t)([[NSDate date] timeIntervalSince1970] * 1e6);
  ctx->frameCallback(ctx->frameUser, copy, timestampUs);
}

void SHStopCaptureLocked(SHPrivateContextRef ctx) {
  if (ctx == NULL) {
    return;
  }
  SEL unreg = NSSelectorFromString(@"unregisterScreenCallbacksWithUUID:");
  for (id desc in ctx->descriptors) {
    NSUUID *uuid = ctx->callbackUUIDs[[NSValue valueWithNonretainedObject:desc]];
    if (uuid && [desc respondsToSelector:unreg]) {
      ((void (*)(id, SEL, id))objc_msgSend)(desc, unreg, uuid);
    }
  }
  ctx->descriptors = nil;
  ctx->callbackUUIDs = nil;
  ctx->ioClient = nil;
  ctx->frameCallback = NULL;
  ctx->frameUser = NULL;
  ctx->captureActive = NO;
}

bool SHStartCapture(
  SHPrivateContextRef ctx,
  SHFrameCallback callback,
  void *user,
  char **errorOut
) {
  if (errorOut) {
    *errorOut = NULL;
  }
  if (ctx == NULL || callback == NULL) {
    SHSetError(errorOut, "capability_unavailable");
    return false;
  }
  if (!ctx->caps.stream) {
    SHSetError(errorOut, "capability_unavailable");
    return false;
  }
  if (ctx->simDevice == nil && !SHResolveDevice(ctx)) {
    SHSetError(errorOut, "device_missing");
    return false;
  }

  SEL ioSel = NSSelectorFromString(@"io");
  if (![ctx->simDevice respondsToSelector:ioSel]) {
    SHSetError(errorOut, "capability_unavailable");
    return false;
  }
  typedef id (*IoFn)(id, SEL);
  IMP ioImp = class_getMethodImplementation(object_getClass(ctx->simDevice), ioSel);
  if (ioImp == NULL) {
    SHSetError(errorOut, "capability_unavailable");
    return false;
  }
  id io = ((IoFn)ioImp)(ctx->simDevice, ioSel);
  if (io == nil) {
    SHSetError(errorOut, "capability_unavailable");
    return false;
  }
  ctx->ioClient = io;
  ((void (*)(id, SEL))objc_msgSend)(io, NSSelectorFromString(@"updateIOPorts"));
  NSArray *ports = [io valueForKey:@"deviceIOPorts"];
  if (![ports isKindOfClass:[NSArray class]]) {
    SHSetError(errorOut, "capability_unavailable");
    return false;
  }

  SEL pidSel = NSSelectorFromString(@"portIdentifier");
  SEL descSel = NSSelectorFromString(@"descriptor");
  SEL surfSel = NSSelectorFromString(@"framebufferSurface");
  SEL regSel = NSSelectorFromString(
    @"registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:"
  );

  NSMutableArray *candidates = [NSMutableArray array];
  for (id port in ports) {
    if (![port respondsToSelector:pidSel] || ![port respondsToSelector:descSel]) {
      continue;
    }
    id pid = ((id (*)(id, SEL))objc_msgSend)(port, pidSel);
    if ([[pid description] isEqualToString:@"com.apple.framebuffer.display"] == NO) {
      continue;
    }
    id desc = ((id (*)(id, SEL))objc_msgSend)(port, descSel);
    if (desc == nil || ![desc respondsToSelector:surfSel]) {
      continue;
    }
    if (!callbackEncodingOK(desc, regSel)) {
      continue;
    }
    [candidates addObject:desc];
  }
  if (candidates.count == 0) {
    SHSetError(errorOut, "capability_unavailable");
    return false;
  }

  SHStopCaptureLocked(ctx);
  ctx->ioClient = io;
  ctx->descriptors = candidates;
  ctx->callbackUUIDs = [NSMutableDictionary dictionary];
  ctx->frameCallback = callback;
  ctx->frameUser = user;
  if (ctx->captureQueue == nil) {
    ctx->captureQueue = dispatch_queue_create("solenta.simulator.capture", DISPATCH_QUEUE_SERIAL);
  }

  for (id desc in candidates) {
    NSUUID *uuid = [NSUUID UUID];
    ctx->callbackUUIDs[[NSValue valueWithNonretainedObject:desc]] = uuid;
    void (^frame)(void) = ^{
      captureLatest(ctx);
    };
    void (^surfaces)(void) = ^{
      captureLatest(ctx);
    };
    void (^props)(void) = ^{
    };
    IMP imp = class_getMethodImplementation(object_getClass(desc), regSel);
    if (imp == NULL) {
      SHStopCaptureLocked(ctx);
      SHSetError(errorOut, "capability_unavailable");
      return false;
    }
    typedef void (*RegFn)(id, SEL, id, id, id, id, id);
    ((RegFn)imp)(desc, regSel, uuid, ctx->captureQueue, frame, surfaces, props);
  }
  ctx->captureActive = YES;
  return true;
}

bool SHStopCapture(SHPrivateContextRef ctx, char **errorOut) {
  if (errorOut) {
    *errorOut = NULL;
  }
  if (ctx == NULL) {
    SHSetError(errorOut, "capability_unavailable");
    return false;
  }
  SHStopCaptureLocked(ctx);
  return true;
}
