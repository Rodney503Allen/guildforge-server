// public/church.js
(function () {
  // =========================
  // DEATH MUSIC (sanctuary)
  // =========================
  async function configureSanctuaryDeathMusic() {
    const isDead = !!window.__SANCTUARY_IS_DEAD__;

    const audioManager =
      window.GFAudio ||
      (window.GFAudioReady ? await window.GFAudioReady : null);

    if (!audioManager) {
      console.warn("[Sanctuary] GFAudio was not available.");
      return;
    }

    /*
     * Sanctuary death music is page-state music, not persistent world music.
     * If the player is alive, clear any active or restored death soundtrack
     * so it cannot follow them into town or another non-world page.
     */
    if (!isDead) {
      if (typeof audioManager.releasePageMusic === "function") {
        audioManager.releasePageMusic("sanctuary_death", 250);
      } else {
        audioManager.stopMusic?.(250);
      }
      return;
    }

    const playDeathMusic =
      typeof audioManager.playPageMusic === "function"
        ? audioManager.playPageMusic.bind(audioManager)
        : audioManager.playMusic.bind(audioManager);

    await playDeathMusic(
      "sanctuary_death",
      {
        volume: 0.18,
        crossfadeMs: 900,
        loop: true
      }
    );
  }

  function startSanctuaryDeathMusic() {
    configureSanctuaryDeathMusic().catch(err => {
      console.warn("[Sanctuary] Death music failed:", err);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      startSanctuaryDeathMusic,
      { once: true }
    );
  } else {
    startSanctuaryDeathMusic();
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

      if (typeof window.GFAudio?.releasePageMusic === "function") {
        window.GFAudio.releasePageMusic("sanctuary_death", 350);
      } else {
        window.GFAudio?.stopMusic?.(350);
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
