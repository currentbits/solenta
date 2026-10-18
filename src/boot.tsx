import App from "./App";
import { needsWebTokenGate } from "./coderApi";
import { WebTokenGate } from "./components/WebTokenGate";

export function BootApp() {
  if (needsWebTokenGate()) return <WebTokenGate />;
  return <App />;
}
