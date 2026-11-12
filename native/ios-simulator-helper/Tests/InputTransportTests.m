// Standalone native input regressions; compile command is in NOTICE.md.
#import "../Sources/SimulatorPrivateBridge/SHPrivateContextInternal.h"
#include <assert.h>

@interface FakeDisplay : NSObject
@property(nonatomic, assign) IOSurfaceRef surface;
@property(nonatomic, copy) void (^damage)(id);
@property(nonatomic, copy) void (^surfaces)(id, id);
@property NSInteger unregisters;
@end
@implementation FakeDisplay
- (id)framebufferSurface { return (__bridge id)self.surface; }
- (void)registerCallbackWithUUID:(NSUUID *)uuid damageRectanglesCallback:(void (^)(id))callback { self.damage = callback; }
- (void)registerCallbackWithUUID:(NSUUID *)uuid ioSurfacesChangeCallback:(void (^)(id, id))callback { self.surfaces = callback; }
- (void)unregisterDamageRectanglesCallbackWithUUID:(NSUUID *)uuid { self.unregisters += 1; }
- (void)unregisterIOSurfacesChangeCallbackWithUUID:(NSUUID *)uuid { self.unregisters += 1; }
@end
@interface ForwardedDisplay : NSProxy
@property FakeDisplay *target;
@end
@implementation ForwardedDisplay
- (NSMethodSignature *)methodSignatureForSelector:(SEL)selector { return [self.target methodSignatureForSelector:selector]; }
- (void)forwardInvocation:(NSInvocation *)invocation { [invocation invokeWithTarget:self.target]; }
- (BOOL)respondsToSelector:(SEL)selector { return [self.target respondsToSelector:selector]; }
@end
@interface FakePort : NSObject
@property id descriptor;
@end
@implementation FakePort
@end
@interface FakeIO : NSObject
@property NSArray *ioPorts;
@end
@implementation FakeIO
- (void)updateIOPorts {}
@end
@interface FakeDevice : NSObject
@property FakeIO *io;
@end
@implementation FakeDevice
@end

@interface FakeDTUHID : SynaraDTUHIDTransport
@property BOOL ready;
@property BOOL flushOK;
@property NSInteger failAt;
@property NSInteger sends;
@property NSMutableArray *events;
@end

@implementation FakeDTUHID
- (void)startAttemptIfNeeded {}
- (BOOL)waitUntilReadyWithTimeout:(NSTimeInterval)timeout error:(NSError **)error {
  assert(timeout <= 5.0);
  return self.ready;
}
- (BOOL)record:(NSArray *)event {
  self.sends += 1;
  [self.events addObject:event];
  return self.sends != self.failAt;
}
- (BOOL)sendTouchAtX:(double)x y:(double)y down:(BOOL)down edge:(SynaraTouchEdge)edge {
  return [self record:@[@"touch", @(x), @(y), @(down), @(edge)]];
}
- (BOOL)sendKeyUsage:(uint32_t)usage down:(BOOL)down {
  return [self record:@[@"key", @(usage), @(down)]];
}
- (BOOL)sendConsumerUsage:(uint16_t)usage down:(BOOL)down {
  return [self record:@[@"button", @(usage), @(down)]];
}
- (BOOL)flushWithTimeout:(NSTimeInterval)timeout {
  assert(timeout <= 1.0);
  return self.flushOK;
}
@end

static void receivedFrame(void *user, void *buffer, int64_t timestamp) {
  *(unsigned *)user += 1;
  CVPixelBufferRelease(buffer);
}

