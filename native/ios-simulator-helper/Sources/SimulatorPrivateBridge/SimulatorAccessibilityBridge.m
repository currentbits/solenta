#import "SHPrivateContextInternal.h"

@implementation SHAXBridgeDelegate

- (id)accessibilityTranslationDelegateBridgeCallbackWithToken:(NSString *)token {
  (void)token;
  SHPrivateContextRef ctx = self.ctx;
  id device = ctx ? ctx->simDevice : nil;
  id block = ^id(id axRequest) {
    if (device == nil || axRequest == nil) {
      return nil;
    }
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    __block id response = nil;
    SEL sel = NSSelectorFromString(@"sendAccessibilityRequestAsync:completionQueue:completionHandler:");
    NSMethodSignature *sig = [device methodSignatureForSelector:sel];
    if (sig == nil) {
      return nil;
    }
    NSInvocation *inv = [NSInvocation invocationWithMethodSignature:sig];
    [inv setTarget:device];
    [inv setSelector:sel];
    id request = axRequest;
    [inv setArgument:&request atIndex:2];
    dispatch_queue_t queue = dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0);
    [inv setArgument:&queue atIndex:3];
    void (^handler)(id) = ^(id value) {
      response = value;
      dispatch_semaphore_signal(sem);
    };
    void (^copiedHandler)(id) = [handler copy];
    [inv setArgument:&copiedHandler atIndex:4];
    [inv retainArguments];
    [inv invoke];
    dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC));
    id result = response;
#if !__has_feature(objc_arc)
    [copiedHandler release];
#else
    copiedHandler = nil;
#endif
    return result;
  };
  return [block copy];
}

- (CGRect)accessibilityTranslationConvertPlatformFrameToSystem:(CGRect)rect
                                                     withToken:(NSString *)token {
  (void)token;
  return rect;
}

- (id)accessibilityTranslationRootParentWithToken:(NSString *)token {
  (void)token;
  return nil;
}

@end

static id axAttribute(id elem, NSString *name) {
  if (elem == nil || name == nil) {
    return nil;
  }
  SEL sel = NSSelectorFromString(@"accessibilityAttributeValue:");
  if (![elem respondsToSelector:sel]) {
    return nil;
  }
  IMP imp = class_getMethodImplementation(object_getClass(elem), sel);
  if (imp == NULL) {
    return nil;
  }
  typedef id (*Fn)(id, SEL, id);
  id result = nil;
  @try {
    result = ((Fn)imp)(elem, sel, name);
  } @catch (NSException *exception) {
    return nil;
  }
  return result;
}

static NSString *axString(id elem, NSString *attribute, SEL fallbackSel) {
  if (fallbackSel && [elem respondsToSelector:fallbackSel]) {
    IMP imp = class_getMethodImplementation(object_getClass(elem), fallbackSel);
    if (imp) {
      typedef id (*Fn)(id, SEL);
      id value = ((Fn)imp)(elem, fallbackSel);
      if ([value isKindOfClass:[NSString class]] && [(NSString *)value length] > 0) {
        return value;
      }
    }
  }
  id value = axAttribute(elem, attribute);
  if ([value isKindOfClass:[NSString class]] && [(NSString *)value length] > 0) {
    return value;
  }
  if (value != nil && ![value isKindOfClass:[NSString class]]) {
    return [value description];
  }
  return nil;
}

static BOOL axBool(id elem, NSString *attribute, BOOL fallback) {
  id value = axAttribute(elem, attribute);
  if ([value isKindOfClass:[NSNumber class]]) {
    return [(NSNumber *)value boolValue];
  }
  return fallback;
}

static CGRect axFrame(id elem) {
  SEL sel = NSSelectorFromString(@"accessibilityFrame");
  if ([elem respondsToSelector:sel]) {
    IMP imp = class_getMethodImplementation(object_getClass(elem), sel);
    if (imp) {
      typedef CGRect (*Fn)(id, SEL);
      return ((Fn)imp)(elem, sel);
    }
  }
  id value = axAttribute(elem, @"AXFrame");
  if ([value isKindOfClass:[NSValue class]]) {
    return [(NSValue *)value rectValue];
  }
  return CGRectZero;
}

