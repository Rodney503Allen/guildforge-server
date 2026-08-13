(function () {
  "use strict";

  let currentCheck = null;
  let countdownTimer = null;
  let requestPending = false;
  let combatOpening = false;

  const byId = (id) =>
    document.getElementById(id);

  function playerId() {
    const value =
      Number(window.__PLAYER_ID__);

    return Number.isInteger(value) &&
      value > 0
      ? value
      : null;
  }

  function isCurrentPlayer(member) {
    const currentPlayerId =
      playerId();

    return (
      currentPlayerId !== null &&
      Number(member?.playerId) ===
        currentPlayerId
    );
  }

  async function api(
    url,
    options = {}
  ) {
    const response =
      await fetch(url, {
        credentials: "include",
        ...options,

        headers: {
          ...(options.body
            ? {
                "Content-Type":
                  "application/json"
              }
            : {}),

          ...(options.headers || {})
        }
      });

    let data;

    try {
      data =
        await response.json();
    } catch (_) {
      data = null;
    }

    if (
      !response.ok ||
      data?.ok === false
    ) {
      throw new Error(
        data?.error ||
          "The Hunt ready check could not be updated."
      );
    }

    return data;
  }

  function showError(message) {
    const error =
      byId("huntReadyError");

    if (!error) return;

    error.textContent =
      message ||
      "Something went wrong.";

    error.hidden = false;
  }

  function clearError() {
    const error =
      byId("huntReadyError");

    if (!error) return;

    error.textContent = "";
    error.hidden = true;
  }

  function setBusy(busy) {
    requestPending = busy;

    const toggle =
      byId("huntReadyToggleBtn");

    const cancel =
      byId("huntReadyCancelBtn");

    if (toggle) {
      toggle.disabled =
        busy ||
        currentCheck?.status !==
          "pending";
    }

    if (cancel) {
      cancel.disabled = busy;
    }
  }

  function openModal() {
    byId("huntReadyModal")
      ?.classList.remove("hidden");

    document.body.classList.add(
      "hunt-ready-open"
    );
  }

  function closeModal() {
    byId("huntReadyModal")
      ?.classList.add("hidden");

    document.body.classList.remove(
      "hunt-ready-open"
    );

    stopTimers();
    currentCheck = null;
  }

  function stopTimers() {
    if (countdownTimer) {
      window.clearInterval(
        countdownTimer
      );
    }

    countdownTimer = null;
  }

  function formatRemaining(
    expiresAt
  ) {
    const remaining =
      Math.max(
        0,
        new Date(expiresAt).getTime() -
          Date.now()
      );

    const seconds =
      Math.ceil(remaining / 1000);

    return `0:${String(seconds)
      .padStart(2, "0")}`;
  }

  function updateCountdown() {
    const countdown =
      byId("huntReadyCountdown");

    if (
      !countdown ||
      !currentCheck
    ) {
      return;
    }

    if (
      currentCheck.status !==
      "pending"
    ) {
      countdown.textContent =
        "0:00";

      return;
    }

    countdown.textContent =
      formatRemaining(
        currentCheck.expiresAt
      );
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function render(check) {
    if (!check) return;

    currentCheck = check;

    openModal();
    clearError();

    const me =
      check.players?.find(
        isCurrentPlayer
      );

    const readyCount =
      (check.players || [])
        .filter(
          member =>
            member.isReady
        )
        .length;

    const total =
      check.players?.length || 0;

    const status =
      byId("huntReadyStatus");

    if (status) {
      status.textContent =
        check.status === "pending"
          ? `${readyCount} of ${total} adventurers ready`

          : check.status ===
              "completed"
            ? "The party is ready. Entering battle..."

          : check.status ===
              "cancelled"
            ? "The ready check was cancelled."

          : "The ready check expired.";
    }

    const participants =
      byId(
        "huntReadyParticipants"
      );

    if (participants) {
      participants.innerHTML =
        (check.players || [])
          .map(
            member => `
              <div
                class="
                  hunt-ready-player
                  ${
                    member.isReady
                      ? "is-ready"
                      : "is-waiting"
                  }
                "
              >
                <span
                  class="
                    hunt-ready-player__sigil
                  "
                  aria-hidden="true"
                >
                  ${
                    member.isReady
                      ? "✓"
                      : "…"
                  }
                </span>

                <span
                  class="
                    hunt-ready-player__name
                  "
                >
                  ${escapeHtml(
                    member.name
                  )}

                  ${
                    isCurrentPlayer(
                      member
                    )
                      ? " (You)"
                      : ""
                  }
                </span>

                <span
                  class="
                    hunt-ready-player__state
                  "
                >
                  ${
                    member.isReady
                      ? "Ready"
                      : "Waiting"
                  }
                </span>
              </div>
            `
          )
          .join("");
    }

    const toggle =
      byId("huntReadyToggleBtn");

    if (toggle) {
      toggle.textContent =
        me?.isReady
          ? "Unready"
          : "Ready";

      toggle.classList.toggle(
        "hunt-ready-btn--unready",
        Boolean(me?.isReady)
      );

      /*
       * The backend identifies the
       * responding player through the
       * authenticated session.
       *
       * A missing or mismatched
       * window.__PLAYER_ID__ must not
       * disable the Ready button.
       */
      toggle.disabled =
        requestPending ||
        check.status !== "pending";
    }

    const cancel =
      byId("huntReadyCancelBtn");

    if (cancel) {
      const canCancel =
        check.canCancel === true ||
        check.createdByPlayerId ===
          playerId() ||
        check.leaderPlayerId ===
          playerId();

      cancel.hidden =
        check.status !== "pending" ||
        !canCancel;
    }

    updateCountdown();
  }

  async function enterCombat() {
    if (combatOpening) return;

    combatOpening = true;

    stopTimers();

    try {
      const status =
        byId("huntReadyStatus");

      if (status) {
        status.textContent =
          "The quarry is engaged. Entering battle...";
      }

      setBusy(true);

      if (
        typeof window
          .openHuntCombatModal !==
        "function"
      ) {
        throw new Error(
          "Hunt combat UI is unavailable."
        );
      }

      await window
        .openHuntCombatModal();

      closeModal();

      if (
        typeof window
          .loadNearbyObjects ===
        "function"
      ) {
        await window
          .loadNearbyObjects();
      }
    } catch (error) {
      combatOpening = false;

      showError(
        error.message ||
          "Unable to open Hunt combat."
      );

      setBusy(false);
    }
  }

  function handleResult(data) {
    const check =
      data?.readyCheck ?? data;

    if (!check) {
      closeModal();
      return;
    }

    render(check);

    if (
      data?.encounter ||
      check.status === "completed"
    ) {
      void enterCombat();
      return;
    }

    if (
      check.status ===
        "cancelled" ||
      check.status ===
        "expired"
    ) {
      stopTimers();

      window.setTimeout(
        closeModal,
        1800
      );
    }
  }

  function startTimers() {
    stopTimers();

    countdownTimer =
      window.setInterval(
        updateCountdown,
        250
      );

  }

  async function startReadyCheck(
    partyHuntId
  ) {
    if (
      requestPending ||
      combatOpening
    ) {
      return;
    }

    setBusy(true);
    clearError();

    try {
      const data =
        await api(
          "/hunts/active/confront",
          {
            method: "POST",

            body:
              JSON.stringify({
                partyHuntId:
                  Number(
                    partyHuntId
                  )
              })
          }
        );

      handleResult(data);

      if (
        data.readyCheck?.status ===
        "pending"
      ) {
        startTimers();
      }
    } catch (error) {
      showError(error.message);

      if (
        window.GFToast?.show
      ) {
        window.GFToast.show(
          "Hunt Failed",
          error.message,
          {
            type: "error",
            durationMs: 3000
          }
        );
      }
    } finally {
      setBusy(false);
    }
  }

  async function toggleReady() {
    if (
      requestPending ||
      currentCheck?.status !==
        "pending"
    ) {
      return;
    }

    const me =
      currentCheck.players?.find(
        isCurrentPlayer
      );

    setBusy(true);
    clearError();

    try {
      const data =
        await api(
          "/hunts/ready-check/ready",
          {
            method: "POST",

            body:
              JSON.stringify({
                /*
                 * If the client cannot
                 * identify its roster
                 * entry, send Ready.
                 * The server determines
                 * the player from their
                 * login session.
                 */
                ready:
                  me
                    ? !me.isReady
                    : true
              })
          }
        );

      handleResult(data);
    } catch (error) {
      showError(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function cancelReadyCheck() {
    if (
      requestPending ||
      currentCheck?.status !==
        "pending"
    ) {
      return;
    }

    setBusy(true);
    clearError();

    try {
      const data =
        await api(
          "/hunts/ready-check/cancel",
          {
            method: "POST"
          }
        );

      handleResult(data);
    } catch (error) {
      showError(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function restoreReadyCheck() {
    try {
      const data =
        await api(
          "/hunts/ready-check"
        );

      const check =
        data?.readyCheck;

      if (!check) return;

      handleResult(check);

      if (
        check.status === "pending"
      ) {
        startTimers();
      }
    } catch (error) {
      console.warn(
        "Unable to restore Hunt ready check",
        error
      );
    }
  }


  function getHuntSocket() {
    if (
      window.GFSocket?.connected ||
      window.GFSocket
    ) {
      return window.GFSocket;
    }

    if (
      typeof window.io !==
      "function"
    ) {
      return null;
    }

    window.GFSocket =
      window.io();

    return window.GFSocket;
  }

  function connectReadyCheckSocket() {
    const socket =
      getHuntSocket();

    if (!socket) {
      console.error(
        "Hunt socket client failed to load."
      );

      return;
    }

    const subscribe = () => {
      socket.emit(
        "hunt:subscribe"
      );
    };

    if (socket.connected) {
      subscribe();
    }

    socket.on(
      "connect",
      subscribe
    );

    socket.on(
      "hunt:ready-check",
      data => {
        handleResult(
          data
        );

        if (
          data?.readyCheck?.status ===
          "pending"
        ) {
          startTimers();
        }
      }
    );
  }

  function init() {
    connectReadyCheckSocket();

    byId("huntReadyToggleBtn")
      ?.addEventListener(
        "click",
        toggleReady
      );

    byId("huntReadyCancelBtn")
      ?.addEventListener(
        "click",
        cancelReadyCheck
      );

    void restoreReadyCheck();
  }

  window.startHuntReadyCheck =
    startReadyCheck;

  /*
   * Existing Nearby buttons call this
   * global name. Loading this file
   * after world.js redirects Confront
   * into the ready-check flow.
   */
  window.confrontHuntTarget =
    startReadyCheck;

  if (
    document.readyState ===
    "loading"
  ) {
    document.addEventListener(
      "DOMContentLoaded",
      init,
      {
        once: true
      }
    );
  } else {
    init();
  }
})();