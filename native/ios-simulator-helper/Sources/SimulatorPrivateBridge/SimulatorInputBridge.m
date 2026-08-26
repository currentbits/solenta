#import "SHPrivateContextInternal.h"

#include <math.h>
#include <unistd.h>

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
  if (ctx == NULL || !ctx->caps.touch || ctx->mouseFn == NULL) {
    SHSetError(errorOut, "capability_unavailable");
    return false;
  }
  if (!SHEnsureHIDClient(ctx)) {
    SHSetError(errorOut, "capability_unavailable");
    return false;
  }
  if (ctx->widthPoints <= 0 || ctx->heightPoints <= 0) {
    SHSetError(errorOut, "capability_unavailable");
    return false;
  }
  CGPoint point = CGPointMake(
    clamp01(x / ctx->widthPoints),
    clamp01(y / ctx->heightPoints)
  );
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
  if (ctx == NULL || !ctx->caps.touch || ctx->mouseFn == NULL) {
    SHSetError(errorOut, "capability_unavailable");
    return false;
  }
  if (!SHEnsureHIDClient(ctx)) {
    SHSetError(errorOut, "capability_unavailable");
    return false;
  }
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
  if (ctx == NULL || !ctx->caps.keyboard || ctx->hidArbFn == NULL) {
    SHSetError(errorOut, "capability_unavailable");
    return false;
  }
  if (!SHEnsureHIDClient(ctx)) {
    SHSetError(errorOut, "capability_unavailable");
    return false;
  }
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
        SHSetError(errorOut, "capability_unavailable");
        return false;
      }
    }
    if (!sendHIDUsage(ctx, SHIndigoHIDPageKeyboard, event.usage, operation)) {
      SHSetError(errorOut, "capability_unavailable");
      return false;
    }
  } else {
    if (!sendHIDUsage(ctx, SHIndigoHIDPageKeyboard, event.usage, operation)) {
      SHSetError(errorOut, "capability_unavailable");
      return false;
    }
    for (unsigned i = modCount; i > 0; i--) {
      if (!sendHIDUsage(ctx, SHIndigoHIDPageKeyboard, mods[i - 1], SHIndigoDirUp)) {
        SHSetError(errorOut, "capability_unavailable");
        return false;
      }
    }
  }
  return true;
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
  if (ctx == NULL || !ctx->caps.keyboard || ctx->hidArbFn == NULL) {
    SHSetError(errorOut, "capability_unavailable");
    return false;
  }
  if (utf8 == NULL) {
    SHSetError(errorOut, "protocol_error");
    return false;
  }
  if (!SHEnsureHIDClient(ctx)) {
    SHSetError(errorOut, "capability_unavailable");
    return false;
  }
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
    event.down = false;
    if (!SHSendKey(ctx, event, errorOut)) {
      return false;
    }
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
  if (!SHEnsureHIDClient(ctx)) {
    SHSetError(errorOut, "capability_unavailable");
    return false;
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
