(() => {
  const HOSTS = { "solenta.app": 1, "www.solenta.app": 1 };
  if (!HOSTS[location.hostname]) return;
  const ENDPOINT = "https://stats.solenta.app/e";

  const send = (n, extra) => {
    const payload = {
      n,
      u: location.href,
      r: document.referrer || "",
      ...extra,
    };
    const body = JSON.stringify(payload);
    try {
      // String, not Blob: browsers still POST text/plain, and tests can
      // JSON.parse(String(body)). A Blob stringifies as "[object Blob]".
      navigator.sendBeacon(ENDPOINT, body);
    } catch {
      fetch(ENDPOINT, {
        method: "POST",
        body,
        headers: { "content-type": "text/plain;charset=UTF-8" },
        keepalive: true,
      }).catch(() => {});
    }
  };

  send("pageview");

  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-event]");
    if (!el) return;
    const n = el.getAttribute("data-event");
    if (!n) return;
    const platform = el.getAttribute("data-platform");
    send(n, platform ? { p: { platform } } : {});
  });
})();
