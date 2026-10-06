// toast.js
(function () {
  const DEFAULT_DURATION_MS = 3800;
  const activeRequests = new Map();

  function ensureWrap() {
    let wrap = document.getElementById("toastWrap");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.id = "toastWrap";
      wrap.className = "toast-wrap";
      document.body.appendChild(wrap);
    }
    return wrap;
  }

  function removeToast(el) {
    if (!el || !el.isConnected) return;
    el.style.animation = "toastOut .20s ease forwards";
    setTimeout(() => el.remove(), 240);
  }

  function show(title, body, opts = {}) {
    const wrap = ensureWrap();
    const type = opts.type || "";
    const persistent = opts.persistent === true;
    const durationMs = Number.isFinite(opts.durationMs)
      ? opts.durationMs
      : DEFAULT_DURATION_MS;

    const el = document.createElement("div");
    el.className = "toast " + type;

    const titleEl = document.createElement("div");
    titleEl.className = "toast-title";
    titleEl.textContent = String(title || "");

    const bodyEl = document.createElement("div");
    bodyEl.className = "toast-body";
    bodyEl.textContent = String(body || "");

    el.append(titleEl, bodyEl);

    if (Array.isArray(opts.actions) && opts.actions.length) {
      const actions = document.createElement("div");
      actions.className = "toast-actions";

      opts.actions.forEach(action => {
        const button = document.createElement("button");
        button.type = "button";
        button.className =
          "toast-action " +
          (action.className || "");

        button.textContent =
          String(action.label || "Action");

        button.addEventListener("click", async () => {
          if (button.disabled) return;

          const buttons =
            actions.querySelectorAll("button");

          buttons.forEach(btn => {
            btn.disabled = true;
          });

          try {
            if (typeof action.onClick === "function") {
              await action.onClick({
                toast: el,
                close: () => removeToast(el),
              });
            }

            if (action.closeOnSuccess !== false) {
              removeToast(el);
            }
          } catch (error) {
            buttons.forEach(btn => {
              btn.disabled = false;
            });

            show(
              "Request Failed",
              error?.message || "Unable to complete that request.",
              { type: "error" },
            );
          }
        });

        actions.appendChild(button);
      });

      el.appendChild(actions);
    }

    wrap.appendChild(el);

    if (!persistent) {
      setTimeout(() => removeToast(el), durationMs);
    }

    return {
      element: el,
      close: () => removeToast(el),
    };
  }

  async function postJson(url) {
    const response = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
      },
      body: "{}",
    });

    let data = {};
    try {
      data = await response.json();
    } catch (_) {}

    if (!response.ok || data?.ok === false) {
      throw new Error(
        data?.error || "Unable to complete that request.",
      );
    }

    return data;
  }

  function requestKey(kind, id) {
    return `${kind}:${Number(id)}`;
  }

  function clearRequest(kind, id) {
    const key = requestKey(kind, id);
    const existing = activeRequests.get(key);

    if (existing) {
      existing.close();
      activeRequests.delete(key);
    }
  }

  function showPartyInvite(payload = {}) {
    const inviteId = Number(payload.inviteId);
    if (!Number.isInteger(inviteId) || inviteId <= 0) return;

    const key = requestKey("party", inviteId);
    if (activeRequests.has(key)) return;

    const inviterName =
      String(payload.inviterName || "Another player");

    const toast = show(
      "Party Invite",
      `${inviterName} invited you to join their party.`,
      {
        type: "request party-request",
        persistent: true,
        actions: [
          {
            label: "Decline",
            className: "decline",
            onClick: async () => {
              await postJson(
                `/party/invites/${inviteId}/decline`
              );
              activeRequests.delete(key);
            },
          },
          {
            label: "Accept",
            className: "accept",
            onClick: async () => {
              await postJson(
                `/party/invites/${inviteId}/accept`
              );
              activeRequests.delete(key);

              show(
                "Party Joined",
                `You joined ${inviterName}'s party.`,
                { type: "success" },
              );

              window.dispatchEvent(
                new CustomEvent("guildforge:party-changed"),
              );
            },
          },
        ],
      },
    );

    activeRequests.set(key, toast);
  }

  function showTradeRequest(payload = {}) {
    const tradeId = Number(payload.tradeId);
    if (!Number.isInteger(tradeId) || tradeId <= 0) return;

    const key = requestKey("trade", tradeId);
    if (activeRequests.has(key)) return;

    const initiatorName =
      String(payload.initiatorName || "Another player");

    const toast = show(
      "Trade Request",
      `${initiatorName} wants to trade with you.`,
      {
        type: "request trade-request",
        persistent: true,
        actions: [
          {
            label: "Decline",
            className: "decline",
            onClick: async () => {
              await postJson(
                `/api/trade/requests/${tradeId}/decline`,
              );
              activeRequests.delete(key);
            },
          },
          {
            label: "Accept",
            className: "accept",
            onClick: async () => {
              const data = await postJson(
                `/api/trade/requests/${tradeId}/accept`,
              );

              activeRequests.delete(key);

              window.dispatchEvent(
                new CustomEvent(
                  "guildforge:trade-request-accepted",
                  {
                    detail: {
                      tradeId,
                      trade: data.trade || null,
                    },
                  },
                ),
              );

              // Tavern's existing trade UI can react to its socket refresh.
              // On pages without that UI, tell the player the request succeeded.
              show(
                "Trade Accepted",
                `Trade with ${initiatorName} accepted.`,
                { type: "success" },
              );
            },
          },
        ],
      },
    );

    activeRequests.set(key, toast);
  }

  function connectSocialToasts() {
    if (typeof window.io !== "function") {
      return;
    }

    const socket = window.io();

    socket.on("party:invite", showPartyInvite);
    socket.on("trade:request", showTradeRequest);

    socket.on("trade:changed", event => {
      const tradeId = Number(event?.tradeId);
      const status = String(event?.status || "");

      if (
        tradeId > 0 &&
        ["active", "declined", "cancelled", "completed"].includes(status)
      ) {
        clearRequest("trade", tradeId);
      }
    });
  }

  window.GFToast = {
    show,
    showPartyInvite,
    showTradeRequest,
  };

  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      connectSocialToasts,
      { once: true },
    );
  } else {
    connectSocialToasts();
  }
})();
