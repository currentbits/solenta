"use strict";

// v0.1.0 supports both models. Only the 32 out-of-box locales are offered;
// the model card's eight adaptation-ready locales require fine-tuning.
// Artifact pins: github.com/NVIDIA/NeMo-Speech.cpp/blob/v0.1.0/models/index.json
// Locales: huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b/blob/
// 1c8deaecc64b91f034d73e08dd8b64625eb3395d/README.md#supported-languages
const { models, languages } = require("./speech-models.json");

function localSpeechConfig(speech) {
  return {
    localModel: speech?.localModel ?? "nemotron-en",
    language: speech?.language ?? "en-US",
  };
}

function localSpeechError(speech) {
  const { localModel, language } = localSpeechConfig(speech);
  if (!Object.hasOwn(models, localModel)) {
    return "Unknown local speech model. Choose a model in Settings > Voice input.";
  }
  if (!Object.hasOwn(languages, language)) {
    return "Unsupported local dictation language. Choose a supported language in Settings > Voice input.";
  }
  if (localModel === "nemotron-en" && !language.startsWith("en-")) {
    return "Nemotron English supports English only. Choose Nemotron 3.5 multilingual for this language.";
  }
  return "";
}

module.exports = { models, languages, localSpeechConfig, localSpeechError };
