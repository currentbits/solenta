/**
 * fakeCoder speech:changed so renderer tests can subscribe (#845).
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFakeCoder } from "./support/fakeCoder.ts";
import { createDevCoder } from "../src/devCoder.ts";
import type { SpeechStatus } from "../src/shared/ipc";

describe("fakeCoder speech IPC", () => {
  it("keeps the dev model and language selection across speech setting patches without exposing keys", async () => {
    const api = createDevCoder();
    const saved = await api.settings.set({ speech: { provider: "local", localModel: "nemotron-3.5", language: "nl-NL" } });
    assert.equal(saved.speech?.localModel, "nemotron-3.5");
    assert.equal(saved.speech?.language, "nl-NL");
    await api.settings.set({ speech: { provider: "openai", openaiApiKey: "fixture-only" } });
    const settings = await api.settings.get();
    assert.deepEqual(settings.speech, { provider: "openai", localModel: "nemotron-3.5", language: "nl-NL", hasOpenaiKey: true, hasElevenlabsKey: false });
  });
  it("subscribes to speech:changed and unsubscribes", () => {
    const fake = createFakeCoder();
    const seen: SpeechStatus[] = [];
    const off = fake.api.on("speech:changed", (s) => {
      seen.push(s);
    });
    fake.emitSpeech({
      state: "recording",
      runtimeReady: true,
      modelReady: true,
      delta: " brown",
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].delta, " brown");
    off();
    fake.emitSpeech({
      state: "ready",
      runtimeReady: true,
      modelReady: true,
      transcript: "Quick brown fox",
    });
    assert.equal(seen.length, 1);
  });

  it("records speech.start and returns a session id", async () => {
    const fake = createFakeCoder();
    const started = await fake.api.speech.start();
    assert.equal(started.sessionId, "speech-session");
    assert.equal(fake.of("speech.start").length, 1);
  });
});
