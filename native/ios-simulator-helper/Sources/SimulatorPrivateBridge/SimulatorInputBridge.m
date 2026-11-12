#import "SHPrivateContextInternal.h"

#include <math.h>
#include <unistd.h>

// Synara's DTUHID readiness/delivery fences, bounded inside our 10s RPC deadline.
void SHBeginInput(SHPrivateContextRef ctx) {
  if (ctx == NULL) return;
  ctx->inputDeadline = NSProcessInfo.processInfo.systemUptime + 8.0;
  ctx->inputEventsSent = 0;
}

static NSTimeInterval remainingInputTime(SHPrivateContextRef ctx) {
  return fmax(0, ctx->inputDeadline - NSProcessInfo.processInfo.systemUptime);
}

static BOOL inputFailed(SHPrivateContextRef ctx, char **errorOut) {
  SHSetError(errorOut, ctx->usesDTUHID
    ? (ctx->inputEventsSent ? "input_delivery_uncertain" : "input_not_delivered")
    : "capability_unavailable");
  return NO;
}

static BOOL inputReady(SHPrivateContextRef ctx, char **errorOut) {
  if (!SHEnsureHIDClient(ctx)) return inputFailed(ctx, errorOut);
  if (!ctx->usesDTUHID) return YES;
  NSTimeInterval remaining = remainingInputTime(ctx);
  if (remaining <= 0 || ![ctx->dtuhid waitUntilReadyWithTimeout:fmin(5.0, remaining) error:nil]) {
    return inputFailed(ctx, errorOut);
  }
  return YES;
}

static BOOL dtuhidSent(SHPrivateContextRef ctx, BOOL sent, BOOL flush, char **errorOut) {
  if (!sent) return inputFailed(ctx, errorOut);
  ctx->inputEventsSent += 1;
  if (flush && ![ctx->dtuhid flushWithTimeout:fmin(1.0, remainingInputTime(ctx))]) {
    return inputFailed(ctx, errorOut);
  }
  return YES;
}

