// public/church.js
(function () {
  // =========================
  // DEATH MUSIC (sanctuary)
  // =========================
  const isDead = !!window.__SANCTUARY_IS_DEAD__;
  const audio = document.getElementById("sanctuaryDeathMusic");

  function tryPlay() {
    if (!audio) return;

    audio.volume = 0.0;
    audio.muted = true;

    audio.play().then(() => {
      // unmute + fade in
      audio.muted = false;

      let v = 0;
      const target = 0.1;
      const step = 0.05;

      const fade = setInterval(() => {
        v = Math.min(target, v + step);
        audio.volume = v;
        if (v >= target) clearInterval(fade);
      }, 180);
    }).catch(() => {
      // Autoplay blocked — play on first user interaction
      const onFirst = () => {
        audio.muted = false;
        audio.volume = 0.65;
        audio.play().catch(() => {});
        document.removeEventListener("click", onFirst);
        document.removeEventListener("keydown", onFirst);
      };
      document.addEventListener("click", onFirst);
      document.addEventListener("keydown", onFirst);
    });
  }

  if (isDead && audio) {
    tryPlay();
  } else if (audio) {
    // Ensure no bleed if reused
    audio.pause();
    audio.currentTime = 0;
  }

  // =========================
  // SANCTUARY TIMER
  // =========================
  const el = document.getElementById("timer");
  if (!el) return;

  let seconds = Number(el.getAttribute("data-seconds") || "0");
  if (!Number.isFinite(seconds) || seconds <= 0) return;

  const t = setInterval(() => {
    seconds--;
    el.textContent = String(Math.max(0, seconds));
    if (seconds <= 0) {
      clearInterval(t);
      location.reload();
    }
  }, 1000);
})();
