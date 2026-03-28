import { Router } from "express";
import { db } from "./db";

const router = Router();
// =======================
// GUILD PERMISSIONS BITMASK
// =======================
export const PERMS = {
  INVITE: 1,              // 0000001
  KICK: 2,                // 0000010
  SPEND_PERK_POINTS: 4,   // 0000100
  MANAGE_ROLES: 8,        // 0001000
  ACCESS_VAULT: 16,       // 0010000
  ACTIVATE_EVENTS: 32,    // 0100000
  ADMIN_GUILD: 64         // 1000000 (Guild Master)
} as const;

/* =======================
   LOGIN REQUIRED
======================= */
function requireLogin(req:any,res:any,next:any) {
  if (!req.session || !req.session.playerId) {
    return res.redirect("/login.html");
  }
  next();
}
function hasPerm(mask: number, perm: number): boolean {
  return (mask & perm) === perm;
}

function higherRank(a: number, b: number): boolean {
  return a > b;
}
async function loadMyGuildMember(pid: number) {
  const [[row]]: any = await db.execute(`
    SELECT 
      gm.id AS member_id,
      gm.player_id,
      gm.guild_id,
      gm.role_id,
      gm.contribution,
      gr.name AS role_name,
      gr.permissions,
      gr.rank_order,
      g.owner_id
    FROM guild_members gm
    JOIN guild_roles gr ON gr.id = gm.role_id
    JOIN guilds g ON g.id = gm.guild_id
    WHERE gm.player_id=?
  `, [pid]);

  return row;
}
function esc(input: any) {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmt(n: any) {
  return new Intl.NumberFormat("en-US").format(Number(n || 0));
}

function fmtDate(d: any) {
  try { return new Date(d).toLocaleString(); } catch { return ""; }
}

/* ============================================================================================
   GUILD DASHBOARD
============================================================================================ */
function renderPerk(perk: any, currentLevel: number) {
  return `
    <form method="POST" action="/guild/perks/upgrade" class="perk-row">

      <div class="perk-info">
        <strong>${perk.name}</strong><br>
        <span class="perk-desc">${perk.description}</span>
      </div>

      <input type="hidden" name="perk_id" value="${perk.id}">

      <button 
        class="perk-upgrade-btn"
        ${currentLevel >= perk.max_level ? "disabled" : ""}
      >
        Upgrade (${currentLevel}/${perk.max_level})
      </button>

    </form>
  `;
}
function formatActivity(a: any) {
  switch (a.action) {
    case "ROLE_CHANGE":
      return `changed ${a.target_name}'s role (${a.details})`;
    case "KICK":
      return `kicked ${a.target_name}`;
    case "JOIN":
      return `joined the guild`;
    case "LEAVE":
      return `left the guild`;
    case "DONATION":
      return `donated ${a.details}`;
    case "LEVEL_UP":
      return a.details;
    case "ANNOUNCEMENT":
      return a.details;
    default:
      return a.details || a.action;
  }
}

async function logGuildActivity(
  guildId: number,
  actorId: number | null,
  targetId: number | null,
  action: string,
  details?: string
) {
  await db.execute(`
    INSERT INTO guild_activity
      (guild_id, actor_player_id, target_player_id, action, details)
    VALUES (?, ?, ?, ?, ?)
  `, [guildId, actorId, targetId, action, details || null]);
}

interface PerkDefinition {
  id: number;
  name: string;
  description: string;
  category: string;     // "combat" | "economy" | "utility"
  max_level: number;
}

router.get("/guild", requireLogin, async (req,res)=>{

  const pid = (req.session as any).playerId;

  // Load player (needed for gold display)
  const [[player]]: any = await db.execute(
    "SELECT gold FROM players WHERE id=?",
    [pid]
  );

  // Check membership
const member = await loadMyGuildMember(pid);


  // NOT IN GUILD
  if (!member) {

    const [inviteRows] = await db.execute(`
      SELECT gi.id, g.name AS guild_name, p.name AS inviter
      FROM guild_invites gi
      JOIN guilds g ON g.id = gi.guild_id
      JOIN players p ON p.id = gi.inviter_id
      WHERE gi.invitee_id=?
      ORDER BY gi.created_at DESC
    `,[pid]) as any;


res.send(`
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&display=swap" rel="stylesheet">
  <title>Guildforge | Guild</title>

  <link rel="stylesheet" href="/statpanel.css">
  <script defer src="/statpanel.js"></script>

  <link rel="stylesheet" href="/guild.css">
</head>

<body>
  <div id="statpanel-root"></div>

  <div class="wrap">
    <div class="topbar">
      <div class="brand">
        <div class="title"><span class="sigil"></span> Guild</div>
        <div class="sub">You are not currently in a guild.</div>
      </div>
      <div class="nav">
        <a class="btn" href="/town">Return to Town</a>
      </div>
    </div>

    <div class="grid" style="grid-template-columns: 1fr;">
      <section class="card">
        <div class="cardHeader">
          <div class="cardTitle">
            <h2>Guild Invitations</h2>
            <p>Accept an invite or create your own guild.</p>
          </div>
          <span class="badge">Invites</span>
        </div>

        <div class="cardBody">

          ${
            inviteRows.length
              ? `
                <table class="table">
                  <tr>
                    <th>Guild</th>
                    <th>Inviter</th>
                    <th style="width:220px;">Action</th>
                  </tr>
                  ${inviteRows.map((i:any)=>`
                    <tr>
                      <td>${esc(i.guild_name)}</td>
                      <td>${esc(i.inviter)}</td>
                      <td style="display:flex; gap:8px; flex-wrap:wrap;">
                        <a class="btn primary" href="/guild/accept/${Number(i.id)}">Accept</a>
                        <a class="btn" href="/guild/decline/${Number(i.id)}">Decline</a>
                      </td>
                    </tr>
                  `).join("")}
                </table>
              `
              : `<div style="color:var(--muted); padding:10px 0;">No invitations.</div>`
          }

          <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:14px;">
            <a class="btn primary" href="/guild/create">Create Guild</a>
            <a class="btn" href="/town">Return to Town</a>
          </div>

        </div>
      </section>
    </div>
  </div>
</body>
</html>
`);
return;

  }
const [[guild]]: any = await db.execute(`
  SELECT
    name,
    level,
    experience,
    gold,
    description,
    perk_points,
    announcement,
    announcement_updated_at,
    announcement_updated_by
  FROM guilds
  WHERE id=?
`, [member.guild_id]);

  // LOAD MEMBERS
  const [roles] = await db.execute(`
  SELECT id, name, rank_order
  FROM guild_roles
  WHERE guild_id=?
  ORDER BY rank_order DESC
`, [member.guild_id]) as any;
  const [members] = await db.execute(`
    SELECT 
      gm.player_id,
      p.name,
      gr.name AS role_name,
      gr.rank_order,
      gm.joined_at,
      gm.contribution
    FROM guild_members gm
    JOIN players p ON p.id = gm.player_id
    JOIN guild_roles gr ON gr.id = gm.role_id
    WHERE gm.guild_id=?
    ORDER BY gr.rank_order DESC, gm.contribution DESC


  `,[member.guild_id]) as any;

  // GUILD DASHBOARD
  // Load all perk definitions
const [perkDefs] = await db.execute(`
  SELECT * FROM perk_definitions ORDER BY category, id
`) as any;

// Load guild perk levels
const [perkLevelsRows] = await db.execute(`
  SELECT perk_id, level 
  FROM guild_perks
  WHERE guild_id=?
`, [member.guild_id]) as any;
const [activityRows] = await db.execute(`
  SELECT 
    ga.action,
    ga.details,
    ga.created_at,
    ap.name AS actor_name,
    tp.name AS target_name
  FROM guild_activity ga
  LEFT JOIN players ap ON ap.id = ga.actor_player_id
  LEFT JOIN players tp ON tp.id = ga.target_player_id
  WHERE ga.guild_id=?
  ORDER BY ga.created_at DESC
  LIMIT 20
`, [member.guild_id]) as any;

// Convert to lookup map
const perkLevels: Record<number, number> = {};
perkLevelsRows.forEach((p: any) => perkLevels[p.perk_id] = p.level);

const xpNeed = guildXpNeeded(guild.level);
const xpPct = xpNeed > 0 ? Math.max(0, Math.min(100, (guild.experience / xpNeed) * 100)) : 0;

const canEditAnnouncement = hasPerm(member.permissions, PERMS.MANAGE_ROLES);
const canInvite = hasPerm(member.permissions, PERMS.INVITE);
const canDelete = hasPerm(member.permissions, PERMS.ADMIN_GUILD);

res.send(`
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&display=swap" rel="stylesheet">
  <title>Guildforge | ${esc(guild.name)} — Guild</title>

  <link rel="stylesheet" href="/statpanel.css">
  <script defer src="/statpanel.js"></script>

  <link rel="stylesheet" href="/guild.css">
  <script defer src="/guild.js"></script>
</head>

<body>
  <div id="statpanel-root"></div>

  <div class="wrap">

    <div class="topbar">
      <div class="brand">
        <div class="title"><span class="sigil"></span> ${esc(guild.name)}</div>
        <div class="sub">${esc(guild.description || "No guild description set.")}</div>
      </div>

      <div class="nav">
        <span class="pill">Role: <strong>${esc(member.role_name)}</strong></span>
        <span class="pill">Guild Gold: <strong>${fmt(guild.gold)}g</strong></span>
        <a class="btn danger" href="/town">Return to Town</a>
      </div>
    </div>

    <div class="grid">

      <!-- LEFT: MAIN -->
      <section class="card">
        <div class="cardHeader">
          <div class="cardTitle">
            <h2>Guild Dashboard</h2>
            <p>Progress, announcements, and the roster.</p>
          </div>
          <span class="badge good">Active</span>
        </div>

        <div class="cardBody">

          <div class="guildMeta">
            <div class="metaBox">
              <div class="metaK">Guild Level</div>
              <div class="metaV">Level ${fmt(guild.level)}</div>
            </div>

            <div class="metaBox">
              <div class="metaK">Experience</div>
              <div class="metaV">${fmt(guild.experience)} / ${fmt(xpNeed)}</div>
              <div class="xpBar"><div class="xpFill" style="width:${xpPct}%"></div></div>
            </div>

            <div class="metaBox">
              <div class="metaK">Perk Points</div>
              <div class="metaV">${fmt(guild.perk_points)}</div>
            </div>
          </div>

          <div class="announce">
            <div class="announceHead">
              <div style="font-weight:900; letter-spacing:.4px;">📣 Guild Announcement</div>
              ${canEditAnnouncement ? `<button id="edit-announcement" class="smallBtn">Edit</button>` : ``}
            </div>

            <div class="announceBody">${esc(guild.announcement || "No announcement set.")}</div>

            ${
              guild.announcement_updated_at
                ? `<div class="announceMeta">Last updated ${esc(fmtDate(guild.announcement_updated_at))}</div>`
                : ``
            }
          </div>

          <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:12px;">
            <button id="open-contribute" class="btn primary">🪙 Contribute</button>
            <button id="open-perks" class="btn">✨ Perks</button>
            <button id="open-log" class="btn">📜 Activity Log</button>
            ${canInvite ? `<a class="btn" href="/guild/invite">➕ Invite</a>` : ``}
          </div>

          <div style="margin-top:14px;">
            <table class="table">
              <tr>
                <th>Name</th><th>Rank</th><th>Joined</th><th>Contribution</th><th>Actions</th>
              </tr>
              ${
                members.map((m:any) => {
                  const canManageThis =
                    hasPerm(member.permissions, PERMS.MANAGE_ROLES) &&
                    member.rank_order > m.rank_order &&
                    Number(member.player_id) !== Number(m.player_id);

                  return `
                    <tr>
                      <td>${esc(m.name)}</td>
                      <td>${esc(m.role_name)}</td>
                      <td>${esc(new Date(m.joined_at).toLocaleDateString())}</td>
                      <td>${fmt(m.contribution)}</td>
                      <td>
                        ${
                          canManageThis
                            ? `<button class="smallBtn manage-btn"
                                 data-player="${esc(m.name)}"
                                 data-role="${esc(m.role_name)}"
                                 data-player-id="${Number(m.player_id)}"
                               >Manage</button>`
                            : `—`
                        }
                      </td>
                    </tr>
                  `;
                }).join("")
              }
            </table>
          </div>

          <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:14px;">
            <a class="btn" href="/guild/leave" id="leave-guild-link" ${Number(member.owner_id) === Number(member.player_id) ? `data-owner="1"` : ``}>Leave Guild</a>
            ${canDelete ? `<a class="btn danger" href="/guild/delete" id="delete-guild-link">Delete Guild</a>` : ``}
          </div>

        </div>
      </section>

      <!-- RIGHT: QUICK INFO -->
      <aside class="card">
        <div class="cardHeader">
          <div class="cardTitle">
            <h2>Quick Info</h2>
            <p>What matters at a glance.</p>
          </div>
          <span class="badge">Guild</span>
        </div>

        <div class="cardBody">
          <div class="metaBox">
            <div class="metaK">Your Contribution</div>
            <div class="metaV">${fmt(member.contribution)}g</div>
          </div>

          <div class="metaBox" style="margin-top:10px;">
            <div class="metaK">Permissions</div>
            <div style="margin-top:6px; color:var(--muted); font-size:12px; line-height:1.4;">
              ${hasPerm(member.permissions, PERMS.INVITE) ? "• Can invite<br>" : ""}
              ${hasPerm(member.permissions, PERMS.KICK) ? "• Can kick<br>" : ""}
              ${hasPerm(member.permissions, PERMS.SPEND_PERK_POINTS) ? "• Can spend perk points<br>" : ""}
              ${hasPerm(member.permissions, PERMS.MANAGE_ROLES) ? "• Can manage roles<br>" : ""}
              ${hasPerm(member.permissions, PERMS.ADMIN_GUILD) ? "• Guild Master<br>" : ""}
              ${member.permissions === 0 ? "• Standard member" : ""}
            </div>
          </div>
        </div>
      </aside>

    </div>
  </div>

  <!-- JSON payload for guild.js -->
  <script id="guildData" type="application/json">${esc(JSON.stringify({
    canKick: hasPerm(member.permissions, PERMS.KICK),
    canManageRoles: hasPerm(member.permissions, PERMS.MANAGE_ROLES),
    isOwner: Number(member.owner_id) === Number(member.player_id)
  }))}</script>

  <!-- MODALS -->
  <div class="modal" id="contribute-modal">
    <div class="modalWin">
      <div class="modalHead">
        <h3>Contribute Gold</h3>
        <button class="smallBtn" onclick="document.getElementById('contribute-modal').classList.remove('isOpen')">Close</button>
      </div>
      <div class="modalBody">
        <div style="color:var(--muted); font-size:12px; margin-bottom:10px;">You have <b>${fmt(player.gold)}g</b>.</div>
        <form method="POST" action="/guild/donate">
          <input class="field" type="number" name="amount" min="1" max="${Number(player.gold)}" placeholder="Enter amount" required>
          <div class="modalActions">
            <button class="btn primary" type="submit">Donate</button>
          </div>
        </form>
      </div>
    </div>
  </div>

  <div class="modal" id="perks-modal">
    <div class="modalWin">
      <div class="modalHead">
        <h3>Guild Perks</h3>
        <button class="smallBtn" onclick="document.getElementById('perks-modal').classList.remove('isOpen')">Close</button>
      </div>
      <div class="modalBody">
        <div style="color:var(--muted); font-size:12px; margin-bottom:10px;">Available perk points: <b>${fmt(guild.perk_points)}</b></div>

        <div style="margin-top:10px;">
          <div style="font-weight:900; margin-bottom:6px;">⚔ Combat</div>
          ${perkDefs.filter((p:any)=>p.category==="combat").map((p:any)=>renderPerk(p, perkLevels[p.id]||0)).join("")}
        </div>

        <div style="margin-top:12px;">
          <div style="font-weight:900; margin-bottom:6px;">💰 Economy</div>
          ${perkDefs.filter((p:any)=>p.category==="economy").map((p:any)=>renderPerk(p, perkLevels[p.id]||0)).join("")}
        </div>

        <div style="margin-top:12px;">
          <div style="font-weight:900; margin-bottom:6px;">🛡 Utility</div>
          ${perkDefs.filter((p:any)=>p.category==="utility").map((p:any)=>renderPerk(p, perkLevels[p.id]||0)).join("")}
        </div>
      </div>
    </div>
  </div>

  <div class="modal" id="log-modal">
    <div class="modalWin">
      <div class="modalHead">
        <h3>Guild Activity Log</h3>
        <button class="smallBtn" onclick="document.getElementById('log-modal').classList.remove('isOpen')">Close</button>
      </div>
      <div class="modalBody">
        <ul class="activity">
          ${activityRows.map((a:any)=>`
            <li>
              <div class="time">${esc(fmtDate(a.created_at))}</div>
              <div><b>${esc(a.actor_name || "System")}</b> ${esc(formatActivity(a))}</div>
            </li>
          `).join("")}
        </ul>
      </div>
    </div>
  </div>

  <div class="modal" id="announcement-modal">
    <div class="modalWin">
      <div class="modalHead">
        <h3>Edit Announcement</h3>
        <button class="smallBtn" id="close-announcement">Close</button>
      </div>
      <div class="modalBody">
        <textarea class="field" id="announcement-text" rows="6" placeholder="Enter guild announcement...">${esc(guild.announcement || "")}</textarea>
        <div class="modalActions">
          <button class="btn primary" id="save-announcement" type="button">Save</button>
        </div>
      </div>
    </div>
  </div>

  <div class="modal" id="manage-member-modal">
    <div class="modalWin">
      <div class="modalHead">
        <h3>Manage Member</h3>
        <button class="smallBtn" id="close-manage-member">Close</button>
      </div>
      <div class="modalBody">
        <div style="margin-bottom:10px;">
          <b id="manage-member-name"></b><br>
          <span style="color:var(--muted); font-size:12px;">Current role: <span id="manage-member-role"></span></span>
        </div>

        <div style="margin-top:10px;">
          <div style="color:var(--muted); font-size:11px; letter-spacing:.6px; text-transform:uppercase; font-weight:900;">Change Role</div>
          <select class="field" id="manage-role-select">
            ${
              roles
                .filter((r:any) => r.rank_order < member.rank_order)
                .map((r:any) => `<option value="${Number(r.id)}">${esc(r.name)}</option>`)
                .join("")
            }
          </select>
          <div class="modalActions">
            <button class="btn primary" id="confirm-role-change" type="button">Apply Role</button>
            ${
              hasPerm(member.permissions, PERMS.KICK)
                ? `<button class="btn danger" id="kick-member-btn" type="button">Kick</button>`
                : ``
            }
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="modal" id="leave-blocked-modal">
    <div class="modalWin">
      <div class="modalHead">
        <h3>Can't Leave Guild</h3>
        <button class="smallBtn" id="close-leave-blocked">Close</button>
      </div>
      <div class="modalBody">
        You are the <b>Guild Master</b>. Appoint a new Guild Master before leaving.
      </div>
    </div>
  </div>

  <div class="modal" id="delete-guild-modal">
    <div class="modalWin">
      <div class="modalHead">
        <h3>Delete Guild?</h3>
        <button class="smallBtn" onclick="document.getElementById('delete-guild-modal').classList.remove('isOpen')">Close</button>
      </div>
      <div class="modalBody">
        <div style="color:rgba(255,204,102,.95); font-weight:900;">This permanently deletes the guild for ALL members.</div>
        <div style="margin-top:10px; color:var(--muted); font-size:12px;">Confirm available in <b><span id="delete-guild-timer">5</span></b> seconds…</div>
        <div class="modalActions">
          <button class="btn" id="cancel-delete-guild" type="button">Cancel</button>
          <button class="btn danger" id="confirm-delete-guild" type="button" disabled>Delete Guild</button>
        </div>
      </div>
    </div>
  </div>

</body>
</html>
`);


});


router.post("/guild/member/role", requireLogin, async (req:any, res:any) => {
  const pid = req.session.playerId;
  const { targetPlayerId, newRoleId } = req.body;

  if (!targetPlayerId || !newRoleId) {
    return res.send("Invalid request.");
  }

  const actor = await loadMyGuildMember(pid);
  if (!actor) return res.send("Not in a guild.");

  if (!hasPerm(actor.permissions, PERMS.MANAGE_ROLES)) {
    return res.send("No permission.");
  }

  if (Number(targetPlayerId) === pid) {
    return res.send("You cannot change your own role.");
  }

  // Load target member
  const [[target]]: any = await db.execute(`
    SELECT 
      gm.player_id,
      gm.role_id,
      gr.rank_order
    FROM guild_members gm
    JOIN guild_roles gr ON gr.id = gm.role_id
    WHERE gm.player_id=? AND gm.guild_id=?
  `, [targetPlayerId, actor.guild_id]);

  if (!target) return res.send("Target not found.");

  // Load new role
  const [[newRole]]: any = await db.execute(`
    SELECT id, rank_order
    FROM guild_roles
    WHERE id=? AND guild_id=?
  `, [newRoleId, actor.guild_id]);

  if (!newRole) return res.send("Invalid role.");

  // Rank enforcement
  if (
    actor.rank_order <= target.rank_order ||
    actor.rank_order <= newRole.rank_order
  ) {
    return res.send("Rank too low.");
  }

  // Apply role change
  await db.execute(`
    UPDATE guild_members
    SET role_id=?
    WHERE player_id=? AND guild_id=?
  `, [newRole.id, targetPlayerId, actor.guild_id]);

  res.redirect("/guild");

  await logGuildActivity(
  actor.guild_id,
  pid,
  targetPlayerId,
  "ROLE_CHANGE",
  `Changed role to ${newRole.id}`
);

});

/* =======================
   UPDATE GUILD ANNOUNCEMENT
======================= */
router.post("/guild/announcement", requireLogin, async (req: any, res: any) => {
  const pid = req.session.playerId;
  const { text } = req.body;

  const member = await loadMyGuildMember(pid);
  if (!member) return res.send("Not in a guild.");

  if (!hasPerm(member.permissions, PERMS.MANAGE_ROLES)) {
    return res.send("No permission.");
  }

  // Normalize input
  const announcement = text?.trim() || null;

  await db.execute(
    `
    UPDATE guilds
    SET 
      announcement = ?,
      announcement_updated_at = NOW(),
      announcement_updated_by = ?
    WHERE id=?
    `,
    [announcement, pid, member.guild_id]
  );

  await logGuildActivity(
    member.guild_id,
    pid,
    null,
    "ANNOUNCEMENT",
    announcement ? "Updated guild announcement" : "Cleared guild announcement"
  );

  res.sendStatus(200);
});






//KICK MEMBER
router.post("/guild/member/kick", requireLogin, async (req:any, res:any) => {
  const pid = req.session.playerId;
  const { targetPlayerId } = req.body;

  if (!targetPlayerId) {
    return res.send("Invalid request.");
  }

  const actor = await loadMyGuildMember(pid);
  if (!actor) return res.send("Not in a guild.");

  if (!hasPerm(actor.permissions, PERMS.KICK)) {
    return res.send("No permission.");
  }

  if (Number(targetPlayerId) === pid) {
    return res.send("You cannot kick yourself.");
  }

  const [[target]]: any = await db.execute(`
    SELECT 
      gm.player_id,
      gr.rank_order
    FROM guild_members gm
    JOIN guild_roles gr ON gr.id = gm.role_id
    WHERE gm.player_id=? AND gm.guild_id=?
  `, [targetPlayerId, actor.guild_id]);

  if (!target) return res.send("Target not found.");

  if (actor.rank_order <= target.rank_order) {
    return res.send("Rank too low.");
  }

  await db.execute(`
    DELETE FROM guild_members
    WHERE player_id=? AND guild_id=?
  `, [targetPlayerId, actor.guild_id]);

  res.redirect("/guild");

    await logGuildActivity(
  actor.guild_id,
  pid,
  targetPlayerId,
  "KICK",
  "Removed from guild"
);


});

/* =======================
   GUILD DONATION ROUTE
======================= */
router.post("/guild/donate", requireLogin, async (req: any, res: any) => {
  const pid = (req.session as any).playerId;
  
  let amount = parseInt(req.body.amount, 10);

  if (!amount || amount <= 0) {
    return res.send("Invalid donation amount.");
  }

  // Load player's gold
  const [[player]]: any = await db.execute(
    "SELECT gold FROM players WHERE id=?",
    [pid]
  );

  if (!player) return res.send("Player not found.");
  if (player.gold < amount) return res.send("You don't have enough gold.");

  // Load player's guild membership
const member = await loadMyGuildMember(pid);
if (!member) return res.send("You are not in a guild.");

  const gid = member.guild_id;

  // Deduct gold from player
  await db.execute(
    "UPDATE players SET gold = gold - ? WHERE id=?",
    [amount, pid]
  );

  // Add gold to guild
  await db.execute(
    "UPDATE guilds SET gold = gold + ? WHERE id=?",
    [amount, gid]
  );

  // Add contribution for the player
  await db.execute(
    "UPDATE guild_members SET contribution = contribution + ? WHERE player_id=?",
    [amount, pid]
  );

  // Grant Guild XP (example: 2 XP per 1 gold)
  const xpGain = amount * 2;
  await addGuildXP(gid, xpGain);

  res.redirect("/guild");
  await logGuildActivity(
  gid,
  pid,
  null,
  "DONATION",
  `${amount} gold`
);
});
/* =======================
   GUILD UPGRADE ROUTE
======================= */
router.post("/guild/perks/upgrade", requireLogin, async (req: any, res: any) => {
  const pid = (req.session as any).playerId;
  const perkId = parseInt(req.body.perk_id, 10);

  if (!perkId) return res.send("Invalid perk selection.");

  // Load guild membership
const member = await loadMyGuildMember(pid);
if (!member) return res.send("Not in a guild.");

if (!hasPerm(member.permissions, PERMS.SPEND_PERK_POINTS)) {
  return res.send("You do not have permission.");
}
  const gid = member.guild_id;
  // Only Guild Master can upgrade

  // Load guild
  const [[guild]]: any = await db.execute(
    "SELECT perk_points FROM guilds WHERE id=?",
    [gid]
  );
  if (guild.perk_points <= 0) return res.send("No perk points available.");

  // Load perk definition
  const [[perkDef]]: any = await db.execute(
    "SELECT * FROM perk_definitions WHERE id=?",
    [perkId]
  );
  if (!perkDef) return res.send("Perk does not exist.");

  // Load current perk level
  const [[perkRow]]: any = await db.execute(
    "SELECT level FROM guild_perks WHERE guild_id=? AND perk_id=?",
    [gid, perkId]
  );

  const level = perkRow ? perkRow.level : 0;
  if (level >= perkDef.max_level) return res.send("Perk already maxed out.");

  // Apply upgrade
  if (!perkRow) {
    await db.execute(
      "INSERT INTO guild_perks (guild_id, perk_id, level) VALUES (?, ?, 1)",
      [gid, perkId]
    );
  } else {
    await db.execute(
      "UPDATE guild_perks SET level = level + 1 WHERE guild_id=? AND perk_id=?",
      [gid, perkId]
    );
  }

  // Deduct perk point
  await db.execute(
    "UPDATE guilds SET perk_points = perk_points - 1 WHERE id=?",
    [gid]
  );

  res.redirect("/guild");
});



/* ============================================================================================
   CREATE GUILD PAGE
============================================================================================ */
router.get("/guild/create", requireLogin, (req,res)=>{
res.send(`
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&display=swap" rel="stylesheet">
  <title>Guildforge | Create Guild</title>

  <link rel="stylesheet" href="/statpanel.css">
  <script defer src="/statpanel.js"></script>

  <link rel="stylesheet" href="/guild.css">
</head>

<body>
  <div id="statpanel-root"></div>

  <div class="wrap">
    <div class="topbar">
      <div class="brand">
        <div class="title"><span class="sigil"></span> Create Guild</div>
        <div class="sub">Name your banner and set a purpose.</div>
      </div>
      <div class="nav">
        <a class="btn" href="/guild">Back</a>
        <a class="btn" href="/town">Return to Town</a>
      </div>
    </div>

    <div class="grid" style="grid-template-columns: 1fr;">
      <section class="card">
        <div class="cardHeader">
          <div class="cardTitle">
            <h2>Found a Guild</h2>
            <p>This will make you the Guild Master.</p>
          </div>
          <span class="badge good">New</span>
        </div>

        <div class="cardBody">
          <form method="POST" action="/guild/create" style="display:grid; gap:10px; max-width:620px;">
            <input class="field" name="name" placeholder="Guild name" maxlength="32" required>
            <textarea class="field" name="description" placeholder="Guild description" rows="4" maxlength="220"></textarea>

            <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:4px;">
              <button class="btn primary" type="submit">Create Guild</button>
              <a class="btn" href="/guild">Cancel</a>
            </div>
          </form>
        </div>
      </section>
    </div>
  </div>
</body>
</html>
`);

});

/* =======================
   CREATE GUILD ACTION
======================= */
router.post("/guild/create", requireLogin, async (req, res) => {
  const pid = (req.session as any).playerId;
  const { name, description } = req.body;

  // Ensure player is not already in a guild
  const [rows]: any[] = await db.execute(
    "SELECT id FROM guild_members WHERE player_id=?",
    [pid]
  );

  if (rows.length) return res.send("Leave your current guild first.");

  // Create guild
  const [result]: any = await db.execute(`
    INSERT INTO guilds (name, description, owner_id)
    VALUES (?, ?, ?)
  `, [name.trim(), description.trim(), pid]);

  const gid: number = Number(result.insertId);

  /* ============================================
      INSERT DEFAULT GUILD ROLES — USE GLOBAL PERMS
  ============================================ */

  await db.execute(`
    INSERT INTO guild_roles (guild_id, name, permissions, rank_order)
    VALUES
      (?, 'Guild Master', ?, 100),
      (?, 'Officer', ?, 75),
      (?, 'Veteran', ?, 50),
      (?, 'Member', ?, 25),
      (?, 'Recruit', ?, 10)
  `,
  [
    gid,
    PERMS.INVITE + PERMS.KICK + PERMS.SPEND_PERK_POINTS + PERMS.MANAGE_ROLES + PERMS.ACCESS_VAULT + PERMS.ACTIVATE_EVENTS + PERMS.ADMIN_GUILD,

    gid,
    PERMS.INVITE + PERMS.KICK + PERMS.SPEND_PERK_POINTS,

    gid,
    PERMS.ACCESS_VAULT,

    gid,
    0,

    gid,
    0
  ]);

  /* ASSIGN CREATOR AS GUILD MASTER */
  const [[masterRole]]: any = await db.execute(
    "SELECT id FROM guild_roles WHERE guild_id=? AND name='Guild Master'",
    [gid]
  );

  await db.execute(`
    INSERT INTO guild_members (guild_id, player_id, role_id)
    VALUES (?, ?, ?)
  `, [gid, pid, masterRole.id]);

  res.redirect("/guild");
});

/* ============================================================================================
   GUILD LEVEL/XP SYSTEMS
============================================================================================ */

/* =======================
   GUILD XP REQUIRED
======================= */
function guildXpNeeded(level: number): number {
  // Adjust the curve as needed
  return Math.floor(1000 + level * level * 500);
}
/* =======================
   ADD GUILD XP & HANDLE LEVEL UP
======================= */
async function addGuildXP(guildId: number, xpGain: number) {
  const [[guild]]: any = await db.execute(
    "SELECT level, experience FROM guilds WHERE id=?",
    [guildId]
  );

  if (!guild) return;

  let { level, experience } = guild;

  experience += xpGain;
  let leveledUp = false;

  // Loop in case XP gains multiple levels
while (experience >= guildXpNeeded(level)) {
  experience -= guildXpNeeded(level);
  level++;

  // Give +1 perk point each level-up
  await db.execute(
    "UPDATE guilds SET perk_points = perk_points + 1 WHERE id=?",
    [guildId]
  );

  leveledUp = true;
  await logGuildActivity(
  guildId,
  null,
  null,
  "LEVEL_UP",
  `Reached level ${level}`
);
}


  await db.execute(
    "UPDATE guilds SET level=?, experience=? WHERE id=?",
    [level, experience, guildId]
  );

  return { level, experience, leveledUp };
}

/* =======================
   INVITE PAGE
======================= */
router.get("/guild/invite", requireLogin, async (req,res)=>{

  const pid = (req.session as any).playerId;

const member = await loadMyGuildMember(pid);
if (!member) return res.send("You are not in a guild.");

if (!hasPerm(member.permissions, PERMS.INVITE)) {
  return res.send("You do not have permission to invite.");
}


res.send(`
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&display=swap" rel="stylesheet">
  <title>Guildforge | Invite Player</title>

  <link rel="stylesheet" href="/statpanel.css">
  <script defer src="/statpanel.js"></script>

  <link rel="stylesheet" href="/guild.css">
</head>

<body>
  <div id="statpanel-root"></div>

  <div class="wrap">
    <div class="topbar">
      <div class="brand">
        <div class="title"><span class="sigil"></span> Invite Player</div>
        <div class="sub">Bring someone under your banner.</div>
      </div>
      <div class="nav">
        <a class="btn" href="/guild">Back</a>
        <a class="btn" href="/town">Return to Town</a>
      </div>
    </div>

    <div class="grid" style="grid-template-columns: 1fr;">
      <section class="card">
        <div class="cardHeader">
          <div class="cardTitle">
            <h2>Send Invitation</h2>
            <p>Player must not already be in a guild.</p>
          </div>
          <span class="badge">Invite</span>
        </div>

        <div class="cardBody">
          <form method="POST" action="/guild/invite" style="display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
            <input class="field" name="player" placeholder="Exact player name" maxlength="32" required style="min-width:260px;">
            <button class="btn primary" type="submit">Invite</button>
            <a class="btn" href="/guild">Cancel</a>
          </form>
        </div>
      </section>
    </div>
  </div>
</body>
</html>
`);
});

/* =======================
   INVITE ACTION
======================= */
router.post("/guild/invite", requireLogin, async (req,res)=>{

  const pid = (req.session as any).playerId;
  const { player } = req.body;

const inviter = await loadMyGuildMember(pid);
if (!inviter) return res.send("Not allowed.");

if (!hasPerm(inviter.permissions, PERMS.INVITE)) {
  return res.send("You do not have permission to invite.");
}


  const [targets] = await db.execute(
    "SELECT id FROM players WHERE name=?",
    [player.trim()]
  ) as any;

  const target = targets[0];
  if (!target) return res.send("Player not found.");

  const [existing] = await db.execute(
    "SELECT 1 FROM guild_members WHERE player_id=?",
    [target.id]
  ) as any;
  if (existing.length) return res.send("Player already in a guild.");

  const [duplicates] = await db.execute(`
    SELECT id FROM guild_invites
    WHERE guild_id=? AND invitee_id=?
  `,[inviter.guild_id, target.id]) as any;

  if (duplicates.length) return res.send("Already invited by your guild.");

  await db.execute(`
    INSERT INTO guild_invites (guild_id, inviter_id, invitee_id)
    VALUES (?, ?, ?)
  `,[inviter.guild_id, pid, target.id]);

  res.redirect("/guild");
});

/* =======================
   ACCEPT INVITE
======================= */
router.get("/guild/accept/:id", requireLogin, async (req,res)=>{

  const pid = (req.session as any).playerId;
  const inviteId = parseInt(req.params.id);

  const [invRows] = await db.execute(`
    SELECT * FROM guild_invites WHERE id=? AND invitee_id=?
  `,[inviteId, pid]) as any;

  const invite = invRows[0];
  if (!invite) return res.send("Invalid invite.");

const [[recruitRole]]: any = await db.execute(
  "SELECT id FROM guild_roles WHERE guild_id=? AND name='Recruit'",
  [invite.guild_id]
);

await db.execute(`
  INSERT INTO guild_members (guild_id, player_id, role_id)
  VALUES (?, ?, ?)
`, [invite.guild_id, pid, recruitRole.id]);
await logGuildActivity(
  invite.guild_id,
  pid,
  pid,
  "JOIN",
  "Joined the guild"
);


  // Remove all invites after joining
  await db.execute("DELETE FROM guild_invites WHERE invitee_id=?", [pid]);

  res.redirect("/guild");
});

/* =======================
   DECLINE INVITE
======================= */
router.get("/guild/decline/:id", requireLogin, async (req,res)=>{
  const pid = (req.session as any).playerId;
  const inviteId = parseInt(req.params.id);

  await db.execute(`
    DELETE FROM guild_invites
    WHERE id=? AND invitee_id=?
  `,[inviteId, pid]);

  res.redirect("/guild");
});

/* =======================
   LEAVE GUILD
======================= */
router.get("/guild/leave", requireLogin, async (req, res) => {
  const pid = (req.session as any).playerId;

  const member = await loadMyGuildMember(pid);
  if (!member) return res.send("You are not in a guild.");

  // Log BEFORE removal
  await logGuildActivity(
    member.guild_id,
    pid,
    pid,
    "LEAVE",
    "Left the guild"
  );

  await db.execute(
    "DELETE FROM guild_members WHERE player_id=?",
    [pid]
  );

  res.redirect("/");
});


/* =======================
   DELETE GUILD (MASTER ONLY)
======================= */
router.get("/guild/delete", requireLogin, async (req,res)=>{

  const pid = (req.session as any).playerId;

  // Check ownership
const member = await loadMyGuildMember(pid);
if (!member) return res.send("You are not in a guild.");

if (!hasPerm(member.permissions, PERMS.ADMIN_GUILD)) {
  return res.send("Only the Guild Master can delete the guild.");
}


  const guildId = member.guild_id;

  // ✅ Delete all related references FIRST (safe order)
  await db.execute("DELETE FROM guild_invites WHERE guild_id=?", [guildId]);
  await db.execute("DELETE FROM guild_members WHERE guild_id=?", [guildId]);

  // ✅ Delete actual guild
  await db.execute("DELETE FROM guilds WHERE id=?", [guildId]);

  res.redirect("/");
});



export default router;
