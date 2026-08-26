#import "SHPrivateContextInternal.h"

#include <stdio.h>

void SHFreeError(char *error) {
  free(error);
}

void SHSetError(char **errorOut, const char *message) {
  if (!errorOut) {
    return;
  }
  free(*errorOut);
  *errorOut = message ? strdup(message) : NULL;
}

BOOL SHMethodEncodingMatches(Class cls, SEL sel, const char *expected, BOOL meta) {
  if (cls == Nil || sel == NULL || expected == NULL) {
    return NO;
  }
  if (meta) {
    cls = object_getClass((id)cls);
  }
  Method method = class_getInstanceMethod(cls, sel);
  if (method == NULL) {
    return NO;
  }
  const char *encoding = method_getTypeEncoding(method);
  return encoding != NULL && strcmp(encoding, expected) == 0;
}

BOOL SHMethodShapeMatches(
  Class cls,
  SEL sel,
  char returnCode,
  unsigned nargsIncludingSelfCmd,
  BOOL meta
) {
  if (cls == Nil || sel == NULL) {
    return NO;
  }
  if (meta) {
    cls = object_getClass((id)cls);
  }
  Method method = class_getInstanceMethod(cls, sel);
  if (method == NULL) {
    return NO;
  }
  if (method_getNumberOfArguments(method) != nargsIncludingSelfCmd) {
    return NO;
  }
  char returnType[32] = {0};
  method_getReturnType(method, returnType, sizeof(returnType));
  return returnType[0] == returnCode;
}

id SHInvokeClassObjError(Class cls, SEL sel, id arg, NSError **err) {
  if (cls == Nil || sel == NULL) {
    return nil;
  }
  Class meta = object_getClass((id)cls);
  IMP imp = class_getMethodImplementation(meta, sel);
  if (imp == NULL) {
    return nil;
  }
  typedef id (*Fn)(Class, SEL, id, NSError **);
  return ((Fn)imp)(cls, sel, arg, err);
}

id SHInvokeObjError(id target, SEL sel, NSError **err) {
  if (target == nil || sel == NULL) {
    return nil;
  }
  IMP imp = class_getMethodImplementation(object_getClass(target), sel);
  if (imp == NULL) {
    return nil;
  }
  typedef id (*Fn)(id, SEL, NSError **);
  return ((Fn)imp)(target, sel, err);
}

id SHInvokeObjObjError(id target, SEL sel, id arg, NSError **err) {
  if (target == nil || sel == NULL) {
    return nil;
  }
  IMP imp = class_getMethodImplementation(object_getClass(target), sel);
  if (imp == NULL) {
    return nil;
  }
  typedef id (*Fn)(id, SEL, id, NSError **);
  return ((Fn)imp)(target, sel, arg, err);
}

static BOOL hasSimulatorKit(const char *developerDir) {
  if (developerDir == NULL || developerDir[0] != '/') {
    return NO;
  }
  NSString *path = [[NSString stringWithUTF8String:developerDir]
    stringByAppendingPathComponent:@"Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"];
  return [[NSFileManager defaultManager] isReadableFileAtPath:path];
}

static void *openFramework(const char *path) {
  if (path == NULL) {
    return NULL;
  }
  dlerror();
  return dlopen(path, RTLD_NOW | RTLD_GLOBAL);
}

static BOOL probeCoreSimulator(void) {
  Class ctxClass = NSClassFromString(@"SimServiceContext");
  Class setClass = NSClassFromString(@"SimDeviceSet");
  Class deviceClass = NSClassFromString(@"SimDevice");
  Class typeClass = NSClassFromString(@"SimDeviceType");
  if (ctxClass == Nil || setClass == Nil || deviceClass == Nil || typeClass == Nil) {
    return NO;
  }
  return SHMethodEncodingMatches(
           ctxClass,
           NSSelectorFromString(@"sharedServiceContextForDeveloperDir:error:"),
           "@32@0:8@16^@24",
           YES
         )
    && SHMethodEncodingMatches(
         ctxClass,
         NSSelectorFromString(@"defaultDeviceSetWithError:"),
         "@24@0:8^@16",
         NO
       )
    && SHMethodEncodingMatches(setClass, NSSelectorFromString(@"devices"), "@16@0:8", NO)
    && SHMethodEncodingMatches(setClass, NSSelectorFromString(@"availableDevices"), "@16@0:8", NO)
    && SHMethodEncodingMatches(deviceClass, NSSelectorFromString(@"io"), "@16@0:8", NO)
    && SHMethodEncodingMatches(deviceClass, NSSelectorFromString(@"UDID"), "@16@0:8", NO)
    && SHMethodEncodingMatches(deviceClass, NSSelectorFromString(@"state"), "Q16@0:8", NO)
    && SHMethodEncodingMatches(deviceClass, NSSelectorFromString(@"deviceType"), "@16@0:8", NO)
    && SHMethodEncodingMatches(
         deviceClass,
         NSSelectorFromString(@"sendAccessibilityRequestAsync:completionQueue:completionHandler:"),
         "v40@0:8@16@24@?32",
         NO
       )
    && SHMethodEncodingMatches(
         typeClass,
         NSSelectorFromString(@"mainScreenSize"),
         "{CGSize=dd}16@0:8",
         NO
       )
    && SHMethodEncodingMatches(typeClass, NSSelectorFromString(@"mainScreenScale"), "f16@0:8", NO);
}

