import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { mount, unmountAll } from "./support/dom.ts";
import { OauthConsentDialog } from "../src/components/OauthConsentDialog";

describe("OauthConsentDialog", () => {
  afterEach(() => {
    unmountAll();
    if (typeof window !== "undefined") delete (window as unknown as { coder?: unknown }).coder;
  });

  it("approves a pending grant with the chosen capabilities", async () => {
    const approved: unknown[] = [];
    let remaining: Array<{
      id: string;
      clientName: string;
      redirectUri: string;
      createdAt: number;
    }> = [
      {
        id: "c1",
        clientName: "ChatGPT",
        redirectUri: "https://chatgpt.com/cb",
        createdAt: Date.now(),
      },
    ];
    (await mount(<div />)).unmount();
    (window as unknown as { coder: unknown }).coder = {
      pairing: {
        listConsents: async () => remaining,
        approveConsent: async (input: unknown) => {
          approved.push(input);
          remaining = remaining.filter((row) => row.id !== (input as { id: string }).id);
          return { pairing: { id: "p1" }, redirect: "https://chatgpt.com/cb?code=x" };
        },
        denyConsent: async () => ({ redirect: "https://chatgpt.com/cb?error=access_denied" }),
      },
      on: () => () => {},
    };
    const m = await mount(<OauthConsentDialog projects={[]} />);
    await m.flush();
    assert.ok(m.query("[data-oauth-consent]"));
    assert.match(m.text(), /Allow ChatGPT/);
    await m.click(m.query("[data-oauth-steer]") as HTMLElement);
    await m.click(m.query("[data-oauth-approve]") as HTMLElement);
    await m.flush();
    assert.equal(approved.length, 1);
    assert.deepEqual((approved[0] as { capabilities: string[] }).capabilities, [
      "read",
      "launch",
      "steer",
    ]);
    assert.equal(m.query("[data-oauth-consent]"), null);
  });
});
