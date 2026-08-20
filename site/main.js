// Solenta site: scroll reveals, nav state, docs scroll-spy. No dependencies.
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
})();