static BOOL probeIOClient(void) {
  Class ioClass = NSClassFromString(@"SimDeviceIOClient");
  Class portClass = NSClassFromString(@"SimDeviceIOPort");
  if (ioClass == Nil || portClass == Nil) {
    return NO;
  }
  return SHMethodEncodingMatches(ioClass, NSSelectorFromString(@"updateIOPorts"), "v16@0:8", NO)
    && SHMethodEncodingMatches(ioClass, NSSelectorFromString(@"deviceIOPorts"), "@16@0:8", NO)
    && SHMethodEncodingMatches(portClass, NSSelectorFromString(@"portIdentifier"), "@16@0:8", NO)
    && SHMethodEncodingMatches(portClass, NSSelectorFromString(@"descriptor"), "@16@0:8", NO);
}

static Class hidClientClass(void) {
  Class cls = NSClassFromString(@"SimulatorKit.SimDeviceLegacyHIDClient");
  if (cls == Nil) {
    cls = NSClassFromString(@"_TtC12SimulatorKit24SimDeviceLegacyHIDClient");
  }
  return cls;
}

static BOOL probeHIDClient(void) {
  Class cls = hidClientClass();
  if (cls == Nil) {
    return NO;
  }
  if (!SHMethodEncodingMatches(
        cls,
        NSSelectorFromString(@"initWithDevice:error:"),
        "@32@0:8@16^@24",
        NO
      )) {
    return NO;
  }
  SEL sendSel = NSSelectorFromString(@"sendWithMessage:freeWhenDone:completionQueue:completion:");
  Method method = class_getInstanceMethod(cls, sendSel);
  if (method == NULL || method_getNumberOfArguments(method) != 6) {
    return NO;
  }
  char returnType[8] = {0};
  method_getReturnType(method, returnType, sizeof(returnType));
  if (returnType[0] != 'v') {
    return NO;
  }
  char arg3[8] = {0};
  method_getArgumentType(method, 3, arg3, sizeof(arg3));
  char arg5[8] = {0};
  method_getArgumentType(method, 5, arg5, sizeof(arg5));
  return arg3[0] == 'B' && arg5[0] == '@';
}

static BOOL probeAXP(void) {
  Class translator = NSClassFromString(@"AXPTranslator");
  Class element = NSClassFromString(@"AXPMacPlatformElement");
  if (translator == Nil || element == Nil) {
    return NO;
  }
  return SHMethodEncodingMatches(translator, NSSelectorFromString(@"sharedInstance"), "@16@0:8", YES)
    && SHMethodEncodingMatches(
         translator,
         NSSelectorFromString(@"setAccessibilityEnabled:"),
         "v20@0:8B16",
         NO
       )
    && SHMethodEncodingMatches(
         translator,
         NSSelectorFromString(@"setBridgeTokenDelegate:"),
         "v24@0:8@16",
         NO
       )
    && SHMethodEncodingMatches(
         translator,
         NSSelectorFromString(@"frontmostApplicationWithDisplayId:bridgeDelegateToken:"),
         "@28@0:8I16@20",
         NO
       )
    && SHMethodEncodingMatches(
         translator,
         NSSelectorFromString(@"macPlatformElementFromTranslation:"),
         "@24@0:8@16",
         NO
       )
    && SHMethodEncodingMatches(
         element,
         NSSelectorFromString(@"accessibilityFrame"),
         "{CGRect={CGPoint=dd}{CGSize=dd}}16@0:8",
         NO
       )
    && SHMethodEncodingMatches(
         element,
         NSSelectorFromString(@"accessibilityAttributeValue:"),
         "@24@0:8@16",
         NO
       );
}

