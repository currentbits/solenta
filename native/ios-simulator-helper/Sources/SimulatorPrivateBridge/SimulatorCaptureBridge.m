#import "SHPrivateContextInternal.h"

@interface SHCaptureState : NSObject
@property(nonatomic, assign) SHPrivateContextRef context;
@end
@implementation SHCaptureState
@end

static BOOL modernCallbackOK(id descriptor, NSString *name, NSString *removeName) {
  SEL selector = NSSelectorFromString(name);
  // CoreSimulator's ROCK proxies forward these methods without class IMPs.
  NSMethodSignature *signature = [descriptor methodSignatureForSelector:selector];
  NSMethodSignature *remove = [descriptor methodSignatureForSelector:NSSelectorFromString(removeName)];
  return signature && signature.methodReturnType[0] == 'v' && signature.numberOfArguments == 4
    && [signature getArgumentTypeAtIndex:2][0] == '@'
    && strcmp([signature getArgumentTypeAtIndex:3], "@?") == 0
    && remove && remove.methodReturnType[0] == 'v' && remove.numberOfArguments == 3
    && [remove getArgumentTypeAtIndex:2][0] == '@';
}

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
    if (surfaceObj == nil || CFGetTypeID((__bridge CFTypeRef)surfaceObj) != IOSurfaceGetTypeID()) {
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
  SHCaptureState *state = ctx->captureState;
  @synchronized(state) { state.context = NULL; }
  SEL unreg = NSSelectorFromString(@"unregisterScreenCallbacksWithUUID:");
  for (id desc in ctx->descriptors) {
    NSDictionary *ids = ctx->callbackUUIDs[[NSValue valueWithNonretainedObject:desc]];
    for (NSString *name in ids) {
      SEL remove = [name isEqualToString:@"damage"]
        ? NSSelectorFromString(@"unregisterDamageRectanglesCallbackWithUUID:")
        : [name isEqualToString:@"surfaces"]
          ? NSSelectorFromString(@"unregisterIOSurfacesChangeCallbackWithUUID:") : unreg;
      if ([desc respondsToSelector:remove]) {
        ((void (*)(id, SEL, id))objc_msgSend)(desc, remove, ids[name]);
      }
    }
  }
  ctx->descriptors = nil;
  ctx->callbackUUIDs = nil;
  ctx->ioClient = nil;
  ctx->frameCallback = NULL;
  ctx->frameUser = NULL;
  ctx->captureActive = NO;
  ctx->captureState = nil;
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
  NSArray *ports = [io valueForKey:[io respondsToSelector:NSSelectorFromString(@"ioPorts")] ? @"ioPorts" : @"deviceIOPorts"];
  if (![ports isKindOfClass:[NSArray class]]) {
    SHSetError(errorOut, "capability_unavailable");
    return false;
  }

  SEL descSel = NSSelectorFromString(@"descriptor");
  SEL surfSel = NSSelectorFromString(@"framebufferSurface");
  SEL regSel = NSSelectorFromString(
    @"registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:"
  );

  id best = nil;
  size_t bestArea = 0;
  for (id port in ports) {
    if (![port respondsToSelector:descSel]) {
      continue;
    }
    id desc = ((id (*)(id, SEL))objc_msgSend)(port, descSel);
    if (desc == nil || ![desc respondsToSelector:surfSel]) {
      continue;
    }
    BOOL modern = modernCallbackOK(desc, @"registerCallbackWithUUID:damageRectanglesCallback:", @"unregisterDamageRectanglesCallbackWithUUID:")
      || modernCallbackOK(desc, @"registerCallbackWithUUID:ioSurfacesChangeCallback:", @"unregisterIOSurfacesChangeCallbackWithUUID:");
    if (!modern && !callbackEncodingOK(desc, regSel)) {
      continue;
    }
    id surface = ((id (*)(id, SEL))objc_msgSend)(desc, surfSel);
    if (surface == nil || CFGetTypeID((__bridge CFTypeRef)surface) != IOSurfaceGetTypeID()) continue;
    size_t area = IOSurfaceGetWidth((__bridge IOSurfaceRef)surface) * IOSurfaceGetHeight((__bridge IOSurfaceRef)surface);
    if (area > bestArea) { best = desc; bestArea = area; }
  }
  if (best == nil) {
    SHSetError(errorOut, "capability_unavailable");
    return false;
  }

  SHStopCaptureLocked(ctx);
  ctx->ioClient = io;
  ctx->descriptors = [NSMutableArray arrayWithObject:best];
  ctx->callbackUUIDs = [NSMutableDictionary dictionary];
  ctx->frameCallback = callback;
  ctx->frameUser = user;
  SHCaptureState *state = [SHCaptureState new];
  state.context = ctx;
  ctx->captureState = state;
  if (ctx->captureQueue == nil) {
    ctx->captureQueue = dispatch_queue_create("solenta.simulator.capture", DISPATCH_QUEUE_SERIAL);
  }

  for (id desc in ctx->descriptors) {
    NSMutableDictionary *ids = [NSMutableDictionary new];
    ctx->callbackUUIDs[[NSValue valueWithNonretainedObject:desc]] = ids;
    BOOL modern = NO;
    // Adapted from Synara FrameStream/CoreSimulatorBridge at c96b828.
    if (modernCallbackOK(desc, @"registerCallbackWithUUID:damageRectanglesCallback:", @"unregisterDamageRectanglesCallbackWithUUID:")) {
      NSUUID *uuid = [NSUUID UUID];
      ids[@"damage"] = uuid;
      void (^frame)(id) = ^(id ignored) {
        @synchronized(state) { captureLatest(state.context); }
      };
      ((void (*)(id, SEL, id, id))objc_msgSend)(desc,
        NSSelectorFromString(@"registerCallbackWithUUID:damageRectanglesCallback:"), uuid, frame);
      modern = YES;
    }
    if (modernCallbackOK(desc, @"registerCallbackWithUUID:ioSurfacesChangeCallback:", @"unregisterIOSurfacesChangeCallbackWithUUID:")) {
      NSUUID *uuid = [NSUUID UUID];
      ids[@"surfaces"] = uuid;
      void (^surfaces)(id, id) = ^(id ignored, id updated) {
        @synchronized(state) { captureLatest(state.context); }
      };
      ((void (*)(id, SEL, id, id))objc_msgSend)(desc,
        NSSelectorFromString(@"registerCallbackWithUUID:ioSurfacesChangeCallback:"), uuid, surfaces);
      modern = YES;
    }
    if (modern) continue;
    NSUUID *uuid = [NSUUID UUID];
    ids[@"legacy"] = uuid;
    void (^frame)(void) = ^{
      @synchronized(state) { captureLatest(state.context); }
    };
    void (^surfaces)(void) = ^{
      @synchronized(state) { captureLatest(state.context); }
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
  @synchronized(state) { captureLatest(state.context); }
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
