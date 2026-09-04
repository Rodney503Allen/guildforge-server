// src/dungeonPage.routes.ts
import express from "express";

const router =
  express.Router();

router.get(
  "/dungeon",
  (req: any, res) => {
    const playerId =
      Number(
        req.session?.playerId
      );

    if (
      !Number.isInteger(
        playerId
      ) ||
      playerId <= 0
    ) {
      return res.redirect(
        "/login.html"
      );
    }

    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1"
  />

  <link
    rel="preconnect"
    href="https://fonts.googleapis.com"
  >
  <link
    rel="preconnect"
    href="https://fonts.gstatic.com"
    crossorigin
  >
  <link
    href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700;800&display=swap"
    rel="stylesheet"
  >

  <title>Guildforge | Dungeon</title>

  <link
    rel="stylesheet"
    href="/ui/itemTooltip.css"
  >

  <link
    rel="stylesheet"
    href="/dungeon.css"
  >
</head>

<body>
  <main class="dungeon-shell frame-host">
    <span class="frame-border main" aria-hidden="true"></span>

    <header class="dungeon-header">
      <div>
        <div class="dungeon-kicker">
          Dungeon Expedition
        </div>

        <h1 id="dungeonTitle">
          Dungeon
        </h1>

        <div
          id="dungeonSubtitle"
          class="dungeon-subtitle"
        >
          Preparing expedition...
        </div>
      </div>

      <div class="dungeon-header-actions">
        <div
          id="dungeonPhaseBadge"
          class="dungeon-phase-badge"
        >
          Loading
        </div>

        <button
          id="dungeonLeaveBtn"
          class="dungeon-btn dungeon-btn--ghost button-frame"
          type="button"
        >
          Abandon Dungeon
        </button>
      </div>
    </header>

    <section class="dungeon-progress-card frame-host">
      <span class="frame-border panel" aria-hidden="true"></span>
      <div class="dungeon-progress-copy">
        <div class="dungeon-section-label">
          Expedition Progress
        </div>

        <div
          id="dungeonRoomTitle"
          class="dungeon-room-title"
        >
          Room —
        </div>

        <div
          id="dungeonWaveText"
          class="dungeon-wave-text"
        >
          Wave —
        </div>
      </div>

      <div
        id="dungeonRoomSteps"
        class="dungeon-room-steps"
        aria-label="Dungeon rooms"
      >
      </div>
    </section>

    <section
      id="dungeonEnemyCast"
      class="dungeon-cast-warning frame-host hidden"
      aria-live="assertive"
    >
      <span class="frame-border panel" aria-hidden="true"></span>
      <div class="dungeon-cast-warning__icon">
        ⚠
      </div>

      <div class="dungeon-cast-warning__body">
        <div class="dungeon-cast-warning__eyebrow">
          Enemy Ability Incoming
        </div>

        <div class="dungeon-cast-warning__top">
          <strong
            id="dungeonCastName"
          >
            Incoming Attack
          </strong>

          <span
            id="dungeonCastTime"
          >
            0.0s
          </span>
        </div>

        <div class="dungeon-cast-track">
          <div
            id="dungeonCastBar"
            class="dungeon-cast-fill"
          ></div>
        </div>

        <div class="dungeon-cast-warning__bottom">
          <span
            id="dungeonCastTargets"
          >
            Prepare to react
          </span>

          <span
            id="dungeonCastInterrupt"
            class="dungeon-cast-interrupt"
          >
            Interruptible
          </span>
        </div>
      </div>
    </section>

    <div class="dungeon-layout">

      <section class="dungeon-panel dungeon-enemy-panel frame-host">\n        <span class="frame-border panel" aria-hidden="true"></span>
        <div class="dungeon-panel-header">
          <div class="dungeon-section-label">
            Current Enemy
          </div>

          <div
            id="dungeonEnemyMeta"
            class="dungeon-panel-meta"
          >
            Level —
          </div>
        </div>

        <div class="dungeon-enemy-main">
          <div class="dungeon-enemy-portrait-wrap">
            <img
              id="dungeonEnemyPortrait"
              class="dungeon-enemy-portrait"
              src="/images/default_creature.png"
              alt=""
            >
          </div>

          <div class="dungeon-enemy-copy">
            <h2 id="dungeonEnemyName">
              Awaiting Enemy
            </h2>

            <p id="dungeonEnemyDescription">
            </p>
          </div>
        </div>

        <div class="dungeon-meter-group">
          <div class="dungeon-meter-row">
            <div class="dungeon-meter-label">
              <span>Health</span>
              <span id="dungeonEnemyHpText">
                0 / 0
              </span>
            </div>

            <div class="dungeon-meter">
              <div
                id="dungeonEnemyHpBar"
                class="dungeon-meter-fill dungeon-meter-fill--hp"
              ></div>
            </div>
          </div>

          <div class="dungeon-meter-row">
            <div class="dungeon-meter-label">
              <span>Action Timer</span>
              <span id="dungeonEnemyAtbText">
                0%
              </span>
            </div>

            <div class="dungeon-meter">
              <div
                id="dungeonEnemyAtbBar"
                class="dungeon-meter-fill dungeon-meter-fill--atb"
              ></div>
            </div>
          </div>
        </div>
      </section>

      <section class="dungeon-panel dungeon-party-panel frame-host">\n        <span class="frame-border panel" aria-hidden="true"></span>
        <div class="dungeon-panel-header">
          <div class="dungeon-section-label">
            Adventuring Company
          </div>
        </div>

        <div
          id="dungeonPartyList"
          class="dungeon-party-list"
        >
          <div class="dungeon-loading">
            Gathering party...
          </div>
        </div>
      </section>

      <section class="dungeon-panel dungeon-log-panel frame-host">\n        <span class="frame-border panel" aria-hidden="true"></span>
        <div class="dungeon-panel-header">
          <div class="dungeon-section-label">
            Encounter
          </div>
        </div>

        <div
          id="dungeonCombatLog"
          class="dungeon-combat-log"
        >
          <div>
            The expedition prepares to move.
          </div>
        </div>
      </section>

      <section class="dungeon-panel dungeon-action-panel frame-host">\n        <span class="frame-border panel" aria-hidden="true"></span>
        <div class="dungeon-panel-header">
          <div>
            <div class="dungeon-section-label">
              Your Actions
            </div>

            <div
              id="dungeonActionStatus"
              class="dungeon-action-status"
            >
              Preparing...
            </div>
          </div>
        </div>

        <div
          id="dungeonSpellHotbar"
          class="dungeon-spell-hotbar"
        >
          <div class="dungeon-loading">
            Loading abilities...
          </div>
        </div>

        <div
          id="dungeonTargetPrompt"
          class="dungeon-target-prompt hidden"
        >
          <span>
            Choose a party member.
          </span>

          <button
            id="dungeonCancelTargetBtn"
            class="dungeon-btn dungeon-btn--ghost button-frame"
            type="button"
          >
            Cancel
          </button>
        </div>
      </section>

      <section
        id="dungeonPhasePanel"
        class="dungeon-panel dungeon-phase-panel frame-host hidden"
      >
        <span class="frame-border panel" aria-hidden="true"></span>
      </section>

    </div>

  </main>

  <script>
    window.__PLAYER_ID__ =
      ${playerId};
  </script>

  <script
    src="/ui/itemTooltip.js"
    defer
  ></script>

  <script
    src="/dungeon.js"
    defer
  ></script>
</body>
</html>
    `);
  },
);

export default router;
