// public/town.js

(function initTown() {
  const tiles = Array.from(document.querySelectorAll(".service-tile"));
  if (!tiles.length) return;

  // Allow keyboard activation for town service tiles.
  tiles.forEach((tile) => {
    tile.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        tile.click();
      }
    });
  });
})();

const HAVEN_REPORT_TYPES = {
  WORLD_EVENT: {
    label: "World Event",
    icon: "◈"
  },
  WORLD_BOSS: {
    label: "World Boss",
    icon: "!"
  },
  BOSS_DEFEATED: {
    label: "Victory",
    icon: "⚔"
  },
  LEVEL_MILESTONE: {
    label: "Milestone",
    icon: "▲"
  },
  RARE_DROP: {
    label: "Rare Find",
    icon: "◆"
  },
  WORLD_FIRST: {
    label: "World First",
    icon: "★"
  },
  SYSTEM: {
    label: "Realm News",
    icon: "●"
  }
};

function getReportPresentation(type) {
  const normalized = String(type || "SYSTEM").toUpperCase();

  return {
    type: normalized,
    ...(HAVEN_REPORT_TYPES[normalized] || HAVEN_REPORT_TYPES.SYSTEM)
  };
}

function formatReportAge(value) {
  if (!value) return "";

  const created = new Date(value);
  const timestamp = created.getTime();

  if (!Number.isFinite(timestamp)) return "";

  const diffMs = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(diffMs / 60000);

  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  return created.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric"
  });
}

function createReportElement(report) {
  const presentation = getReportPresentation(report?.report_type);
  const importance = Math.max(
    1,
    Math.min(3, Number(report?.importance || 1))
  );

  const article = document.createElement("article");
  article.className =
    `haven-report haven-report--${presentation.type.toLowerCase().replace(/_/g, "-")} ` +
    `haven-report--importance-${importance}`;

  const icon = document.createElement("div");
  icon.className = "haven-report__icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = presentation.icon;

  const content = document.createElement("div");
  content.className = "haven-report__content";

  const meta = document.createElement("div");
  meta.className = "haven-report__meta";

  const type = document.createElement("span");
  type.className = "haven-report__type";
  type.textContent = presentation.label;

  const time = document.createElement("time");
  time.className = "haven-report__time";

  if (report?.created_at) {
    const date = new Date(report.created_at);

    if (Number.isFinite(date.getTime())) {
      time.dateTime = date.toISOString();
      time.title = date.toLocaleString();
    }
  }

  time.textContent = formatReportAge(report?.created_at);

  meta.append(type, time);

  const title = document.createElement("h4");
  title.className = "haven-report__title";
  title.textContent = String(report?.title || "Haven Report");

  const message = document.createElement("p");
  message.className = "haven-report__message";
  message.textContent = String(report?.message || "");

  content.append(meta, title, message);
  article.append(icon, content);

  return article;
}

function renderReportState(feed, className, icon, title, message) {
  feed.replaceChildren();

  const state = document.createElement("div");
  state.className = `haven-reports__state ${className}`;

  const mark = document.createElement("span");
  mark.className = "haven-reports__state-icon";
  mark.setAttribute("aria-hidden", "true");
  mark.textContent = icon;

  const copy = document.createElement("div");

  const heading = document.createElement("strong");
  heading.textContent = title;

  const body = document.createElement("span");
  body.textContent = message;

  copy.append(heading, body);
  state.append(mark, copy);
  feed.append(state);
}

async function loadTownGossip() {
  const el = document.getElementById("town-gossip");
  const meta = document.getElementById("town-gossip-meta");

  if (!el) return;

  const townId = Number(window.GF_TOWN_ID || 0);
  if (!townId) return;

  try {
    const res = await fetch(`/api/town/${townId}/gossip`, {
      credentials: "include"
    });

    if (!res.ok) {
      throw new Error(`Gossip request failed: ${res.status}`);
    }

    const data = await res.json();

    if (!data?.hasGossip) {
      el.textContent = data?.text || "No gossip right now.";
      if (meta) meta.textContent = "";
      return;
    }

    el.textContent = data.text;
    if (meta) {
      meta.textContent = data.title ? `— About: ${data.title}` : "";
    }
  } catch (error) {
    console.error("Town gossip failed:", error);
    el.textContent = "The whispers fade. Try again.";
    if (meta) meta.textContent = "";
  }
}

async function loadHavenReports() {
  const feed = document.getElementById("world-feed");
  if (!feed) return;

  try {
    const res = await fetch("/api/town/reports", {
      credentials: "include"
    });

    if (!res.ok) {
      throw new Error(`Haven reports request failed: ${res.status}`);
    }

    const data = await res.json();
    const reports = Array.isArray(data?.reports) ? data.reports : [];

    if (!reports.length) {
      renderReportState(
        feed,
        "haven-reports__state--empty",
        "◇",
        "The ledger is quiet",
        "No noteworthy reports have reached the haven yet."
      );
      return;
    }

    reports.sort((a, b) => {
      const aTime = new Date(a?.created_at || 0).getTime() || 0;
      const bTime = new Date(b?.created_at || 0).getTime() || 0;
      return bTime - aTime;
    });

    const fragment = document.createDocumentFragment();

    reports.forEach((report) => {
      fragment.append(createReportElement(report));
    });

    feed.replaceChildren(fragment);
  } catch (error) {
    console.error("Haven reports failed:", error);

    renderReportState(
      feed,
      "haven-reports__state--error",
      "!",
      "Reports unavailable",
      "The latest news from beyond the haven could not be gathered."
    );
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadTownGossip();
  loadHavenReports();
});