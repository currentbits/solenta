"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");

let child, stopping = false, timer;
function stop() {
  if (stopping) return;
  stopping = true;
  if (!child) { process.exit(0); return; }
  child.kill("SIGTERM");
  timer = setTimeout(() => child?.kill("SIGKILL"), 2000);
}
process.once("disconnect", stop);
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
process.once("uncaughtException", stop);
process.once("message", input => {
  if (stopping || !process.connected) return stop();
  if (!input || typeof input.binary !== "string" || !path.isAbsolute(input.binary) || !Array.isArray(input.args) || input.args.length > 20 ||
      input.args.some(arg => typeof arg !== "string" || arg.length > 4096) || !input.env || typeof input.env !== "object" || Array.isArray(input.env) ||
      Object.entries(input.env).some(([key, value]) => !/^[A-Z0-9_]{1,64}$/.test(key) || typeof value !== "string" || value.length > 16384)) { process.exit(1); return; }
  child = spawn(input.binary, input.args, { env: input.env, stdio: "ignore", windowsHide: true });
  child.once("error", () => process.exit(1));
  child.once("exit", code => { child = null; clearTimeout(timer); process.exit(stopping ? 0 : code ?? 1); });
});
if (!process.connected) stop();
