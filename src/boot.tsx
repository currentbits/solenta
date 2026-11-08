import { captureWebEnrollment } from "./webEnrollment";
import { WebEnrollmentGate } from "./components/WebEnrollmentGate";
import App from "./App";
import { needsWebTokenGate } from "./coderApi";
import { WebTokenGate } from "./components/WebTokenGate";

export function BootApp() {
  const enrollment = captureWebEnrollment();
  if (enrollment) return <WebEnrollmentGate enrollment={enrollment} />;
  if (needsWebTokenGate()) return <WebTokenGate />;
  return <App />;
}
