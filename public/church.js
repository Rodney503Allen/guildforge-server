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

document.addEventListener("DOMContentLoaded", () => {
  const params = new URLSearchParams(
    window.location.search
  );

  const errorMessage = params.get("error");
  const successMessage = params.get("success");

  if (errorMessage && window.GFToast) {
    window.GFToast.show(
      "Revival Failed",
      errorMessage,
      {
        type: "error",
        durationMs: 3000
      }
    );
  }

  if (successMessage && window.GFToast) {
    window.GFToast.show(
      "Revival Complete",
      successMessage,
      {
        type: "success",
        durationMs: 2600
      }
    );
  }

  if (errorMessage || successMessage) {
    const cleanUrl =
      window.location.pathname +
      window.location.hash;

    window.history.replaceState(
      {},
      document.title,
      cleanUrl
    );
  }
});


const reviveForm = document.getElementById("reviveForm");

if (reviveForm) {
  reviveForm.addEventListener("submit", async event => {
    event.preventDefault();

    const reviveBtn = document.getElementById("reviveBtn");

    if (reviveBtn?.disabled) {
      return;
    }

    if (reviveBtn) {
      reviveBtn.disabled = true;
    }

    try {
      const response = await fetch("/church/revive", {
        method: "POST",
        credentials: "include",
        headers: {
          "Accept": "application/json"
        }
      });

      const data = await response.json();

      if (!response.ok || data.error) {
        window.GFToast.show(
          "Revival Failed",
          data.error || "You could not be revived.",
          {
            type: "error",
            durationMs: 3000
          }
        );

        if (reviveBtn) {
          reviveBtn.disabled = false;
        }

        return;
      }

      window.GFToast.show(
        "Revival Complete",
        data.message || "You have been restored to life.",
        {
          type: "success",
          durationMs: 2500
        }
      );

      window.dispatchEvent(
        new CustomEvent("guildforge:player-updated", {
          detail: {
            source: "sanctuary",
            reason: "revived"
          }
        })
      );

      setTimeout(() => {
        window.location.href = "/town";
      }, 900);
    } catch (err) {
      console.error("Revival request failed:", err);

      window.GFToast.show(
        "Revival Failed",
        "The Sanctuary could not complete the revival.",
        {
          type: "error",
          durationMs: 3000
        }
      );

      if (reviveBtn) {
        reviveBtn.disabled = false;
      }
    }
  });
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