int main(void) {
  @autoreleasepool {
    FakeDTUHID *transport = [[FakeDTUHID alloc] initWithDevice:[NSObject new]];
    transport.ready = YES;
    transport.flushOK = YES;
    transport.events = [NSMutableArray new];
    struct SHPrivateContext context = {0};
    context.usesDTUHID = YES;
    context.dtuhid = transport;
    context.simDevice = [NSObject new];
    context.caps = (SHCapabilityReport){ .touch = true, .keyboard = true, .hardwareButtons = true };
    context.widthPoints = 200;
    context.heightPoints = 400;
    char *error = NULL;
    SHBeginInput(&context);
    assert(SHSendTouch(&context, SHTouchPhaseDown, 100, 200, &error));
    assert(SHSendTouch(&context, SHTouchPhaseMove, 120, 240, &error));
    assert(SHSendTouch(&context, SHTouchPhaseUp, 120, 240, &error));
    assert(([transport.events[0] isEqual:@[@"touch", @0.5, @0.5, @YES, @0]]));
    assert(([transport.events[2] isEqual:@[@"touch", @0.6, @0.6, @NO, @0]]));

    [transport.events removeAllObjects];
    SHBeginInput(&context);
    assert(SHSendText(&context, "Aa", &error));
    assert(([transport.events isEqual:@[
      @[@"key", @225, @YES], @[@"key", @4, @YES],
      @[@"key", @4, @NO], @[@"key", @225, @NO],
      @[@"key", @4, @YES], @[@"key", @4, @NO]
    ]]));

    [transport.events removeAllObjects];
    SHBeginInput(&context);
    assert(SHPressButton(&context, SHHardwareButtonHome, &error));
    assert(([transport.events isEqual:@[@[@"button", @64, @YES], @[@"button", @64, @NO]]]));
    assert(!SHPressButton(&context, SHHardwareButtonAction, &error));
    assert(strcmp(error, "capability_unavailable") == 0);
    free(error); error = NULL;

    // A dead daemon refuses before any input and never falls back to Indigo.
    [transport.events removeAllObjects];
    transport.ready = NO;
    SHBeginInput(&context);
    assert(!SHSendTouch(&context, SHTouchPhaseDown, 10, 20, &error));
    assert(strcmp(error, "input_not_delivered") == 0);
    assert(transport.events.count == 0);
    free(error); error = NULL;

    // An expired operation cannot dispatch even if the daemon is ready.
    transport.ready = YES;
    context.inputDeadline = 0;
    assert(!SHSendTouch(&context, SHTouchPhaseDown, 10, 20, &error));
    assert(transport.events.count == 0);
    free(error); error = NULL;

    // A failed key after Shift-down releases both without replaying the text.
    transport.sends = 0;
    transport.failAt = 2;
    SHBeginInput(&context);
    assert(!SHSendText(&context, "AB", &error));
    assert(strcmp(error, "input_delivery_uncertain") == 0);
    assert(([transport.events isEqual:@[
      @[@"key", @225, @YES], @[@"key", @4, @YES],
      @[@"key", @4, @NO], @[@"key", @225, @NO]
    ]]));
    free(error); error = NULL;

    // Queued sends without a completed barrier are never acknowledged as done.
    [transport.events removeAllObjects];
    transport.failAt = 0;
    transport.flushOK = NO;
    SHBeginInput(&context);
    assert(!SHSendTouch(&context, SHTouchPhaseUp, 10, 20, &error));
    assert(strcmp(error, "input_delivery_uncertain") == 0);
    free(error);
    [transport invalidate];

    // Current display ports use separate damage/surface callbacks and need a
    // seed frame even when the screen is idle. Late callbacks after stop are inert.
    IOSurfaceRef surface = IOSurfaceCreate((__bridge CFDictionaryRef)@{
      (id)kIOSurfaceWidth: @16, (id)kIOSurfaceHeight: @16,
      (id)kIOSurfaceBytesPerElement: @4, (id)kIOSurfaceBytesPerRow: @64,
      (id)kIOSurfacePixelFormat: @(kCVPixelFormatType_32BGRA),
    });
    assert(surface != NULL);
    FakeDisplay *display = [FakeDisplay new]; display.surface = surface;
    ForwardedDisplay *proxy = [ForwardedDisplay alloc]; proxy.target = display;
    FakePort *port = [FakePort new]; port.descriptor = proxy;
    FakeIO *io = [FakeIO new]; io.ioPorts = @[port];
    FakeDevice *device = [FakeDevice new]; device.io = io;
    context.simDevice = device;
    context.caps.stream = true;
    unsigned frames = 0;
    error = NULL;
    assert(SHStartCapture(&context, receivedFrame, &frames, &error));
    assert(frames == 1);
    display.damage(nil);
    display.surfaces(nil, (__bridge id)surface);
    assert(frames == 3);
    assert(SHStopCapture(&context, &error));
    assert(display.unregisters == 2);
    display.damage(nil);
    display.surfaces(nil, (__bridge id)surface);
    assert(frames == 3);
    CFRelease(surface);
    puts("DTUHID input regressions passed");
  }
  return 0;
}
