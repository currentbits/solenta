import { useState, type FormEvent } from "react";
import App from "./App";
import { needsWebTokenGate, persistWebToken, webNavigation } from "./coderApi";

function TokenGate() {
  const [token, setToken] = useState("");

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) return;
    persistWebToken(trimmed);
    webNavigation.reload();
  };

  return (
    <form onSubmit={onSubmit}>
      <label>
        Token
        <input
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoComplete="off"
        />
      </label>
      <button type="submit">Continue</button>
    </form>
  );
}

export function BootApp() {
  if (needsWebTokenGate()) return <TokenGate />;
  return <App />;
}
