// ZeroReal site: nav, copy, reveal, and THE LOOP player.
(() => {
  "use strict";
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Mobile menu
  const burger = document.getElementById("burger");
  const links = document.getElementById("navLinks");
  if (burger && links) {
    burger.addEventListener("click", () => {
      const open = links.classList.toggle("open");
      burger.classList.toggle("open", open);
      burger.setAttribute("aria-expanded", String(open));
    });
    links.addEventListener("click", (e) => {
      if (e.target.closest("a")) {
        links.classList.remove("open");
        burger.classList.remove("open");
        burger.setAttribute("aria-expanded", "false");
      }
    });
  }

  // Copy buttons
  document.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const text = btn.getAttribute("data-copy") || "";
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); } catch {}
        ta.remove();
      }
      const old = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(() => { btn.textContent = old; }, 1500);
    });
  });

  // Scroll reveal (single motion language: fade + 14px rise)
  const els = document.querySelectorAll(
    ".hero-copy, .hero-demo, .ledger li, .index > div, .install li, .faq details, .close"
  );
  els.forEach((el) => el.classList.add("reveal"));
  if ("IntersectionObserver" in window && !reduced) {
    const io = new IntersectionObserver(
      (entries) => entries.forEach((en) => {
        if (en.isIntersecting) {
          en.target.classList.add("in");
          io.unobserve(en.target);
        }
      }),
      { threshold: 0.1 }
    );
    els.forEach((el) => io.observe(el));
  } else {
    els.forEach((el) => el.classList.add("in"));
  }

  // ── THE LOOP: one agent turn, played with the product's own language ──
  // ask → bar → chip running (shimmer) → chip done + output → verdict.
  const demo = document.getElementById("loopDemo");
  const replay = document.getElementById("replay");
  if (demo) {
    const rows = [...demo.querySelectorAll(".t-row")];
    const chip = document.getElementById("demoChip");
    let timers = [];
    const later = (fn, ms) => timers.push(setTimeout(fn, ms));
    const clear = () => { timers.forEach(clearTimeout); timers = []; };

    function play() {
      clear();
      rows.forEach((r) => r.classList.remove("lit"));
      if (chip) chip.classList.remove("run");
      if (reduced) {
        rows.forEach((r) => r.classList.add("lit"));
        return;
      }
      const at = { ask: 150, bar: 850, chip: 1550, verdict: 3000 };
      later(() => rows[0].classList.add("lit"), at.ask);
      later(() => rows[1].classList.add("lit"), at.bar);
      later(() => {
        rows[2].classList.add("lit");
        if (chip) chip.classList.add("run");
      }, at.chip);
      later(() => {
        if (chip) chip.classList.remove("run");
        rows[3].classList.add("lit");
      }, at.verdict);
    }

    let played = false;
    if ("IntersectionObserver" in window && !reduced) {
      const io = new IntersectionObserver((entries) => {
        entries.forEach((en) => {
          if (en.isIntersecting && !played) {
            played = true;
            play();
            io.disconnect();
          }
        });
      }, { threshold: 0.35 });
      io.observe(demo);
    } else {
      play();
    }
    if (replay) replay.addEventListener("click", () => { played = true; play(); });
  }
})();
