// Solenta site: scroll reveals, nav state, docs scroll-spy, downloads.
// No dependencies.
(() => {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Reveal on scroll, with a light stagger between siblings that share
  // a parent (bento grids, install cards, hero stack).
  const revealEls = [...document.querySelectorAll(".reveal")];
  const groups = new Map();
  for (const el of revealEls) {
    const key = el.parentElement;
    const n = groups.get(key) || 0;
    el.style.setProperty("--d", `${Math.min(n * 70, 420)}ms`);
    groups.set(key, n + 1);
  }
  if (reduce || !("IntersectionObserver" in window)) {
    revealEls.forEach((el) => el.classList.add("in"));
  } else {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        }
      },
      { threshold: 0.12 },
    );
    revealEls.forEach((el) => io.observe(el));
  }

  // Nav picks up a border and stronger blur once the page scrolls.
  const nav = document.querySelector(".nav");
  if (nav) {
    const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  // Docs scroll-spy: highlight the nav link of the section in view.
  const docsNav = document.getElementById("docs-nav");
  if (docsNav && "IntersectionObserver" in window) {
    const links = new Map(
      [...docsNav.querySelectorAll("a")].map((a) => [
        a.getAttribute("href").slice(1),
        a,
      ]),
    );
    const spy = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          docsNav.querySelectorAll("a").forEach((a) => a.classList.remove("active"));
          links.get(e.target.id)?.classList.add("active");
        }
      },
      { rootMargin: "-20% 0px -70% 0px" },
    );
    links.forEach((_, id) => {
      const el = document.getElementById(id);
      if (el) spy.observe(el);
    });
  }

  // ---------------- downloads ----------------
  // Release assets embed the version (Solenta-v0.15.0-macos-arm64.zip), so a
  // direct asset link needs the current tag. Every [data-dl] link ships
  // pointing at the releases page, which is always correct; with JS we
  // narrow it to the exact file. FALLBACK_TAG is the last tag this page was
  // edited for and is the ONLY place the version is written down; the GitHub
  // API refines it, cached for a day so a page view is not an API call.
  // ponytail: runtime fetch, not build-time templating, because the site has
  // no build step at all (site/Dockerfile just COPYs the directory into nginx).
  const REPO = "https://github.com/currentbits/solenta";
  const FALLBACK_TAG = "v0.15.0";
  const ASSET = {
    mac: (t) => `Solenta-${t}-macos-arm64.zip`,
    win: (t) => `Solenta-${t}-win32-x64.zip`,
    linux: (t) => `Solenta-${t}-linux-x64.tar.gz`,
  };
  const OS_LABEL = { mac: "macOS", win: "Windows", linux: "Linux" };

  const dlLinks = [...document.querySelectorAll("[data-dl]")];
  if (dlLinks.length) {
    const os = (() => {
      const ua = navigator.userAgent;
      if (/Android|iPhone|iPad|iPod/i.test(ua)) return null; // no mobile build
      const s = (
        navigator.userAgentData?.platform ||
        navigator.platform ||
        ua
      ).toLowerCase();
      if (s.includes("win")) return "win";
      if (s.includes("mac")) return "mac";
      if (s.includes("linux") || s.includes("x11")) return "linux";
      return null;
    })();

    const paint = (tag) => {
      for (const a of dlLinks) {
        // data-dl="auto" is the hero button: it follows the detected platform,
        // and stays on the releases page when detection came up empty.
        const key = a.dataset.dl === "auto" ? os : a.dataset.dl;
        if (ASSET[key]) a.href = `${REPO}/releases/latest/download/${ASSET[key](tag)}`;
      }
      for (const el of document.querySelectorAll("[data-tag]")) {
        el.textContent = `Latest release ${tag}. Free, MIT, no account.`;
        el.hidden = false;
      }
    };

    if (os) {
      const btn = document.getElementById("hero-dl");
      if (btn) {
        btn.textContent = `Download for ${OS_LABEL[os]}`;
        btn.removeAttribute("data-platform");
        btn.setAttribute("data-platform", os);
      }
      const lead = document.getElementById("hero-alt-lead");
      if (lead) lead.textContent = "Also for";
      document.querySelector(`.hero-alt [data-dl="${os}"]`)?.setAttribute("hidden", "");
      const card = document.querySelector(`.install-card[data-os="${os}"]`);
      if (card) {
        card.classList.add("is-you");
        card.querySelector(".btn")?.classList.replace("btn-ghost", "btn-primary");
      }
    }

    paint(FALLBACK_TAG);

    // GitHub excludes prereleases from /releases/latest, so the nightly tags
    // never win here. Anything that is not a vX.Y.Z tag is ignored anyway.
    let cached = null;
    try {
      const c = JSON.parse(localStorage.getItem("solenta.tag") || "null");
      if (c && Date.now() - c.t < 864e5) cached = c.v;
    } catch {}

    if (cached) {
      paint(cached);
    } else {
      fetch(`https://api.github.com/repos/currentbits/solenta/releases/latest`)
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then(({ tag_name }) => {
          if (!/^v\d+\.\d+\.\d+$/.test(tag_name || "")) return;
          paint(tag_name);
          try {
            localStorage.setItem(
              "solenta.tag",
              JSON.stringify({ v: tag_name, t: Date.now() }),
            );
          } catch {}
        })
        .catch(() => {}); // rate limited or offline: FALLBACK_TAG already painted
    }
  }
})();