static NSArray *axChildren(id elem) {
  id value = axAttribute(elem, @"AXChildren");
  if ([value isKindOfClass:[NSArray class]]) {
    return value;
  }
  @try {
    value = [elem valueForKey:@"accessibilityChildren"];
    if ([value isKindOfClass:[NSArray class]]) {
      return value;
    }
  } @catch (NSException *exception) {
  }
  return nil;
}

static CGRect mapFrame(CGRect macFrame, CGRect rootFrame, CGSize pointSize) {
  if (rootFrame.size.width <= 0 || rootFrame.size.height <= 0
      || pointSize.width <= 0 || pointSize.height <= 0) {
    return macFrame;
  }
  double scale = pointSize.width / rootFrame.size.width;
  double yOffset = (pointSize.height - rootFrame.size.height * scale) / 2.0;
  return CGRectMake(
    (macFrame.origin.x - rootFrame.origin.x) * scale,
    (macFrame.origin.y - rootFrame.origin.y) * scale + yOffset,
    macFrame.size.width * scale,
    macFrame.size.height * scale
  );
}

static void stampToken(id object, NSString *token) {
  if (object == nil || token == nil) {
    return;
  }
  @try {
    [object setValue:token forKey:@"bridgeDelegateToken"];
  } @catch (NSException *exception) {
  }
}

static void stampElement(id element, NSString *token) {
  if (element == nil) {
    return;
  }
  @try {
    id translation = [element valueForKey:@"translation"];
    stampToken(translation, token);
  } @catch (NSException *exception) {
  }
}

static NSMutableDictionary *walkNode(
  id elem,
  NSString *token,
  CGRect rootFrame,
  CGSize pointSize,
  uint32_t depth,
  uint32_t maxDepth,
  uint32_t *nodeCount
) {
  if (elem == nil || *nodeCount >= kSHAXMaxNodes) {
    return nil;
  }
  stampElement(elem, token);
  *nodeCount += 1;

  NSString *role = axString(elem, @"AXRole", NSSelectorFromString(@"accessibilityRole"));
  if (role == nil) {
    role = axString(elem, @"AXRole", NSSelectorFromString(@"role"));
  }
  NSString *label = axString(elem, @"AXLabel", NSSelectorFromString(@"accessibilityLabel"));
  if (label == nil) {
    label = axString(elem, @"AXDescription", NULL);
  }
  NSString *identifier = axString(elem, @"AXIdentifier", NULL);
  NSString *value = axString(elem, @"AXValue", NULL);
  BOOL enabled = axBool(elem, @"AXEnabled", YES);
  BOOL selected = axBool(elem, @"AXSelected", NO);
  CGRect frame = mapFrame(axFrame(elem), rootFrame, pointSize);

  NSMutableDictionary *node = [NSMutableDictionary dictionary];
  node[@"role"] = role ?: [NSNull null];
  node[@"label"] = label ?: [NSNull null];
  node[@"identifier"] = identifier ?: [NSNull null];
  node[@"value"] = value ?: [NSNull null];
  node[@"enabled"] = @(enabled);
  node[@"selected"] = @(selected);
  node[@"frame"] = @{
    @"x": @(frame.origin.x),
    @"y": @(frame.origin.y),
    @"width": @(frame.size.width),
    @"height": @(frame.size.height),
  };

  NSMutableArray *childrenOut = [NSMutableArray array];
  if (depth < maxDepth && *nodeCount < kSHAXMaxNodes) {
    NSArray *children = axChildren(elem);
    for (id child in children) {
      if (*nodeCount >= kSHAXMaxNodes) {
        break;
      }
      NSMutableDictionary *childNode = walkNode(
        child, token, rootFrame, pointSize, depth + 1, maxDepth, nodeCount
      );
      if (childNode) {
        [childrenOut addObject:childNode];
      }
    }
  }
  node[@"children"] = childrenOut;
  return node;
}

