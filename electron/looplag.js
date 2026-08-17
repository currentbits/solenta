"use strict";

/**
 * Main-process event-loop lag probe for issue #124.
 * Off unless CODER_LOOP_LAG=1 — do not even create the histogram.
 *
 *   CODER_LOOP_LAG=1 npm run dev
 */

const FLAG = "CODER_LOOP_LAG";
const INTERVAL_MS = 5000;

/** @type {import("node:perf_hooks").IntervalHistogram | null} */
let histogram = null;
/** @type {NodeJS.Timeout | null} */
let timer = null;

/**
 * @param {number} ns
 * @returns {number}
 */
function nsToMs(ns) {
  const ms = Number(ns) / 1e6;
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * @returns {{ mean: number, p50: number, p99: number, max: number } | null}
 */
function snapshot() {
  if (!histogram) return null;
  return {
    mean: nsToMs(histogram.mean),
    p50: nsToMs(histogram.percentile(50)),
    p99: nsToMs(histogram.percentile(99)),
    max: nsToMs(histogram.max),
  };
}

function start() {
  if (histogram) return;
  if (process.env[FLAG] !== "1") return;
  const { monitorEventLoopDelay } = require("node:perf_hooks");
  histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  timer = setInterval(() => {
    const s = snapshot();
    if (!s) return;
    console.error(
      `[looplag] mean=${s.mean.toFixed(1)}ms p50=${s.p50.toFixed(1)}ms p99=${s.p99.toFixed(1)}ms max=${s.max.toFixed(1)}ms`,
    );
    histogram.reset();
  }, INTERVAL_MS);
  timer.unref?.();
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (histogram) {
    histogram.disable();
    histogram = null;
  }
}

module.exports = { start, stop, snapshot, FLAG, INTERVAL_MS };
