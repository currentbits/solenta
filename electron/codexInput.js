"use strict";

const path = require("node:path");
const { createRequire } = require("node:module");
const { isDeepStrictEqual } = require("node:util");

// Use the SDK/validator already shipped with the memory server, not another
// JSON Schema implementation. Load only when a tool actually requests input.
function validator(schema) {
  const req = createRequire(path.join(__dirname, "../memory-server/package.json"));
  const { AjvJsonSchemaValidator } = req("@modelcontextprotocol/sdk/validation/ajv");
  return new AjvJsonSchemaValidator().getValidator(schema);
}

function formSchema(raw) {
  // Codex serializes absent optional schema members as null.
  const clean = JSON.parse(JSON.stringify(raw, (_key, value) => value === null ? undefined : value));
  const { $schema, additionalProperties, title, description, ...shape } = clean;
  if (($schema && $schema !== "http://json-schema.org/draft-07/schema#") ||
      (additionalProperties !== undefined && typeof additionalProperties !== "boolean")) throw new Error("Unsupported form schema");
  const req = createRequire(path.join(__dirname, "../memory-server/package.json"));
  const { ElicitRequestFormParamsSchema } = req("@modelcontextprotocol/sdk/types.js");
  const parsed = ElicitRequestFormParamsSchema.shape.requestedSchema.parse(shape);
  // Zod strips unknown constraints. Never silently answer a form whose
  // constraints the renderer cannot represent (nested objects, refs, etc.).
  if (!isDeepStrictEqual(shape, parsed)) throw new Error("Unsupported form schema");
  const keys = Object.keys(parsed.properties);
  if (keys.length > 64 || keys.some((key) => Object.hasOwn(Object.prototype, key)) ||
      parsed.required?.some((key) => !keys.includes(key))) throw new Error("Invalid form fields");
  return { ...parsed, additionalProperties: false };
}

function optionsFor(field) {
  const choices = field.type === "array" ? field.items : field;
  if (choices.enum) return choices.enum.map((value, i) => ({ value, label: choices.enumNames?.[i] || value }));
  return (choices.oneOf || choices.anyOf)?.map((item) => ({ value: item.const, label: item.title }));
}

function pendingFromInput(rpcId, method, params) {
  if (!params || JSON.stringify(params).length > 100_000) throw new Error("Invalid input request");
  let inputRequest;
  let schema;
  if (method === "item/tool/requestUserInput") {
    const qs = params.questions;
    if (!Array.isArray(qs) || !qs.length || qs.length > 64 || new Set(qs.map((q) => q.id)).size !== qs.length) throw new Error("Invalid questions");
    const fields = qs.map((q) => {
      // Schema validators can mistake inherited properties for supplied answers.
      if (typeof q.id !== "string" || !q.id || Object.hasOwn(Object.prototype, q.id) || typeof q.question !== "string" || !q.question ||
          (q.options != null && (!Array.isArray(q.options) || q.options.some((o) => typeof o.label !== "string" || !o.label)))) throw new Error("Invalid question");
      return { name: q.id, type: "string", title: q.question, description: q.header || "", required: true,
        secret: q.isSecret === true, custom: q.isOther === true || !q.options?.length,
        options: q.options?.map((o) => ({ value: o.label, label: o.label, description: o.description || "" })) };
    });
    schema = { type: "object", additionalProperties: false, required: fields.map((f) => f.name),
      properties: Object.fromEntries(fields.map((f) => [f.name, { type: "string", minLength: 1,
        ...(!f.custom && f.options?.length ? { enum: f.options.map((o) => o.value) } : {}) }])) };
    inputRequest = { source: "Codex", message: "Codex needs your input", fields };
  } else {
    if (typeof params.serverName !== "string" || !params.serverName || typeof params.message !== "string") throw new Error("Invalid MCP input request");
    if (params.mode === "url") {
      const url = new URL(params.url);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || typeof params.elicitationId !== "string" || !params.elicitationId) throw new Error("Unsupported elicitation URL");
      inputRequest = { source: params.serverName, message: params.message, fields: [], url: url.href };
    } else {
      if (![undefined, "form", "openai/form", "openaiForm"].includes(params.mode)) throw new Error("Unsupported elicitation mode");
      schema = formSchema(params.requestedSchema);
      inputRequest = { source: params.serverName, message: params.message,
        fields: Object.entries(schema.properties).map(([name, field]) => ({
          ...field, name, title: field.title || name, required: schema.required?.includes(name) || false,
          options: optionsFor(field),
        })) };
    }
  }
  const check = schema ? validator(schema) : null;
  return {
    id: String(rpcId), rpcId, method, inputRequest,
    toolName: method === "item/tool/requestUserInput" ? "request_user_input" : `mcp__${params.serverName}`,
    summary: `Input requested by ${inputRequest.source}`, input: "", rawInput: {},
    command: null, commandEditable: false, acceptAlways: false,
    availableDecisions: ["accept", "decline", "cancel"],
    validateInput(values) {
      if (!check) return null;
      const json = JSON.stringify(values);
      if (!values || typeof values !== "object" || Array.isArray(values) || json.length > 100_000) throw new Error("Invalid input values");
      // Validate the wire values too: JSON converts NaN/Infinity to null.
      const content = JSON.parse(json);
      const result = check(content);
      // Do not echo possibly secret submitted values into errors or transcripts.
      if (!result.valid) throw new Error("Invalid input: check required fields, choices and value limits");
      return content;
    },
  };
}

module.exports = { pendingFromInput };