static BOOL ensureTranslator(SHPrivateContextRef ctx) {
  if (ctx->translator != nil && ctx->axDelegate != nil) {
    return YES;
  }
  Class cls = NSClassFromString(@"AXPTranslator");
  if (cls == Nil) {
    return NO;
  }
  SEL shared = NSSelectorFromString(@"sharedInstance");
  IMP imp = class_getMethodImplementation(object_getClass((id)cls), shared);
  if (imp == NULL) {
    return NO;
  }
  typedef id (*Fn)(Class, SEL);
  id translator = ((Fn)imp)(cls, shared);
  if (translator == nil) {
    return NO;
  }
  SEL enableSel = NSSelectorFromString(@"setAccessibilityEnabled:");
  if ([translator respondsToSelector:enableSel]) {
    BOOL yes = YES;
    NSMethodSignature *sig = [translator methodSignatureForSelector:enableSel];
    NSInvocation *inv = [NSInvocation invocationWithMethodSignature:sig];
    [inv setTarget:translator];
    [inv setSelector:enableSel];
    [inv setArgument:&yes atIndex:2];
    [inv invoke];
  }
  SHAXBridgeDelegate *delegate = [[SHAXBridgeDelegate alloc] init];
  delegate.ctx = ctx;
  SEL setDel = NSSelectorFromString(@"setBridgeTokenDelegate:");
  if (![translator respondsToSelector:setDel]) {
    return NO;
  }
  typedef void (*SetFn)(id, SEL, id);
  IMP setImp = class_getMethodImplementation(object_getClass(translator), setDel);
  if (setImp == NULL) {
    return NO;
  }
  ((SetFn)setImp)(translator, setDel, delegate);
  ctx->translator = translator;
  ctx->axDelegate = delegate;
  return YES;
}

char *SHCopyAccessibilityJSON(
  SHPrivateContextRef ctx,
  uint32_t maxDepth,
  char **errorOut
) {
  if (errorOut) {
    *errorOut = NULL;
  }
  if (ctx == NULL || !ctx->caps.accessibility) {
    SHSetError(errorOut, "capability_unavailable");
    return NULL;
  }
  if (ctx->simDevice == nil && !SHResolveDevice(ctx)) {
    SHSetError(errorOut, "device_missing");
    return NULL;
  }
  if (!ensureTranslator(ctx)) {
    SHSetError(errorOut, "capability_unavailable");
    return NULL;
  }
  if (maxDepth == 0) {
    maxDepth = 8;
  }
  if (maxDepth > kSHAXHardDepthCap) {
    maxDepth = kSHAXHardDepthCap;
  }

  NSString *token = [[NSUUID UUID] UUIDString];
  SEL frontSel = NSSelectorFromString(@"frontmostApplicationWithDisplayId:bridgeDelegateToken:");
  IMP frontImp = class_getMethodImplementation(object_getClass(ctx->translator), frontSel);
  if (frontImp == NULL) {
    SHSetError(errorOut, "capability_unavailable");
    return NULL;
  }
  typedef id (*FrontFn)(id, SEL, uint32_t, id);
  id translation = ((FrontFn)frontImp)(ctx->translator, frontSel, 0, token);
  if (translation == nil) {
    SHSetError(errorOut, "capability_unavailable");
    return NULL;
  }
  stampToken(translation, token);

  SEL macSel = NSSelectorFromString(@"macPlatformElementFromTranslation:");
  IMP macImp = class_getMethodImplementation(object_getClass(ctx->translator), macSel);
  if (macImp == NULL) {
    SHSetError(errorOut, "capability_unavailable");
    return NULL;
  }
  typedef id (*MacFn)(id, SEL, id);
  id root = ((MacFn)macImp)(ctx->translator, macSel, translation);
  if (root == nil) {
    SHSetError(errorOut, "capability_unavailable");
    return NULL;
  }

  CGRect rootFrame = axFrame(root);
  CGSize pointSize = CGSizeMake(ctx->widthPoints, ctx->heightPoints);
  uint32_t nodeCount = 0;
  NSDictionary *tree = walkNode(root, token, rootFrame, pointSize, 0, maxDepth, &nodeCount);
  if (tree == nil) {
    SHSetError(errorOut, "capability_unavailable");
    return NULL;
  }
  NSError *jsonError = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:tree options:0 error:&jsonError];
  if (data == nil || data.length == 0) {
    SHSetError(errorOut, "capability_unavailable");
    return NULL;
  }
  if (data.length > 65536) {
    SHSetError(errorOut, "control_too_large");
    return NULL;
  }
  char *copy = malloc(data.length + 1);
  if (copy == NULL) {
    SHSetError(errorOut, "out_of_memory");
    return NULL;
  }
  memcpy(copy, data.bytes, data.length);
  copy[data.length] = '\0';
  return copy;
}
