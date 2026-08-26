#ifndef SOLENTA_SH_PRIVATE_CONTEXT_INTERNAL_H
#define SOLENTA_SH_PRIVATE_CONTEXT_INTERNAL_H

#import "SimulatorPrivateBridge.h"

#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <CoreVideo/CoreVideo.h>
#import <IOSurface/IOSurface.h>
#import <dispatch/dispatch.h>
#import <objc/runtime.h>
#import <objc/message.h>
#import <dlfcn.h>
#import <stdlib.h>
#import <string.h>

NS_ASSUME_NONNULL_BEGIN

typedef void *_Nullable (*SHIndigoMouseFn)(
  CGPoint *point0,
  CGPoint *_Nullable point1,
  uint32_t target,
  uint32_t eventType,
  uint32_t edge,
  double width,
  double height
);

typedef void *_Nullable (*SHIndigoButtonFn)(uint32_t arg0, uint32_t direction, uint32_t target);
typedef void *_Nullable (*SHIndigoHIDArbFn)(uint32_t target, uint32_t page, uint32_t usage, uint32_t operation);
typedef void *_Nullable (*SHIndigoServiceFn)(void);

enum {
  SHIndigoTouchDigitizer = 0x32u,
  SHIndigoButtonTarget = 0x33u,
  SHIndigoNSEventDown = 1u,
  SHIndigoNSEventUp = 2u,
  SHIndigoNSEventDragged = 6u,
  SHIndigoEdgeNone = 0u,
  SHIndigoDirDown = 1u,
  SHIndigoDirUp = 2u,
  SHIndigoHIDPageKeyboard = 7u,
  SHIndigoHIDPageTelephony = 11u,
  SHIndigoHIDPageConsumer = 12u
};

enum {
  SHKeyModifierShift = 1u << 0,
  SHKeyModifierControl = 1u << 1,
  SHKeyModifierOption = 1u << 2,
  SHKeyModifierCommand = 1u << 3
};

static const uint32_t kSHAXMaxNodes = 128;
static const uint32_t kSHAXHardDepthCap = 16;

struct SHPrivateContext {
  char *_Nullable developerDir;
  char *_Nullable udid;
  SHCapabilityReport caps;

  void *_Nullable coreSimHandle;
  void *_Nullable simKitHandle;
  void *_Nullable axpHandle;
  void *_Nullable deviceIOHandle;

  SHIndigoMouseFn _Nullable mouseFn;
  SHIndigoButtonFn _Nullable buttonFn;
  SHIndigoHIDArbFn _Nullable hidArbFn;
  SHIndigoServiceFn _Nullable createPointerSvc;
  SHIndigoServiceFn _Nullable createMouseSvc;

  __strong id _Nullable simDevice;
  __strong id _Nullable hidClient;
  __strong id _Nullable ioClient;
  __strong NSMutableArray *_Nullable descriptors;
  __strong NSMutableDictionary *_Nullable callbackUUIDs;
  __strong id _Nullable translator;
  __strong id _Nullable axDelegate;
  __strong dispatch_queue_t _Nullable captureQueue;

  SHFrameCallback _Nullable frameCallback;
  void *_Nullable frameUser;
  BOOL captureActive;
  double widthPoints;
  double heightPoints;
};

void SHSetError(char *_Nullable *_Nullable errorOut, const char *message);
BOOL SHMethodEncodingMatches(Class _Nullable cls, SEL sel, const char *expected, BOOL meta);
BOOL SHMethodShapeMatches(
  Class _Nullable cls,
  SEL sel,
  char returnCode,
  unsigned nargsIncludingSelfCmd,
  BOOL meta
);
id _Nullable SHInvokeClassObjError(Class cls, SEL sel, id _Nullable arg, NSError *_Nullable *_Nullable err);
id _Nullable SHInvokeObjError(id target, SEL sel, NSError *_Nullable *_Nullable err);
id _Nullable SHInvokeObjObjError(id target, SEL sel, id arg, NSError *_Nullable *_Nullable err);
BOOL SHResolveDevice(SHPrivateContextRef ctx);
BOOL SHEnsureHIDClient(SHPrivateContextRef ctx);
void SHSendHIDMessage(SHPrivateContextRef ctx, void *message);
void SHStopCaptureLocked(SHPrivateContextRef ctx);

@interface SHAXBridgeDelegate : NSObject
@property (nonatomic, assign) SHPrivateContextRef ctx;
@end

NS_ASSUME_NONNULL_END

#endif
