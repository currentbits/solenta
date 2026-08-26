#ifndef SOLENTA_SIMULATOR_PRIVATE_BRIDGE_H
#define SOLENTA_SIMULATOR_PRIVATE_BRIDGE_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct SHCapabilityReport {
  bool stream;
  bool touch;
  bool keyboard;
  bool hardwareButtons;
  bool accessibility;
} SHCapabilityReport;

typedef struct SHPrivateContext *SHPrivateContextRef;

typedef enum {
  SHTouchPhaseDown = 0,
  SHTouchPhaseMove = 1,
  SHTouchPhaseUp = 2
} SHTouchPhase;

typedef struct SHKeyEvent {
  uint16_t usage;
  bool down;
  uint32_t modifiers;
} SHKeyEvent;

typedef enum {
  SHHardwareButtonHome = 0,
  SHHardwareButtonLock = 1,
  SHHardwareButtonVolumeUp = 2,
  SHHardwareButtonVolumeDown = 3,
  SHHardwareButtonAction = 4,
  SHHardwareButtonShake = 5
} SHHardwareButton;

typedef void (*SHFrameCallback)(void *context, void *pixelBuffer, int64_t timestampUs);

void SHFreeError(char *error);

bool SHSandboxEnter(const char *profileText, const char **parameters, char **errorOut);

SHPrivateContextRef SHCreatePrivateContext(
  const char *developerDir,
  const char *udid,
  SHCapabilityReport *report,
  char **errorOut
);

bool SHStartCapture(SHPrivateContextRef ctx, SHFrameCallback callback, void *user, char **errorOut);
bool SHStopCapture(SHPrivateContextRef ctx, char **errorOut);
bool SHSendTouch(SHPrivateContextRef ctx, SHTouchPhase phase, double x, double y, char **errorOut);
bool SHSendScrollTo(SHPrivateContextRef ctx, double x, double y, double dx, double dy, char **errorOut);
bool SHSendKey(SHPrivateContextRef ctx, SHKeyEvent event, char **errorOut);
bool SHSendText(SHPrivateContextRef ctx, const char *utf8, char **errorOut);
bool SHPressButton(SHPrivateContextRef ctx, SHHardwareButton button, char **errorOut);
char *SHCopyAccessibilityJSON(SHPrivateContextRef ctx, uint32_t maxDepth, char **errorOut);
void SHDestroyPrivateContext(SHPrivateContextRef ctx);

#ifdef __cplusplus
}
#endif

#endif
