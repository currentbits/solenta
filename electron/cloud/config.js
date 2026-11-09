"use strict";

function cloudConfig(env = process.env) {
  const origin = env.SOLENTA_CONNECT_ORIGIN || require("../../package.json").connectOrigin;
  if (!origin) return { origin: null };
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) throw new Error("Solenta Cloud needs an exact HTTPS broker origin.");
  return { origin };
}

module.exports = { cloudConfig };