static void refreshScreenSize(SHPrivateContextRef ctx) {
  ctx->widthPoints = 0;
  ctx->heightPoints = 0;
  if (ctx->simDevice == nil) {
    return;
  }
  id deviceType = [ctx->simDevice valueForKey:@"deviceType"];
  if (deviceType == nil) {
    return;
  }
  CGSize pixelSize = CGSizeZero;
  SEL sizeSel = NSSelectorFromString(@"mainScreenSize");
  if ([deviceType respondsToSelector:sizeSel]) {
    NSInvocation *inv = [NSInvocation invocationWithMethodSignature:[deviceType methodSignatureForSelector:sizeSel]];
    [inv setTarget:deviceType];
    [inv setSelector:sizeSel];
    [inv invoke];
    [inv getReturnValue:&pixelSize];
  }
  double scale = 3.0;
  id scaleValue = [deviceType valueForKey:@"mainScreenScale"];
  if ([scaleValue isKindOfClass:[NSNumber class]]) {
    scale = [(NSNumber *)scaleValue doubleValue];
  }
  if (pixelSize.width > 0 && pixelSize.height > 0 && scale > 0) {
    ctx->widthPoints = pixelSize.width / scale;
    ctx->heightPoints = pixelSize.height / scale;
  }
}

BOOL SHResolveDevice(SHPrivateContextRef ctx) {
  if (ctx == NULL || ctx->developerDir == NULL || ctx->udid == NULL) {
    return NO;
  }
  Class ctxClass = NSClassFromString(@"SimServiceContext");
  if (ctxClass == Nil) {
    return NO;
  }
  NSError *error = nil;
  NSString *dir = [NSString stringWithUTF8String:ctx->developerDir];
  id service = SHInvokeClassObjError(
    ctxClass,
    NSSelectorFromString(@"sharedServiceContextForDeveloperDir:error:"),
    dir,
    &error
  );
  if (service == nil) {
    return NO;
  }
  error = nil;
  id set = SHInvokeObjError(service, NSSelectorFromString(@"defaultDeviceSetWithError:"), &error);
  if (set == nil) {
    return NO;
  }
  NSArray *devices = [set valueForKey:@"availableDevices"];
  if (![devices isKindOfClass:[NSArray class]] || devices.count == 0) {
    devices = [set valueForKey:@"devices"];
  }
  if (![devices isKindOfClass:[NSArray class]]) {
    return NO;
  }
  NSString *want = [NSString stringWithUTF8String:ctx->udid];
  for (id device in devices) {
    id udidValue = [device valueForKey:@"UDID"];
    NSString *udidString = nil;
    if ([udidValue isKindOfClass:[NSUUID class]]) {
      udidString = [(NSUUID *)udidValue UUIDString];
    } else if ([udidValue isKindOfClass:[NSString class]]) {
      udidString = (NSString *)udidValue;
    }
    if (udidString.length == 0) {
      continue;
    }
    if ([udidString caseInsensitiveCompare:want] != NSOrderedSame) {
      continue;
    }
    ctx->simDevice = device;
    refreshScreenSize(ctx);
    return YES;
  }
  return NO;
}

BOOL SHEnsureHIDClient(SHPrivateContextRef ctx) {
  if (ctx == NULL
      || (!ctx->caps.touch && !ctx->caps.keyboard && !ctx->caps.hardwareButtons)) {
    return NO;
  }
  if (ctx->hidClient != nil) {
    return YES;
  }
  if (ctx->simDevice == nil && !SHResolveDevice(ctx)) {
    return NO;
  }
  Class cls = hidClientClass();
  if (cls == Nil) {
    return NO;
  }
  id allocated = [cls alloc];
  NSError *error = nil;
  id client = SHInvokeObjObjError(
    allocated,
    NSSelectorFromString(@"initWithDevice:error:"),
    ctx->simDevice,
    &error
  );
  if (client == nil) {
    return NO;
  }
  ctx->hidClient = client;
  if (ctx->createPointerSvc) {
    void *msg = ctx->createPointerSvc();
    if (msg) {
      SHSendHIDMessage(ctx, msg);
      usleep(20 * 1000);
    }
  }
  if (ctx->createMouseSvc) {
    void *msg = ctx->createMouseSvc();
    if (msg) {
      SHSendHIDMessage(ctx, msg);
      usleep(20 * 1000);
    }
  }
  return YES;
}

void SHSendHIDMessage(SHPrivateContextRef ctx, void *message) {
  if (ctx == NULL || ctx->hidClient == nil || message == NULL) {
    return;
  }
  SEL sel = NSSelectorFromString(@"sendWithMessage:freeWhenDone:completionQueue:completion:");
  IMP imp = class_getMethodImplementation(object_getClass(ctx->hidClient), sel);
  if (imp == NULL) {
    return;
  }
  typedef void (*Fn)(id, SEL, void *, BOOL, id, id);
  ((Fn)imp)(ctx->hidClient, sel, message, YES, nil, nil);
}