static double clamp01(double value) {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

static uint32_t eventTypeForPhase(SHTouchPhase phase) {
  switch (phase) {
    case SHTouchPhaseDown:
      return SHIndigoNSEventDown;
    case SHTouchPhaseMove:
      return SHIndigoNSEventDragged;
    case SHTouchPhaseUp:
      return SHIndigoNSEventUp;
  }
  return SHIndigoNSEventUp;
}

bool SHSendTouch(
  SHPrivateContextRef ctx,
  SHTouchPhase phase,
  double x,
  double y,
  char **errorOut
) {
  if (errorOut) {
    *errorOut = NULL;
  }
  if (ctx == NULL || !ctx->caps.touch) {
    SHSetError(errorOut, "capability_unavailable");
    return false;
  }
  if (!inputReady(ctx, errorOut)) return false;
  if (ctx->widthPoints <= 0 || ctx->heightPoints <= 0) {
    SHSetError(errorOut, "capability_unavailable");
    return false;
  }
  CGPoint point = CGPointMake(
    clamp01(x / ctx->widthPoints),
    clamp01(y / ctx->heightPoints)
  );
  if (!isfinite(x) || !isfinite(y)) {
    SHSetError(errorOut, "protocol_error");
    return false;
  }
  if (ctx->usesDTUHID) {
    return dtuhidSent(ctx, [ctx->dtuhid sendTouchAtX:point.x y:point.y
      down:phase != SHTouchPhaseUp edge:SynaraTouchEdgeNone], phase == SHTouchPhaseUp, errorOut);
  }
  if (ctx->mouseFn == NULL) return inputFailed(ctx, errorOut);
  void *message = ctx->mouseFn(
    &point,
    NULL,
    SHIndigoTouchDigitizer,
    eventTypeForPhase(phase),
    SHIndigoEdgeNone,
    1.0,
    1.0
  );
  if (message == NULL) {
    SHSetError(errorOut, "capability_unavailable");
    return false;
  }
  SHSendHIDMessage(ctx, message);
  return true;
}

bool SHSendScrollTo(
  SHPrivateContextRef ctx,
  double x,
  double y,
  double dx,
  double dy,
  char **errorOut
) {
  if (errorOut) {
    *errorOut = NULL;
  }
  if (ctx == NULL || !ctx->caps.touch) {
    SHSetError(errorOut, "capability_unavailable");
    return false;
  }
  if (!inputReady(ctx, errorOut)) return false;
  if (ctx->widthPoints <= 0 || ctx->heightPoints <= 0) {
    SHSetError(errorOut, "capability_unavailable");
    return false;
  }
  // A scroll is a drag: touch down, a bounded series of moves, touch up.
  double distance = hypot(dx, dy);
  if (!isfinite(distance)) {
    SHSetError(errorOut, "protocol_error");
    return false;
  }
  unsigned steps = (unsigned)fmin(24.0, fmax(1.0, distance / 15.0));
  if (!SHSendTouch(ctx, SHTouchPhaseDown, x, y, errorOut)) {
    return false;
  }
  for (unsigned i = 1; i <= steps; i++) {
    double t = (double)i / (double)steps;
    double mx = x + dx * t;
    double my = y + dy * t;
    if (!SHSendTouch(ctx, SHTouchPhaseMove, mx, my, errorOut)) {
      // Best-effort release so the simulator is not left with a stuck touch.
      SHSendTouch(ctx, SHTouchPhaseUp, mx, my, NULL);
      return false;
    }
    usleep(8 * 1000);
  }
  return SHSendTouch(ctx, SHTouchPhaseUp, x + dx, y + dy, errorOut);
}

static BOOL sendHIDUsage(
  SHPrivateContextRef ctx,
  uint32_t page,
  uint32_t usage,
  uint32_t operation
) {
  if (ctx->usesDTUHID) {
    if (remainingInputTime(ctx) <= 0 || page != SHIndigoHIDPageKeyboard) return NO;
    BOOL sent = [ctx->dtuhid sendKeyUsage:usage down:operation == SHIndigoDirDown];
    if (sent) ctx->inputEventsSent += 1;
    return sent;
  }
  if (ctx->hidArbFn == NULL) {
    return NO;
  }
  void *message = ctx->hidArbFn(SHIndigoTouchDigitizer, page, usage, operation);
  if (message == NULL) {
    return NO;
  }
  SHSendHIDMessage(ctx, message);
  return YES;
}

bool SHSendKey(SHPrivateContextRef ctx, SHKeyEvent event, char **errorOut) {
  if (errorOut) {
    *errorOut = NULL;
  }
  if (ctx == NULL || !ctx->caps.keyboard) {
    SHSetError(errorOut, "capability_unavailable");
    return false;
  }
  if (!inputReady(ctx, errorOut)) return false;
  uint32_t operation = event.down ? SHIndigoDirDown : SHIndigoDirUp;
  uint32_t mods[4];
  unsigned modCount = 0;
  if (event.modifiers & SHKeyModifierControl) {
    mods[modCount++] = 0xE0u;
  }
  if (event.modifiers & SHKeyModifierShift) {
    mods[modCount++] = 0xE1u;
  }
  if (event.modifiers & SHKeyModifierOption) {
    mods[modCount++] = 0xE2u;
  }
  if (event.modifiers & SHKeyModifierCommand) {
    mods[modCount++] = 0xE3u;
  }

  if (event.down) {
    for (unsigned i = 0; i < modCount; i++) {
      if (!sendHIDUsage(ctx, SHIndigoHIDPageKeyboard, mods[i], SHIndigoDirDown)) {
        goto failed;
      }
    }
    if (!sendHIDUsage(ctx, SHIndigoHIDPageKeyboard, event.usage, operation)) {
      goto failed;
    }
  } else {
    if (!sendHIDUsage(ctx, SHIndigoHIDPageKeyboard, event.usage, operation)) {
      goto failed;
    }
    for (unsigned i = modCount; i > 0; i--) {
      if (!sendHIDUsage(ctx, SHIndigoHIDPageKeyboard, mods[i - 1], SHIndigoDirUp)) {
        goto failed;
      }
    }
  }
  if (ctx->usesDTUHID && !event.down
      && ![ctx->dtuhid flushWithTimeout:fmin(1.0, remainingInputTime(ctx))]) goto failed;
  return true;
failed:
  // Release admitted keys after a partial send; never replay the input itself.
  if (ctx->usesDTUHID && ctx->inputEventsSent) {
    [ctx->dtuhid sendKeyUsage:event.usage down:NO];
    for (unsigned i = modCount; i > 0; i--) [ctx->dtuhid sendKeyUsage:mods[i - 1] down:NO];
    [ctx->dtuhid flushWithTimeout:1.0];
  }
  return inputFailed(ctx, errorOut);
}

static BOOL asciiToKeyEvent(char c, SHKeyEvent *eventOut) {
  uint16_t usage = 0;
  BOOL shift = NO;
  if (c >= 'a' && c <= 'z') {
    usage = (uint16_t)(0x04u + (uint32_t)(c - 'a'));
  } else if (c >= 'A' && c <= 'Z') {
    usage = (uint16_t)(0x04u + (uint32_t)(c - 'A'));
    shift = YES;
  } else if (c >= '1' && c <= '9') {
    usage = (uint16_t)(0x1Eu + (uint32_t)(c - '1'));
  } else {
    switch (c) {
      case '0': usage = 0x27; break;
      case '\n': case '\r': usage = 0x28; break;
      case '\t': usage = 0x2B; break;
      case ' ': usage = 0x2C; break;
      case '-': usage = 0x2D; break;
      case '=': usage = 0x2E; break;
      case '[': usage = 0x2F; break;
      case ']': usage = 0x30; break;
      case '\\': usage = 0x31; break;
      case ';': usage = 0x33; break;
      case '\'': usage = 0x34; break;
      case '`': usage = 0x35; break;
      case ',': usage = 0x36; break;
      case '.': usage = 0x37; break;
      case '/': usage = 0x38; break;
      case '!': usage = 0x1E; shift = YES; break;
      case '@': usage = 0x1F; shift = YES; break;
      case '#': usage = 0x20; shift = YES; break;
      case '$': usage = 0x21; shift = YES; break;
      case '%': usage = 0x22; shift = YES; break;
      case '^': usage = 0x23; shift = YES; break;
      case '&': usage = 0x24; shift = YES; break;
      case '*': usage = 0x25; shift = YES; break;
      case '(': usage = 0x26; shift = YES; break;
      case ')': usage = 0x27; shift = YES; break;
      case '_': usage = 0x2D; shift = YES; break;
      case '+': usage = 0x2E; shift = YES; break;
      case '{': usage = 0x2F; shift = YES; break;
      case '}': usage = 0x30; shift = YES; break;
      case '|': usage = 0x31; shift = YES; break;
      case ':': usage = 0x33; shift = YES; break;
      case '"': usage = 0x34; shift = YES; break;
      case '~': usage = 0x35; shift = YES; break;
      case '<': usage = 0x36; shift = YES; break;
      case '>': usage = 0x37; shift = YES; break;
      case '?': usage = 0x38; shift = YES; break;
      default: return NO;
    }
  }
  eventOut->usage = usage;
  eventOut->modifiers = shift ? SHKeyModifierShift : 0u;
  return YES;
}

bool SHSendText(SHPrivateContextRef ctx, const char *utf8, char **errorOut) {
  if (errorOut) {
    *errorOut = NULL;
  }
  if (ctx == NULL || !ctx->caps.keyboard) {
    SHSetError(errorOut, "capability_unavailable");
    return false;
  }
  if (utf8 == NULL) {
    SHSetError(errorOut, "protocol_error");
    return false;
  }
  if (!inputReady(ctx, errorOut)) return false;
  for (const char *cursor = utf8; *cursor != '\0'; cursor++) {
    // Non-ASCII UTF-8 bytes have no HID usage mapping and are skipped.
    if ((unsigned char)*cursor > 0x7Fu) {
      continue;
    }
    SHKeyEvent event;
    event.down = true;
    if (!asciiToKeyEvent(*cursor, &event)) {
      continue;
    }
    if (!SHSendKey(ctx, event, errorOut)) {
      return false;
    }
    if (ctx->usesDTUHID) usleep(12 * 1000);
    event.down = false;
    if (!SHSendKey(ctx, event, errorOut)) {
      return false;
    }
    if (ctx->usesDTUHID) usleep(18 * 1000);
  }
  return true;
}

static BOOL pressLegacyButton(SHPrivateContextRef ctx, uint32_t arg0) {
  if (ctx->buttonFn == NULL) {
    return NO;
  }
  void *down = ctx->buttonFn(arg0, SHIndigoDirDown, SHIndigoButtonTarget);
  if (down == NULL) {
    return NO;
  }
  SHSendHIDMessage(ctx, down);
  usleep(100 * 1000);
  void *up = ctx->buttonFn(arg0, SHIndigoDirUp, SHIndigoButtonTarget);
  if (up == NULL) {
    return NO;
  }
  SHSendHIDMessage(ctx, up);
  return YES;
}

static BOOL pressArbitrary(SHPrivateContextRef ctx, uint32_t page, uint32_t usage) {
  if (!sendHIDUsage(ctx, page, usage, SHIndigoDirDown)) {
    return NO;
  }
  usleep(100 * 1000);
  return sendHIDUsage(ctx, page, usage, SHIndigoDirUp);
}

bool SHPressButton(
  SHPrivateContextRef ctx,
  SHHardwareButton button,
  char **errorOut
) {
  if (errorOut) {
    *errorOut = NULL;
  }
  if (ctx == NULL || !ctx->caps.hardwareButtons) {
    SHSetError(errorOut, "capability_unavailable");
    return false;
  }
  if (!inputReady(ctx, errorOut)) return false;
  if (ctx->usesDTUHID) {
    uint16_t usage;
    switch (button) {
      case SHHardwareButtonHome: usage = 0x40; break;
      case SHHardwareButtonLock: usage = 0x30; break;
      case SHHardwareButtonVolumeUp: usage = 0xe9; break;
      case SHHardwareButtonVolumeDown: usage = 0xea; break;
      default:
        SHSetError(errorOut, "capability_unavailable");
        return false;
    }
    if (!dtuhidSent(ctx, [ctx->dtuhid sendConsumerUsage:usage down:YES], NO, errorOut)) return false;
    usleep(100 * 1000);
    return dtuhidSent(ctx, [ctx->dtuhid sendConsumerUsage:usage down:NO], YES, errorOut);
  }
  BOOL ok = NO;
  switch (button) {
    case SHHardwareButtonHome:
      ok = pressLegacyButton(ctx, 0);
      break;
    case SHHardwareButtonLock:
      ok = pressLegacyButton(ctx, 1);
      break;
    case SHHardwareButtonVolumeUp:
      ok = pressArbitrary(ctx, SHIndigoHIDPageConsumer, 233);
      break;
    case SHHardwareButtonVolumeDown:
      ok = pressArbitrary(ctx, SHIndigoHIDPageConsumer, 234);
      break;
    case SHHardwareButtonAction:
      ok = pressArbitrary(ctx, SHIndigoHIDPageTelephony, 45);
      break;
    case SHHardwareButtonShake:
      SHSetError(errorOut, "capability_unavailable");
      return false;
  }
  if (!ok) {
    SHSetError(errorOut, "capability_unavailable");
    return false;
  }
  return true;
}
