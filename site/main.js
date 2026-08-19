// Solenta site: scroll reveals + docs scroll-spy + nav state. No dependencies.
(() => {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Reveal on scroll.
  const revealEls = document.querySelectorAll(".reveal");
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
  const siteNav = document.querySelector(".nav");
  if (siteNav) {
    const onScroll = () => siteNav.classList.toggle("scrolled", window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  // Docs scroll-spy: highlight the nav link of the section in view.
  const nav = document.getElementById("docs-nav");
  if (nav && "IntersectionObserver" in window) {
    const links = new Map(
      [...nav.querySelectorAll("a")].map((a) => [
        a.getAttribute("href").slice(1),
        a,
      ]),
    );
    const spy = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          nav.querySelectorAll("a").forEach((a) => a.classList.remove("active"));
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