static void fillDisabled(SHCapabilityReport *report) {
  if (report == NULL) {
    return;
  }
  report->stream = false;
  report->touch = false;
  report->keyboard = false;
  report->hardwareButtons = false;
  report->accessibility = false;
}

static void probeCapabilities(SHPrivateContextRef ctx) {
  fillDisabled(&ctx->caps);
  BOOL kit = ctx->simKitHandle != NULL;
  BOOL core = ctx->coreSimHandle != NULL && probeCoreSimulator();
  BOOL io = probeIOClient();
  BOOL hid = kit && probeHIDClient();
  BOOL axp = ctx->axpHandle != NULL && probeAXP();

  ctx->caps.stream = kit && core && io;
  ctx->caps.touch = hid && ctx->mouseFn != NULL;
  ctx->caps.keyboard = hid && ctx->hidArbFn != NULL;
  ctx->caps.hardwareButtons = hid && ctx->buttonFn != NULL && ctx->hidArbFn != NULL;
  ctx->caps.accessibility = axp && core;
}

SHPrivateContextRef SHCreatePrivateContext(
  const char *developerDir,
  const char *udid,
  SHCapabilityReport *report,
  char **errorOut
) {
  if (errorOut) {
    *errorOut = NULL;
  }
  SHPrivateContextRef ctx = calloc(1, sizeof(struct SHPrivateContext));
  if (ctx == NULL) {
    SHSetError(errorOut, "out_of_memory");
    fillDisabled(report);
    return NULL;
  }
  if (developerDir && developerDir[0] == '/') {
    ctx->developerDir = strdup(developerDir);
  }
  if (udid && udid[0] != '\0') {
    ctx->udid = strdup(udid);
  }

  if (hasSimulatorKit(ctx->developerDir)) {
    ctx->coreSimHandle = openFramework(
      "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator"
    );
    ctx->deviceIOHandle = openFramework(
      "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Frameworks/"
      "CoreSimDeviceIO.framework/CoreSimDeviceIO"
    );
    NSString *kitPath = [[NSString stringWithUTF8String:ctx->developerDir]
      stringByAppendingPathComponent:@"Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"];
    ctx->simKitHandle = openFramework([kitPath fileSystemRepresentation]);
    NSBundle *render = [NSBundle bundleWithPath:
      @"/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Resources/"
       "SimRenderingServices.simdeviceio"];
    [render loadAndReturnError:nil];
  }
  ctx->axpHandle = openFramework(
    "/System/Library/PrivateFrameworks/AccessibilityPlatformTranslation.framework/"
    "AccessibilityPlatformTranslation"
  );

  if (ctx->simKitHandle) {
    ctx->mouseFn = (SHIndigoMouseFn)dlsym(ctx->simKitHandle, "IndigoHIDMessageForMouseNSEvent");
    ctx->buttonFn = (SHIndigoButtonFn)dlsym(ctx->simKitHandle, "IndigoHIDMessageForButton");
    ctx->hidArbFn = (SHIndigoHIDArbFn)dlsym(ctx->simKitHandle, "IndigoHIDMessageForHIDArbitrary");
    ctx->createPointerSvc =
      (SHIndigoServiceFn)dlsym(ctx->simKitHandle, "IndigoHIDMessageToCreatePointerService");
    ctx->createMouseSvc =
      (SHIndigoServiceFn)dlsym(ctx->simKitHandle, "IndigoHIDMessageToCreateMouseService");
  }

  probeCapabilities(ctx);
  if (report) {
    *report = ctx->caps;
  }
  if (ctx->udid && (ctx->caps.stream || ctx->caps.touch || ctx->caps.keyboard
                    || ctx->caps.hardwareButtons || ctx->caps.accessibility)) {
    (void)SHResolveDevice(ctx);
  }
  return ctx;
}

void SHDestroyPrivateContext(SHPrivateContextRef ctx) {
  if (ctx == NULL) {
    return;
  }
  SHStopCaptureLocked(ctx);
  ctx->hidClient = nil;
  ctx->simDevice = nil;
  ctx->ioClient = nil;
  ctx->descriptors = nil;
  ctx->callbackUUIDs = nil;
  ctx->translator = nil;
  ctx->axDelegate = nil;
  ctx->captureQueue = nil;
  free(ctx->developerDir);
  free(ctx->udid);
  free(ctx);
}
