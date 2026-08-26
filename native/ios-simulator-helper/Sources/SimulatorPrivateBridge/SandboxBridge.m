#import "SimulatorPrivateBridge.h"

#include <stdlib.h>
#include <string.h>
#include <sandbox.h>

extern int sandbox_init_with_parameters(
  const char *profile,
  uint64_t flags,
  const char *const parameters[],
  char **errorbuf
);

bool SHSandboxEnter(const char *profileText, const char **parameters, char **errorOut) {
  if (errorOut) {
    *errorOut = NULL;
  }
  if (profileText == NULL) {
    if (errorOut) {
      *errorOut = strdup("sandbox_failed");
    }
    return false;
  }

  char *sandboxError = NULL;
  int rc = sandbox_init_with_parameters(
    profileText,
    0,
    (const char *const *)parameters,
    &sandboxError
  );
  if (rc != 0) {
    const char *message = sandboxError ? sandboxError : "sandbox_failed";
    if (errorOut) {
      *errorOut = strdup(message);
    }
    if (sandboxError) {
      sandbox_free_error(sandboxError);
    }
    return false;
  }
  return true;
}
