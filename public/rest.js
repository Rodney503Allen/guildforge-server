// public/rest.js

function formatTime(totalSeconds) {
  const seconds = Math.max(0, Number(totalSeconds || 0));
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;

  return `${mins}:${String(secs).padStart(2, "0")}`;
}

window.__restCampfireInterval = window.__restCampfireInterval || null;
window.__restRefreshInterval = window.__restRefreshInterval || null;

function clearRestIntervals() {
  if (window.__restCampfireInterval) {
    clearInterval(window.__restCampfireInterval);
    window.__restCampfireInterval = null;
  }

  if (window.__restRefreshInterval) {
    clearInterval(window.__restRefreshInterval);
    window.__restRefreshInterval = null;
  }
}

function startCampfireTimer() {
  const timer = document.querySelector("[data-campfire-seconds]");
  if (!timer) return;

  if (window.__restCampfireInterval) {
    clearInterval(window.__restCampfireInterval);
  }

  let secondsLeft = Number(timer.dataset.campfireSeconds || 0);
  timer.textContent = formatTime(secondsLeft);

  window.__restCampfireInterval = setInterval(() => {
    secondsLeft--;

    if (secondsLeft <= 0) {
      clearInterval(window.__restCampfireInterval);
      window.__restCampfireInterval = null;

      if (typeof window.openRest === "function") {
        window.openRest();
      }

      return;
    }

    timer.textContent = formatTime(secondsLeft);
  }, 1000);
}

function startRestRefresh() {
  const panel = document.querySelector("[data-rest-active]");
  if (!panel) return;

  if (window.__restRefreshInterval) {
    clearInterval(window.__restRefreshInterval);
  }

  window.__restRefreshInterval = setInterval(async () => {
    try {
      const res = await fetch("/rest/tick", {
        credentials: "include"
      });

      const data = await res.json();
      if (!data?.success) return;

      if (typeof window.loadStatPanel === "function") {
        await window.loadStatPanel();
      }

      if (typeof window.refreshStatPanel === "function") {
        await window.refreshStatPanel();
      }
    } catch (err) {
      console.error("Rest tick failed", err);
    }
  }, 10000);
}

async function startCampfire(event) {
  event?.preventDefault();

  try {
    const res = await fetch("/rest/start-fire", {
      method: "POST",
      credentials: "include"
    });

    const data = await res.json();
    if (!data?.success) return;

    if (typeof window.openRest === "function") {
      await window.openRest();
    }
  } catch (err) {
    console.error("Failed to start campfire", err);
  }
}

window.startCampfire = startCampfire;

function initRestModal() {
  clearRestIntervals();
  startCampfireTimer();
  startRestRefresh();
}

async function closeRestModal() {
  clearRestIntervals();

  try {
    await fetch("/rest/stop", {
      method: "POST",
      credentials: "include"
    });
  } catch (err) {
    console.error(err);
  }

  const root = document.getElementById("rest-root");
  if (root) root.innerHTML = "";
}

window.initRestModal = initRestModal;
window.clearRestIntervals = clearRestIntervals;
window.closeRestModal = closeRestModal;

document.addEventListener("DOMContentLoaded", initRestModal);