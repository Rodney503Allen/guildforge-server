// rest.routes.ts
import express from "express";
import { db } from "./db";
import { getFinalPlayerStats } from "./services/playerService";
import {
  getActiveConsumableBuffs,
  getRestConsumables,
  useRestConsumable,
} from "./services/consumableService";

const router = express.Router();

const CAMPFIRE_DURATION = 5 * 60 * 1000;
const REST_TICK_MS = 10 * 1000;

const BASE_REST_PERCENT = 0.05;
const CAMPFIRE_REST_PERCENT = 0.10;

function requireLogin(req: any, res: any, next: any) {
  if (!req.session || !req.session.playerId) return res.redirect("/login.html");
  next();
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function titleCase(value: unknown) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatDuration(seconds: number) {
  const safeSeconds = Math.max(0, Math.ceil(Number(seconds) || 0));

  if (safeSeconds < 60) return `${safeSeconds}s`;

  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = safeSeconds % 60;

  if (remainingSeconds === 0) return `${minutes}m`;
  return `${minutes}m ${remainingSeconds}s`;
}

function formatEffect(effect: any) {
  const amount = Number(effect.effect_value) || 0;
  const duration = Number(effect.duration_seconds) || 0;

  if (effect.effect_type === "heal") {
    return `Restores ${amount} Health`;
  }

  if (effect.effect_type === "restore_sp") {
    return `Restores ${amount} Spirit`;
  }

  if (effect.effect_type === "buff") {
    const stat = titleCase(effect.stat_key || "buff");
    const signed = amount > 0 ? `+${amount}` : `${amount}`;
    const durationText = duration > 0 ? ` for ${formatDuration(duration)}` : "";
    return `${signed} ${stat}${durationText}`;
  }

  return "Provides an alchemical effect";
}

function renderConsumables(consumables: any[], disabled: boolean) {
  if (!consumables.length) {
    return `
      <div class="rest-empty-state">
        <div class="rest-empty-icon">🧪</div>
        <div>
          <strong>No usable consumables</strong>
          <p>Craft or acquire potions, tonics, draughts, elixirs, flasks, and oils to use them while resting.</p>
        </div>
      </div>
    `;
  }

  return consumables
    .map((item) => {
      const effectLines = item.effects?.length
        ? item.effects.map((effect: any) => formatEffect(effect))
        : ["Restores resources immediately"];

      const family = titleCase(item.family || "consumable");

      return `
        <article class="consumable-row" data-rest-item-id="${Number(item.itemId)}">
          <div class="consumable-icon">
            ${
              item.icon
                ? `<img src="${escapeHtml(item.icon)}" alt="${escapeHtml(item.name)}">`
                : `<span>🧪</span>`
            }
          </div>

          <div class="consumable-info">
            <div class="consumable-title-row">
              <h3>${escapeHtml(item.name)}</h3>
              <span class="consumable-type">${escapeHtml(family)}</span>
            </div>

            <p>${escapeHtml(item.description || "An alchemical preparation.")}</p>

            <div class="consumable-effects">
              ${effectLines
                .map((line: string) => `<span>${escapeHtml(line)}</span>`)
                .join("")}
            </div>
          </div>

          <div class="consumable-actions">
            <span class="consumable-qty">x${Number(item.quantity)}</span>
            <button
              class="rest-btn primary"
              type="button"
              onclick="useRestConsumable(${Number(item.itemId)}, this)"
              ${disabled ? "disabled" : ""}
            >
              Use
            </button>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderActiveEffects(buffs: any[]) {
  if (!buffs.length) {
    return `
      <div class="active-effect-empty">
        No active alchemical preparations.
      </div>
    `;
  }

  return buffs
    .map((buff) => {
      const expires = new Date(buff.expires_at).getTime();
      const remaining = Math.max(0, Math.ceil((expires - Date.now()) / 1000));
      const value = Number(buff.value) || 0;
      const signed = value > 0 ? `+${value}` : `${value}`;
      const label = titleCase(buff.stat);

      return `
        <div class="active-effect-row">
          <div>
            <strong>${escapeHtml(label)}</strong>
            <span>${escapeHtml(`${signed} ${label}`)}</span>
          </div>
          <span class="active-effect-time" data-effect-seconds="${remaining}">${formatDuration(remaining)}</span>
        </div>
      `;
    })
    .join("");
}

async function hasActiveCreature(playerId: number) {
  const [[row]]: any = await db.query(
    `SELECT id FROM player_creatures WHERE player_id=? LIMIT 1`,
    [playerId]
  );

  return !!row;
}

async function ensureRestSession(playerId: number) {
  const now = Date.now();

  await db.query(
    `
    INSERT IGNORE INTO player_rest
      (player_id, started_at, campfire_expires_at, last_tick_at, state)
    VALUES (?, ?, 0, ?, 'resting')
    `,
    [playerId, now, now]
  );
}

async function applyRestTicks(playerId: number) {
  const [[camp]]: any = await db.query(
    `SELECT * FROM player_rest WHERE player_id=? LIMIT 1`,
    [playerId]
  );

  if (!camp) return null;

  const now = Date.now();

  const stats = await getFinalPlayerStats(playerId);
  if (!stats) return camp;

  const hasCampfire = Number(camp.campfire_expires_at || 0) > now;
  const restorePercent = hasCampfire ? CAMPFIRE_REST_PERCENT : BASE_REST_PERCENT;

  const ticks = Math.floor((now - Number(camp.last_tick_at)) / REST_TICK_MS);
  if (ticks <= 0) return camp;

  const hpGain = Math.max(1, Math.floor(stats.maxhp * restorePercent)) * ticks;
  const spGain = Math.max(1, Math.floor(stats.maxspoints * restorePercent)) * ticks;

  await db.query(
    `
    UPDATE players
    SET hpoints = LEAST(hpoints + ?, ?),
        spoints = LEAST(spoints + ?, ?)
    WHERE id=?
      AND hpoints > 0
    `,
    [hpGain, stats.maxhp, spGain, stats.maxspoints, playerId]
  );

  const newLastTick = Number(camp.last_tick_at) + ticks * REST_TICK_MS;

  await db.query(
    `UPDATE player_rest SET last_tick_at=? WHERE player_id=?`,
    [newLastTick, playerId]
  );

  return {
    ...camp,
    last_tick_at: newLastTick,
  };
}

async function renderRestContent(pid: number, isModal = false) {
  const inCombat = await hasActiveCreature(pid);

  if (!inCombat) {
    await ensureRestSession(pid);
    await applyRestTicks(pid);
  }

  const [[player]]: any = await db.query(
    `
    SELECT id, name, level, hpoints, spoints, gold
    FROM players
    WHERE id=?
    LIMIT 1
    `,
    [pid]
  );

  if (!player) return null;

  const [[camp]]: any = await db.query(
    `SELECT * FROM player_rest WHERE player_id=? LIMIT 1`,
    [pid]
  );

  const consumables = await getRestConsumables(pid);
  const activeConsumableBuffs = await getActiveConsumableBuffs(pid);

  const now = Date.now();
  const hasCampfire = camp && Number(camp.campfire_expires_at || 0) > now;
  const campfireSeconds = hasCampfire
    ? Math.max(0, Math.ceil((Number(camp.campfire_expires_at) - now) / 1000))
    : 0;

  const isDead = Number(player.hpoints) <= 0;
  const consumablesDisabled = inCombat || isDead;

  return `
    <section class="rest-panel" data-rest-active="true">
      <div class="rest-hero">
        <div>
          <div class="rest-kicker">Wilderness Camp</div>
          <h1>Rest & Camp</h1>
          <p>Light a fire, recover your strength, and prepare for the road ahead.</p>
        </div>

        ${
          isModal
            ? `<button class="rest-btn ghost" onclick="closeRestModal()">Close</button>`
            : `<a class="rest-btn ghost" href="/world">Return to World</a>`
        }
      </div>

      <div class="rest-grid">
        <section class="rest-scene">
          <div class="scene-overlay">
            <div class="camp-status ${hasCampfire ? "good" : "bad"}">
              ${hasCampfire ? "🔥 Campfire Active" : "🔥 No Campfire"}
            </div>
            <p>
              ${
                hasCampfire
                  ? `Fire expires in <span data-campfire-seconds="${campfireSeconds}">${campfireSeconds}</span>. Recovery increased to 10% every 10 seconds.`
                  : `Base recovery active: 5% Health and Spirit every 10 seconds.`
              }
            </p>
          </div>
        </section>

        <section class="rest-actions">
          <div class="rest-card">
            <div>
              <h2>Campfire</h2>
              <p>Double your recovery rate while resting in the wilderness.</p>
              ${
                inCombat
                  ? `<span class="warn">You cannot start a fire in combat.</span>`
                  : isDead
                    ? `<span class="warn">You cannot start a fire while dead.</span>`
                    : hasCampfire
                      ? `<span class="good-text">Campfire recovery active.</span>`
                      : `<span class="warn">No campfire active.</span>`
              }
            </div>

            <button
              class="rest-btn primary"
              onclick="startCampfire(event)"
              ${inCombat || isDead ? "disabled" : ""}
            >
              ${hasCampfire ? "Refresh Fire" : "Start Fire"}
            </button>
          </div>

          <div class="rest-card">
            <div>
              <h2>Resting</h2>
              <p>
                Resting begins automatically when you open this page.
                Without a campfire, you recover 5% Health and Spirit every 10 seconds.
                With a campfire, you recover 10% every 10 seconds.
              </p>
              ${
                isDead
                  ? `<span class="warn">You cannot rest while dead.</span>`
                  : inCombat
                    ? `<span class="warn">You cannot rest in combat.</span>`
                    : hasCampfire
                      ? `<span class="good-text">Enhanced rest active: 10% every 10 seconds.</span>`
                      : `<span class="good-text">Base rest active: 5% every 10 seconds.</span>`
              }
            </div>
          </div>

          <div class="rest-card consumables-card">
            <div class="rest-card-heading">
              <div>
                <h2>Consumables</h2>
                <p>Use potions and alchemical preparations before returning to the road.</p>
              </div>
              <div class="rest-card-icon">🧪</div>
            </div>

            ${
              consumablesDisabled
                ? `<span class="warn">Consumables cannot be used while ${isDead ? "dead" : "in combat"}.</span>`
                : ""
            }

            <div class="consumable-list">
              ${renderConsumables(consumables, consumablesDisabled)}
            </div>
          </div>

          <div class="rest-card active-effects-card">
            <div class="rest-card-heading">
              <div>
                <h2>Active Preparations</h2>
                <p>Timed alchemical effects currently affecting your character.</p>
              </div>
              <div class="rest-card-icon">✨</div>
            </div>

            <div class="active-effect-list">
              ${renderActiveEffects(activeConsumableBuffs)}
            </div>
          </div>

          <div class="activity-grid">
            <div class="activity-card locked">
              <div class="activity-icon">🍖</div>
              <h3>Cook</h3>
              <p>Prepare meals at your campfire.</p>
              <span>Coming Soon</span>
            </div>

            <div class="activity-card locked">
              <div class="activity-icon">🛠️</div>
              <h3>Craft</h3>
              <p>Create basic survival tools and supplies.</p>
              <span>Coming Soon</span>
            </div>
          </div>
        </section>
      </div>
    </section>
  `;
}

router.get("/", requireLogin, async (req, res) => {
  const pid = Number((req.session as any).playerId);
  const content = await renderRestContent(pid, false);

  if (!content) return res.redirect("/login.html");

  res.send(`
<!doctype html>
<html>
<head>
  <title>Guildforge | Rest</title>
  <link rel="stylesheet" href="/statpanel.css">
  <link rel="stylesheet" href="/rest.css">
  <script defer src="/statpanel.js"></script>
  <script defer src="/rest.js"></script>
</head>
<body>
  <div id="statpanel-root"></div>

  <main class="rest-wrap">
    ${content}
  </main>

  <script>
    window.useRestConsumable = async function(itemId, button) {
      if (button) button.disabled = true;

      try {
        const response = await fetch('/rest/use-consumable', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ itemId })
        });

        const data = await response.json();
        if (!response.ok || !data.success) {
          throw new Error(data.error || 'Could not use consumable.');
        }

        if (window.showToast) {
          window.showToast(data.message || 'Consumable used.');
        }

        window.location.reload();
      } catch (error) {
        if (button) button.disabled = false;
        const message = error && error.message ? error.message : 'Could not use consumable.';
        if (window.showToast) window.showToast(message, 'error');
        else alert(message);
      }
    };
  </script>
</body>
</html>
  `);
});

router.get("/modal", requireLogin, async (req, res) => {
  const pid = Number((req.session as any).playerId);
  const content = await renderRestContent(pid, true);

  if (!content) return res.status(401).send("");

  res.send(`
    <div id="restModal" class="rest-modal-shell">
      <div class="rest-modal-backdrop" onclick="closeRestModal()"></div>
      <div class="rest-modal-content">
        ${content}
      </div>
    </div>

    <script>
      window.useRestConsumable = async function(itemId, button) {
        if (button) button.disabled = true;

        try {
          const response = await fetch('/rest/use-consumable', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ itemId })
          });

          const data = await response.json();
          if (!response.ok || !data.success) {
            throw new Error(data.error || 'Could not use consumable.');
          }

          if (window.showToast) {
            window.showToast(data.message || 'Consumable used.');
          }

          if (typeof closeRestModal === 'function') closeRestModal();
          if (typeof openRest === 'function') await openRest();
        } catch (error) {
          if (button) button.disabled = false;
          const message = error && error.message ? error.message : 'Could not use consumable.';
          if (window.showToast) window.showToast(message, 'error');
          else alert(message);
        }
      };
    </script>
  `);
});

router.post("/use-consumable", requireLogin, async (req, res) => {
  const pid = Number((req.session as any).playerId);
  const itemId = Number(req.body?.itemId);

  try {
    const result = await useRestConsumable(pid, itemId);

    const parts: string[] = [];
    if (result.healed > 0) parts.push(`restored ${result.healed} Health`);
    if (result.restoredSp > 0) parts.push(`restored ${result.restoredSp} Spirit`);
    if (result.appliedBuffs.length > 0) parts.push("applied its preparation effect");

    return res.json({
      success: true,
      message: `${result.itemName} ${parts.length ? parts.join(" and ") : "used"}.`,
      result,
    });
  } catch (error: any) {
    console.error("Rest consumable use failed:", error);

    return res.status(400).json({
      success: false,
      error: error?.message || "Could not use consumable.",
    });
  }
});

router.get("/tick", requireLogin, async (req, res) => {
  const pid = Number((req.session as any).playerId);

  if (!(await hasActiveCreature(pid))) {
    await ensureRestSession(pid);
    await applyRestTicks(pid);
  }

  const [[player]]: any = await db.query(
    `SELECT hpoints, spoints FROM players WHERE id=? LIMIT 1`,
    [pid]
  );

  const stats = await getFinalPlayerStats(pid);

  res.json({
    success: true,
    hpoints: Number(player?.hpoints || 0),
    spoints: Number(player?.spoints || 0),
    maxhp: Number(stats?.maxhp || 0),
    maxspoints: Number(stats?.maxspoints || 0),
  });
});

router.post("/start-fire", requireLogin, async (req, res) => {
  const pid = Number((req.session as any).playerId);

  if (await hasActiveCreature(pid)) return res.redirect("/rest");

  const [[player]]: any = await db.query(
    `SELECT hpoints FROM players WHERE id=? LIMIT 1`,
    [pid]
  );

  if (!player || Number(player.hpoints) <= 0) return res.redirect("/rest");

  await ensureRestSession(pid);
  await applyRestTicks(pid);

  const now = Date.now();
  const expires = now + CAMPFIRE_DURATION;

  await db.query(
    `
    UPDATE player_rest
    SET campfire_expires_at=?,
        state='resting'
    WHERE player_id=?
    `,
    [expires, pid]
  );

  res.json({ success: true });
});

router.post("/leave", requireLogin, async (req, res) => {
  const pid = Number((req.session as any).playerId);

  await applyRestTicks(pid);
  await db.query(`DELETE FROM player_rest WHERE player_id=?`, [pid]);

  res.redirect("/world");
});

router.post("/stop", requireLogin, async (req, res) => {
  const pid = Number((req.session as any).playerId);

  await applyRestTicks(pid);
  await db.query(`DELETE FROM player_rest WHERE player_id=?`, [pid]);

  res.json({ success: true });
});

export default router;
