// public/world-events.js

(() => {
  let currentRegionId = null;
  let currentEvent = null;
  let currentPlayerEvent = null;
  let timerInterval = null;
  let lastLoadedRegionId = null;
  let pendingRewardBundles = [];
  let rewardClaimBusy = false;

  function byId(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function stopTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  function hidePanel() {
    stopTimer();
    currentEvent = null;
    currentPlayerEvent = null;

    const panel = byId("worldEventPanel");
    if (panel) {
      panel.hidden = true;
      panel.classList.remove(
        "world-event-panel--phase-two",
        "world-event-panel--urgent"
      );
    }
  }

  function formatRemaining(ms) {
    const totalSeconds =
      Math.max(
        0,
        Math.ceil(ms / 1000)
      );

    const hours =
      Math.floor(totalSeconds / 3600);

    const minutes =
      Math.floor(
        (totalSeconds % 3600) / 60
      );

    const seconds =
      totalSeconds % 60;

    if (hours > 0) {
      return (
        `${hours}:` +
        `${String(minutes).padStart(2, "0")}:` +
        `${String(seconds).padStart(2, "0")}`
      );
    }

    return (
      `${minutes}:` +
      `${String(seconds).padStart(2, "0")}`
    );
  }

  function renderTimer() {
    const timer = byId("worldEventTimer");
    const panel = byId("worldEventPanel");

    if (
      !timer ||
      !panel ||
      !currentEvent?.endsAt
    ) {
      return;
    }

    const remaining =
      new Date(currentEvent.endsAt).getTime() -
      Date.now();

    timer.textContent =
      formatRemaining(remaining);

    panel.classList.toggle(
      "world-event-panel--urgent",
      remaining > 0 &&
      remaining <= 5 * 60 * 1000
    );

    if (remaining <= 0) {
      timer.textContent = "0:00";
      stopTimer();

      // One server refresh when the local timer reaches zero.
      window.setTimeout(
        () => {
          if (
            currentRegionId != null
          ) {
            void loadRegionEvent(
              currentRegionId,
              true
            );
          }
        },
        800
      );
    }
  }

  function startTimer() {
    stopTimer();
    renderTimer();

    timerInterval =
      window.setInterval(
        renderTimer,
        1000
      );
  }

  function prettifyObjectiveKey(key) {
    return String(key || "Objective")
      .replaceAll("_", " ")
      .replace(/\b\w/g, c => c.toUpperCase());
  }

  function renderObjectives(
    objectives,
    playerEvent
  ) {
    const root =
      byId("worldEventObjectives");

    if (!root) {
      return;
    }

    const list =
      Array.isArray(objectives)
        ? objectives
        : [];

    const committed =
      Boolean(
        playerEvent?.committed
      );

    const chosenOutcomeId =
      playerEvent?.chosenOutcomeId == null
        ? null
        : Number(
            playerEvent.chosenOutcomeId
          );

    /*
     * Before commitment, show every personal path.
     * After commitment, show only the objective that maps to the
     * player's chosen outcome.
     */
    const visibleObjectives =
      committed
        ? list.filter(objective =>
            Number(objective.outcomeId) ===
            chosenOutcomeId
          )
        : list;

    const objectiveHtml =
      visibleObjectives.length
        ? visibleObjectives
            .map(objective => {
              const current =
                Math.max(
                  0,
                  Number(
                    objective.currentAmount ??
                    0
                  )
                );

              const target =
                Math.max(
                  1,
                  Number(
                    objective.targetAmount ??
                    1
                  )
                );

              const pct =
                Math.max(
                  0,
                  Math.min(
                    100,
                    (current / target) * 100
                  )
                );

              const complete =
                Boolean(
                  objective.completedAt
                ) ||
                current >= target;

              const label =
                objective.description
                  ? String(objective.description)
                  : prettifyObjectiveKey(
                      objective.objectiveKey
                    );

              return `
                <div
                  class="world-event-objective ${
                    complete
                      ? "is-complete"
                      : ""
                  }"
                >
                  <div class="world-event-objective__top">
                    <div class="world-event-objective__name">
                      ${escapeHtml(label)}
                    </div>

                    <div class="world-event-objective__count">
                      ${current} / ${target}
                    </div>
                  </div>

                  <div class="world-event-objective__track">
                    <div
                      class="world-event-objective__fill"
                      style="width:${pct.toFixed(2)}%"
                    ></div>
                  </div>

                  ${
                    committed && complete
                      ? `
                        <div class="world-event-objective__commit">
                          Influence committed
                        </div>
                      `
                      : ""
                  }
                </div>
              `;
            })
            .join("")
        : `
            <div class="world-event-objective world-event-objective--empty">
              ${
                committed
                  ? "Your contribution has been committed."
                  : "No active objectives."
              }
            </div>
          `;

    const influence =
      Array.isArray(
        playerEvent?.influence
      )
        ? playerEvent.influence
        : [];

    const influenceHtml =
      influence.length
        ? `
          <div class="world-event-influence">
            <div class="world-event-influence__title">
              Regional Influence
            </div>

            <div class="world-event-influence__list">
              ${influence
                .map(item => `
                  <div class="world-event-influence__row">
                    <span class="world-event-influence__name">
                      ${escapeHtml(
                        item.outcomeName ||
                        "Outcome"
                      )}
                    </span>

                    <span class="world-event-influence__value">
                      ${Math.max(
                        0,
                        Number(
                          item.influence ??
                          0
                        )
                      )}
                    </span>
                  </div>
                `)
                .join("")}
            </div>
          </div>
        `
        : "";

    root.innerHTML = `
      <div class="world-event-personal">
        <div class="world-event-personal__title">
          ${
            committed
              ? "Your Path"
              : "Choose Your Path"
          }
        </div>

        ${
          committed &&
          playerEvent?.chosenOutcomeName
            ? `
              <div class="world-event-personal__chosen">
                ${escapeHtml(
                  playerEvent.chosenOutcomeName
                )}
              </div>
            `
            : ""
        }

        <div class="world-event-personal__objectives">
          ${objectiveHtml}
        </div>

        ${
          committed
            ? `
              <div class="world-event-personal__locked">
                You have chosen your path for this event.
              </div>
            `
            : ""
        }
      </div>

      ${influenceHtml}
    `;
  }

  function normalizeRewardSource(value) {
    const source = String(value || "")
      .trim()
      .toUpperCase();

    return source === "PERSONAL" ||
      source === "OUTCOME"
        ? source
        : "";
  }

  function rewardSourceLabel(source) {
    return normalizeRewardSource(source) ===
      "PERSONAL"
        ? "Personal Reward"
        : "Regional Outcome Reward";
  }

  function rewardSourceDescription(source) {
    return normalizeRewardSource(source) ===
      "PERSONAL"
        ? "Earned for completing your chosen contribution path."
        : "Earned because you participated in the event's winning regional outcome.";
  }

  function rewardTypeIcon(type) {
    switch (
      String(type || "")
        .trim()
        .toUpperCase()
    ) {
      case "GOLD":
        return "🪙";

      case "EXP":
      case "XP":
        return "✦";

      case "ITEM":
        return "🎁";

      case "REPUTATION":
        return "⚜";

      default:
        return "◆";
    }
  }

  function rewardTypeLabel(type) {
    const normalized =
      String(type || "Reward")
        .trim()
        .toUpperCase();

    if (normalized === "EXP") {
      return "XP";
    }

    return normalized
      .replaceAll("_", " ")
      .replace(/\b\w/g, c => c.toUpperCase());
  }

  function renderRewardDefinitions(rewards) {
    const list =
      Array.isArray(rewards)
        ? rewards
        : [];

    if (!list.length) {
      return `
        <div class="world-event-reward__empty">
          Reward details unavailable.
        </div>
      `;
    }

    return `
      <div class="world-event-reward__loot">
        ${list
          .map(reward => {
            const type =
              reward.rewardType ??
              reward.reward_type ??
              "REWARD";

            const amount =
              Math.max(
                0,
                Number(
                  reward.amount ??
                  0
                )
              );

            return `
              <div class="world-event-reward__loot-row">
                <span class="world-event-reward__loot-icon" aria-hidden="true">
                  ${escapeHtml(
                    rewardTypeIcon(type)
                  )}
                </span>

                <span class="world-event-reward__loot-name">
                  ${escapeHtml(
                    rewardTypeLabel(type)
                  )}
                </span>

                <strong class="world-event-reward__loot-amount">
                  +${amount}
                </strong>
              </div>
            `;
          })
          .join("")}
      </div>
    `;
  }

  function renderPendingRewards(
    bundles,
    standalone = false
  ) {
    const state =
      byId("worldEventState");

    const panel =
      byId("worldEventPanel");

    if (!state || !panel) {
      return false;
    }

    const validBundles =
      (Array.isArray(bundles)
        ? bundles
        : [])
        .map(bundle => ({
          ...bundle,
          rewards:
            (Array.isArray(bundle?.rewards)
              ? bundle.rewards
              : [])
              .filter(reward => !reward?.claimed)
        }))
        .filter(bundle =>
          bundle.rewards.length > 0
        );

    pendingRewardBundles =
      validBundles;

    if (!validBundles.length) {
      state.hidden = true;
      state.innerHTML = "";
      return false;
    }

    panel.hidden = false;
    state.hidden = false;

    if (standalone) {
      const latest =
        validBundles[0];

      const name =
        byId("worldEventName");

      const phase =
        byId("worldEventPhase");

      const description =
        byId("worldEventDescription");

      const timer =
        byId("worldEventTimer");

      const objectives =
        byId("worldEventObjectives");

      if (name) {
        name.textContent =
          latest.eventName ||
          "World Event Rewards";
      }

      if (phase) {
        phase.textContent =
          "Event Resolved";
      }

      if (description) {
        description.textContent =
          "Your contribution has been recorded. Claim the rewards you earned below.";
      }

      if (timer) {
        timer.textContent =
          "Complete";
      }

      if (objectives) {
        objectives.innerHTML = "";
      }

      panel.classList.remove(
        "world-event-panel--urgent"
      );
    }

    const cards = [];

    for (const bundle of validBundles) {
      for (const reward of bundle.rewards) {
        const source =
          normalizeRewardSource(
            reward.rewardSource ??
            reward.reward_source
          );

        const activeEventId =
          Number(
            reward.activeEventId ??
            reward.active_event_id ??
            bundle.activeEventId
          );

        const outcomeId =
          Number(
            reward.outcomeId ??
            reward.outcome_id
          );

        const canClaim =
          Number.isInteger(activeEventId) &&
          activeEventId > 0 &&
          Number.isInteger(outcomeId) &&
          outcomeId > 0 &&
          Boolean(source);

        cards.push(`
          <article
            class="world-event-reward world-event-reward--${escapeHtml(
              source.toLowerCase() ||
              "unknown"
            )}"
          >
            <div class="world-event-reward__head">
              <div>
                <div class="world-event-reward__source">
                  ${escapeHtml(
                    source
                      ? rewardSourceLabel(source)
                      : "World Event Reward"
                  )}
                </div>

                <div class="world-event-reward__outcome">
                  ${escapeHtml(
                    reward.outcomeName ??
                    reward.outcome_name ??
                    "Resolved Outcome"
                  )}
                </div>
              </div>

              <span
                class="world-event-reward__badge"
                aria-hidden="true"
              >
                ${source === "PERSONAL" ? "★" : "◆"}
              </span>
            </div>

            <div class="world-event-reward__description">
              ${escapeHtml(
                source
                  ? rewardSourceDescription(source)
                  : "A reward earned from this regional event."
              )}
            </div>

            ${renderRewardDefinitions(
              reward.rewards
            )}

            <button
              class="world-event-reward__claim"
              type="button"
              ${canClaim ? "" : "disabled"}
              onclick="GFWorldEvents.claimReward(
                ${activeEventId || 0},
                ${outcomeId || 0},
                '${escapeHtml(source)}'
              )"
            >
              ${canClaim
                ? "Claim Reward"
                : "Unavailable"}
            </button>
          </article>
        `);
      }
    }

    state.innerHTML = `
      <div class="world-event-rewards">
        <div class="world-event-rewards__title">
          Rewards Earned
        </div>

        <div class="world-event-rewards__list">
          ${cards.join("")}
        </div>
      </div>
    `;

    return true;
  }

  async function loadPendingRewards(
    regionId = currentRegionId,
    standalone = false
  ) {
    try {
      const params =
        new URLSearchParams();

      if (
        Number.isInteger(Number(regionId)) &&
        Number(regionId) > 0
      ) {
        params.set(
          "regionId",
          String(Number(regionId))
        );
      }

      const suffix =
        params.toString()
          ? `?${params.toString()}`
          : "";

      const res =
        await fetch(
          `/api/world-events/rewards/pending${suffix}`,
          {
            credentials: "include",
            cache: "no-store"
          }
        );

      const data =
        await res.json();

      if (
        !res.ok ||
        data.ok === false
      ) {
        throw new Error(
          data.error ||
          "Unable to load world event rewards."
        );
      }

      return renderPendingRewards(
        data.events || [],
        standalone
      );
    } catch (err) {
      console.warn(
        "Unable to load pending world-event rewards:",
        err
      );

      return false;
    }
  }

  async function claimReward(
    activeEventId,
    outcomeId,
    rewardSource
  ) {
    if (rewardClaimBusy) {
      return;
    }

    const eventId =
      Number(activeEventId);

    const resolvedOutcomeId =
      Number(outcomeId);

    const source =
      normalizeRewardSource(
        rewardSource
      );

    if (
      !Number.isInteger(eventId) ||
      eventId <= 0 ||
      !Number.isInteger(resolvedOutcomeId) ||
      resolvedOutcomeId <= 0 ||
      !source
    ) {
      return;
    }

    rewardClaimBusy = true;

    const buttons =
      document.querySelectorAll(
        ".world-event-reward__claim"
      );

    buttons.forEach(button => {
      button.disabled = true;
    });

    try {
      const res =
        await fetch(
          `/api/world-events/active/${eventId}/rewards/${resolvedOutcomeId}/${source}/claim`,
          {
            method: "POST",
            credentials: "include",
            cache: "no-store"
          }
        );

      const data =
        await res.json();

      if (
        !res.ok ||
        data.ok === false
      ) {
        throw new Error(
          data.error ||
          "Unable to claim world event reward."
        );
      }

      const granted =
        data.reward || {};

      const pieces = [];

      if (Number(granted.gold) > 0) {
        pieces.push(
          `${Number(granted.gold)} Gold`
        );
      }

      if (Number(granted.exp) > 0) {
        pieces.push(
          `${Number(granted.exp)} XP`
        );
      }

      if (window.GFToast?.show) {
        GFToast.show(
          source === "PERSONAL"
            ? "Personal Reward Claimed"
            : "Outcome Reward Claimed",
          pieces.length
            ? pieces.join(" • ")
            : "World event reward claimed.",
          {
            type: "success",
            durationMs: 3400
          }
        );
      }

      const stillHasRewards =
        await loadPendingRewards(
          currentRegionId,
          !currentEvent
        );

      /*
       * If there is no active event and the final pending reward was just
       * claimed, the regional-event card can disappear normally.
       */
      if (
        !currentEvent &&
        !stillHasRewards
      ) {
        hidePanel();
      }

    } catch (err) {
      console.error(
        "World event reward claim failed:",
        err
      );

      if (window.GFToast?.show) {
        GFToast.show(
          "Reward Claim Failed",
          err?.message ||
          "Unable to claim the reward.",
          {
            type: "error",
            durationMs: 3000
          }
        );
      }
    } finally {
      rewardClaimBusy = false;

      document
        .querySelectorAll(
          ".world-event-reward__claim"
        )
        .forEach(button => {
          button.disabled = false;
        });
    }
  }

  function renderEvent(
    event,
    playerEvent = null
  ) {
    const panel =
      byId("worldEventPanel");

    if (!panel || !event) {
      hidePanel();
      return;
    }

    currentEvent = event;
    currentPlayerEvent =
      playerEvent;

    panel.hidden = false;

    panel.classList.toggle(
      "world-event-panel--phase-two",
      Number(
        event.phaseNumber ?? 1
      ) >= 2
    );

    const name =
      byId("worldEventName");

    const phase =
      byId("worldEventPhase");

    const description =
      byId("worldEventDescription");

    const state =
      byId("worldEventState");

    if (name) {
      name.textContent =
        event.eventName ||
        "World Event";
    }

    if (phase) {
      const phaseNumber =
        Number(
          event.phaseNumber ??
          1
        );

      phase.textContent =
        `Phase ${phaseNumber} • ${
          event.phaseName ||
          "Active"
        }`;
    }

    if (description) {
      description.textContent =
        event.phaseDescription ||
        event.eventDescription ||
        "";
    }

    if (state) {
      state.hidden = true;
      state.textContent = "";
    }

    renderObjectives(
      playerEvent?.objectives ??
      event.objectives,
      playerEvent
    );

    startTimer();

    /*
     * A player can still have an unclaimed reward from a previous resolved
     * event while a new regional event is active. Keep it visible here.
     */
    void loadPendingRewards(
      currentRegionId,
      false
    );
  }

  async function loadRegionEvent(
    regionId,
    force = false
  ) {
    const parsed =
      Number(regionId);

    if (
      !Number.isInteger(parsed) ||
      parsed <= 0
    ) {
      currentRegionId = null;
      lastLoadedRegionId = null;
      hidePanel();
      return null;
    }

    currentRegionId = parsed;

    if (
      !force &&
      lastLoadedRegionId === parsed &&
      currentEvent
    ) {
      return currentEvent;
    }

    try {
      const res =
        await fetch(
          `/api/world-events/region/${parsed}`,
          {
            credentials: "include",
            cache: "no-store"
          }
        );

      const data =
        await res.json();

      lastLoadedRegionId =
        parsed;

      if (
        !res.ok ||
        data.ok === false
      ) {
        hidePanel();
        return null;
      }

      if (!data.event) {
        stopTimer();
        currentEvent = null;
        currentPlayerEvent = null;

        const hasRewards =
          await loadPendingRewards(
            parsed,
            true
          );

        if (!hasRewards) {
          hidePanel();
        }

        return null;
      }

      renderEvent(
        data.event,
        data.playerEvent ?? null
      );

      return data.event;

    } catch (err) {
      console.warn(
        "Unable to load regional world event:",
        err
      );

      hidePanel();
      return null;
    }
  }

  async function syncFromCurrentRegion() {
    try {
      const res =
        await fetch(
          "/world/current-region",
          {
            credentials: "include",
            cache: "no-store"
          }
        );

      const data =
        await res.json();

      if (
        !res.ok ||
        data?.region_id == null
      ) {
        hidePanel();
        return null;
      }

      return loadRegionEvent(
        Number(data.region_id),
        true
      );

    } catch (err) {
      console.warn(
        "Unable to determine current world-event region:",
        err
      );

      hidePanel();
      return null;
    }
  }

  async function setRegion(regionId) {
    return loadRegionEvent(
      regionId,
      true
    );
  }

  function refresh() {
    if (
      currentRegionId == null
    ) {
      return Promise.resolve(null);
    }

    return loadRegionEvent(
      currentRegionId,
      true
    );
  }

  window.GFWorldEvents = {
    setRegion,
    refresh,
    syncFromCurrentRegion,
    loadPendingRewards,
    claimReward
  };
})();
