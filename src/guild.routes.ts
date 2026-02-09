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
<!DOCTYPE html>
<html>
<head>
<title>Guildforge | Guild Invitations</title>
<link rel="stylesheet" href="/guild.css">
<link rel="stylesheet" href="/statpanel.css">
</head>
<body>
<div id="statpanel-root"></div>
<link rel="stylesheet" href="/statpanel.css">
<script src="/statpanel.js"></script>

<div class="guild-container">
<div class="guild-title">Guild Invitations</div>

${
inviteRows.length ? `
<table class="guild-table">
<tr><th>Guild</th><th>Inviter</th><th>Action</th></tr>
${
  inviteRows.map((i:any)=>`
    <tr>
      <td>${i.guild_name}</td>
      <td>${i.inviter}</td>
      <td>
        <a href="/guild/accept/${i.id}">Accept</a> |
        <a href="/guild/decline/${i.id}">Decline</a>
      </td>
    </tr>
  `).join("")
}
</table>
` : `<p style="text-align:center">No invitations.</p>`}

<div class="guild-actions">
<a href="/guild/create">Create Guild</a>
<a href="/">Return</a>
</div>
</div>
<script src="/statpanel.js"></script>
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

  res.send(`
<!DOCTYPE html>
<html>
<head>
<title>Guildforge | ${guild.name} — Guild</title>
<link rel="stylesheet" href="/guild.css">
<link rel="stylesheet" href="/statpanel.css">
</head>
<body>
<div id="statpanel-root"></div>
<link rel="stylesheet" href="/statpanel.css">
<script src="/statpanel.js"></script>

<div class="guild-container">

<div class="guild-title">${guild.name}</div>
<div class="guild-announcement">
  <div class="announcement-header">
  <div class="announcement-title">
    <strong>📣 Guild Announcement</strong>
  </div>

    ${
      hasPerm(member.permissions, PERMS.MANAGE_ROLES)
        ? `<button id="edit-announcement" class="small-btn">Edit</button>`
        : ``
    }
  </div>

  <div class="announcement-body">
    ${guild.announcement || "No announcement set."}
  </div>

  ${
    guild.announcement_updated_at
      ? `<div class="announcement-meta">
           Last updated ${new Date(guild.announcement_updated_at).toLocaleString()}
         </div>`
      : ``
  }
</div>


<div class="guild-sub">
  Level ${guild.level} <br>
  XP: ${guild.experience} / ${guildXpNeeded(guild.level)}
</div>

<div class="guild-xp-bar-wrapper">
  <div class="guild-xp-bar">
    <div class="guild-xp-fill" 
         style="width:${(guild.experience / guildXpNeeded(guild.level)) * 100}%">
    </div>
  </div>
</div>


<div id="manage-member-modal" class="modal-hidden">
  <div class="modal-window" style="width:420px">

    <h2>Manage Member</h2>

    <p>
      <strong id="manage-member-name"></strong><br>
      Current Role: <span id="manage-member-role"></span>
    </p>

    <hr>

    <!-- ROLE CHANGE -->
    <div class="manage-section">
      <label>Change Role</label>
      <select id="manage-role-select">
        ${roles
          .filter((r:any) => r.rank_order < member.rank_order)
          .map((r:any) =>
            `<option value="${r.id}">${r.name}</option>`
          ).join("")}
      </select>

      <button id="confirm-role-change">Apply Role</button>

    </div>

    <hr>

    <!-- KICK -->
    ${
      hasPerm(member.permissions, PERMS.KICK)
        ? `<button id="kick-member-btn" class="danger-btn">
             Kick from Guild
           </button>`
        : ""
    }

    <div class="modal-actions">
      <button id="close-manage-member" class="cancel-btn">Close</button>
    </div>

  </div>
</div>



<div class="guild-actions" style="text-align:center; margin-top:15px;">
  <button id="open-contribute" class="contrib-btn">Contribute</button>
  <button id="open-perks" class="contrib-btn">Perks</button>
  <button id="open-log" class="contrib-btn">View Log</button>
</div>



<!-- MODAL BACKDROP -->
<div id="contribute-modal" class="modal-hidden">
  <div class="modal-window">

    <h2>Contribute Gold</h2>
    <p>You have <strong>${player.gold}</strong> gold.</p>

    <form method="POST" action="/guild/donate">
      <input 
        type="number"
        name="amount"
        min="1"
        max="${player.gold}"
        placeholder="Enter amount"
        required
      >

      <div class="modal-actions">
        <button type="submit" class="donate-btn">Donate</button>
        <button type="button" id="close-contribute" class="cancel-btn">Cancel</button>
      </div>
    </form>

  </div>
</div>

<!-- GUILD PERKS MODAL -->
<div id="perks-modal" class="modal-hidden">
  <div class="modal-window" style="width:480px">

    <h2>Guild Perks</h2>
    <p>Available Perk Points: <strong>${guild.perk_points}</strong></p>

    <!-- COMBAT PERKS -->
    <div class="perk-section">
      <h3>⚔ Combat Perks</h3>
      ${
        perkDefs
          .filter((p: any) => p.category === "combat")
          .map((p: any) => renderPerk(p, perkLevels[p.id] || 0))
          .join("")
      }
    </div>

    <!-- ECONOMY PERKS -->
    <div class="perk-section">
      <h3>💰 Economy Perks</h3>
      ${
        perkDefs
          .filter((p: any) => p.category === "economy")
          .map((p: any) => renderPerk(p, perkLevels[p.id] || 0))
          .join("")
      }
    </div>

    <!-- UTILITY PERKS -->
    <div class="perk-section">
      <h3>🛡 Utility Perks</h3>
      ${
        perkDefs
          .filter((p: any) => p.category === "utility")
          .map((p: any) => renderPerk(p, perkLevels[p.id] || 0))
          .join("")
      }
    </div>

    <div class="modal-actions">
      <button type="button" id="close-perks" class="cancel-btn">Close</button>
    </div>

  </div>
</div>

<!-- ACTIVITY LOG MODAL -->
<div id="log-modal" class="modal-hidden">
  <div class="modal-window" style="width:600px; max-height:70vh; overflow:auto;">

    <h2>Guild Activity Log</h2>

    <ul class="guild-activity">
      ${
        activityRows.map((a:any) => `
          <li>
            <span class="activity-time">
              ${new Date(a.created_at).toLocaleString()}
            </span>
            —
            <strong>${a.actor_name || "System"}</strong>
            ${formatActivity(a)}
          </li>
        `).join("")
      }
    </ul>

    <div class="modal-actions">
      <button type="button" id="close-log" class="cancel-btn">Close</button>
    </div>

  </div>
</div>
<!-- ANNOUNCEMENT MODAL -->
<div id="announcement-modal" class="modal-hidden">
  <div class="modal-window" style="width:520px">

    <h2>Edit Guild Announcement</h2>

    <textarea
      id="announcement-text"
      rows="6"
      placeholder="Enter guild announcement..."
    >${guild.announcement || ""}</textarea>

    <div class="modal-actions">
      <button id="save-announcement" class="confirm-btn">Save</button>
      <button id="close-announcement" class="cancel-btn">Cancel</button>
    </div>

  </div>
</div>
<!-- LEAVE GUILD BLOCKED MODAL -->
<div id="leave-blocked-modal" class="modal-hidden">
  <div class="modal-window" style="width:520px; text-align:center;">
    <h2>Can't Leave Guild</h2>
    <p style="margin-top:10px;">
      You are the <strong>Guild Master</strong>.
      Appoint a new Guild Master before leaving the guild.
    </p>

    <div class="modal-actions" style="justify-content:center;">
      <button type="button" id="close-leave-blocked" class="cancel-btn">Close</button>
    </div>
  </div>
</div>
<!-- DELETE GUILD CONFIRM MODAL -->
<div id="delete-guild-modal" class="modal-hidden">
  <div class="modal-window" style="width:520px; text-align:center;">
    <h2 style="color:#ff6666;">Delete Guild?</h2>

    <p style="margin-top:10px;">
      This will <strong>permanently delete</strong> the guild for <strong>ALL members</strong>.
      This cannot be undone.
    </p>

    <p style="margin-top:10px; opacity:.9;">
      Confirm available in <strong><span id="delete-guild-timer">5</span></strong> seconds...
    </p>

    <div class="modal-actions" style="justify-content:center; gap:10px;">
      <button type="button" id="cancel-delete-guild" class="cancel-btn">Cancel</button>
      <button type="button" id="confirm-delete-guild" class="danger-btn" disabled>
        Delete Guild
      </button>
    </div>
  </div>
</div>


<p style="text-align:center">${guild.description || "No guild description."}</p>

<div class="guild-actions">
${hasPerm(member.permissions, PERMS.INVITE) ? `
  <a href="/guild/invite">Invite</a>
` : ""}

${hasPerm(member.permissions, PERMS.ADMIN_GUILD) ? `
  <a href="/guild/delete"
    id="delete-guild-link"
    style="color:red">
    Delete Guild
  </a>
` : ""}

<a
  href="/guild/leave"
  id="leave-guild-link"
  ${Number(member.owner_id) === Number(member.player_id) ? `data-owner="1"` : ``}
>
  Leave Guild
</a>

<a href="/">Return</a>
</div>


<div class="guild-panel">
<h3>Members</h3>
<table class="guild-table">
<tr><th>Name</th><th>Rank</th><th>Joined</th><th>Contribution</th><th>Actions</th></tr>
${
members.map((m:any)=>`
<tr>
<td>${m.name}</td>
<td>${m.role_name}</td>
<td>${new Date(m.joined_at).toLocaleDateString()}</td>
<td>${m.contribution}</td>
 <td>
    ${
          member.rank_order > m.rank_order &&
          member.player_id !== m.player_id &&
          hasPerm(member.permissions, PERMS.MANAGE_ROLES)

        ? `<button 
             class="manage-btn"
             data-player="${m.name}"
             data-role="${m.role_name}"
             data-player-id="${m.player_id}"
           >
             Manage
           </button>`
        : `—`
    }
  </td>
</tr>
`).join("")
}
</table>


</div>

</div>
<script src="/statpanel.js"></script>

<script>
document.addEventListener("DOMContentLoaded", () => {

  /* ============================
     SHARED MODAL HELPERS
  ============================ */
  function openModal(modal) {
    modal.classList.remove("modal-hidden", "modal-closing");
    modal.classList.add("modal-visible");
  }

  function closeModal(modal) {
    modal.classList.remove("modal-visible");
    modal.classList.add("modal-closing");

    setTimeout(() => {
      modal.classList.add("modal-hidden");
      modal.classList.remove("modal-closing");
    }, 300);
  }

  /* ============================
       CONTRIBUTION MODAL
  ============================ */
  const contribModal = document.getElementById("contribute-modal");
  const openContrib = document.getElementById("open-contribute");
  const closeContrib = document.getElementById("close-contribute");

  openContrib?.addEventListener("click", () => openModal(contribModal));
  closeContrib?.addEventListener("click", () => closeModal(contribModal));

  /* ============================
           PERKS MODAL
  ============================ */
  const perksModal = document.getElementById("perks-modal");
  const openPerks = document.getElementById("open-perks");
  const closePerks = document.getElementById("close-perks");

  openPerks?.addEventListener("click", () => openModal(perksModal));
  closePerks?.addEventListener("click", () => closeModal(perksModal));

/* ============================
     ACTIVITY LOG MODAL
============================ */
const logModal = document.getElementById("log-modal");
const openLog = document.getElementById("open-log");
const closeLog = document.getElementById("close-log");

openLog?.addEventListener("click", () => openModal(logModal));
closeLog?.addEventListener("click", () => closeModal(logModal));


/* ============================
     ADD ANNOUNCEMENT MODAL
============================ */
const announcementModal = document.getElementById("announcement-modal");
const openAnnouncement = document.getElementById("edit-announcement");
const closeAnnouncement = document.getElementById("close-announcement");

openAnnouncement?.addEventListener("click", () =>
  openModal(announcementModal)
);

closeAnnouncement?.addEventListener("click", () =>
  closeModal(announcementModal)
);
document
  .getElementById("save-announcement")
  ?.addEventListener("click", () => {

    const text =
      document.getElementById("announcement-text").value.trim();

    fetch("/guild/announcement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    }).then(() => location.reload());
  });


  /* ============================
       MANAGE MEMBER MODAL
  ============================ */
  const manageModal = document.getElementById("manage-member-modal");

  document.querySelectorAll(".manage-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      currentTargetPlayerId = btn.dataset.playerId;

      document.getElementById("manage-member-name").textContent =
        btn.dataset.player;

      document.getElementById("manage-member-role").textContent =
        btn.dataset.role;

      openModal(manageModal);
    });
  });

  document
    .getElementById("close-manage-member")
    ?.addEventListener("click", () => closeModal(manageModal));

  /* ============================
     APPLY ROLE CHANGE
  ============================ */
  document
    .getElementById("confirm-role-change")
    ?.addEventListener("click", () => {

      const roleId =
        document.getElementById("manage-role-select").value;

      if (!currentTargetPlayerId || !roleId) return;

      fetch("/guild/member/role", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetPlayerId: currentTargetPlayerId,
          newRoleId: roleId
        })
      }).then(() => location.reload());
    });

  /* ============================
     KICK MEMBER
  ============================ */
  document
    .getElementById("kick-member-btn")
    ?.addEventListener("click", () => {

      if (!currentTargetPlayerId) return;
      if (!confirm("Kick this member from the guild?")) return;

      fetch("/guild/member/kick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetPlayerId: currentTargetPlayerId
        })
      }).then(() => location.reload());
    });
      /* ============================
       BLOCK OWNER LEAVE (MODAL)
  ============================ */
  const leaveLink = document.getElementById("leave-guild-link");
  const leaveBlockedModal = document.getElementById("leave-blocked-modal");
  const closeLeaveBlocked = document.getElementById("close-leave-blocked");

  leaveLink?.addEventListener("click", (e) => {
    const isOwner = leaveLink.dataset.owner === "1";
    if (!isOwner) return; // normal leave

    e.preventDefault();
    openModal(leaveBlockedModal);
  });

  closeLeaveBlocked?.addEventListener("click", () =>
    closeModal(leaveBlockedModal)
  );
  /* ============================
   DELETE GUILD CONFIRM (5s)
============================ */
const deleteLink = document.getElementById("delete-guild-link");
const deleteModal = document.getElementById("delete-guild-modal");
const cancelDeleteBtn = document.getElementById("cancel-delete-guild");
const confirmDeleteBtn = document.getElementById("confirm-delete-guild");
const timerEl = document.getElementById("delete-guild-timer");

let deleteHref = "";
let countdownTimer = null;
let countdown = 5;

function resetDeleteCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  countdown = 5;
  if (timerEl) timerEl.textContent = String(countdown);
  if (confirmDeleteBtn) confirmDeleteBtn.disabled = true;
}

function startDeleteCountdown() {
  resetDeleteCountdown();
  countdownTimer = setInterval(() => {
    countdown -= 1;
    if (timerEl) timerEl.textContent = String(Math.max(0, countdown));

    if (countdown <= 0) {
      clearInterval(countdownTimer);
      countdownTimer = null;
      if (confirmDeleteBtn) confirmDeleteBtn.disabled = false;
      if (timerEl) timerEl.textContent = "0";
    }
  }, 1000);
}

deleteLink?.addEventListener("click", (e) => {
  e.preventDefault();
  if (!deleteModal) return;

  deleteHref = deleteLink.getAttribute("href") || "/guild/delete";
  openModal(deleteModal);
  startDeleteCountdown();
});

cancelDeleteBtn?.addEventListener("click", () => {
  if (!deleteModal) return;
  resetDeleteCountdown();
  closeModal(deleteModal);
});

confirmDeleteBtn?.addEventListener("click", () => {
  if (confirmDeleteBtn.disabled) return;
  // navigate to server route to actually delete
  window.location.href = deleteHref || "/guild/delete";
});

// Optional: if you allow closing by clicking outside, make sure countdown stops
// (Only needed if your modal supports backdrop click-to-close)

});


</script>



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
<!DOCTYPE html>
<html>
<head>
<title>Guildforge | Create Guild</title>
<link rel="stylesheet" href="/guild.css">
<link rel="stylesheet" href="/statpanel.css">
</head>
<body>
<div id="statpanel-root"></div>
<link rel="stylesheet" href="/statpanel.css">
<script src="/statpanel.js"></script>

<div class="guild-container">
<div class="guild-title">Create Guild</div>

<form class="guild-form" method="POST" action="/guild/create">
  <input name="name" placeholder="Guild name" required>
  <textarea name="description" placeholder="Guild description"></textarea>
  <div class="guild-actions">
    <button>Create</button>
    <a href="/">Cancel</a>
  </div>
</form>

</div>
<script src="/statpanel.js"></script>
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
<!DOCTYPE html>
<html>
<head>
<title>Guildforge | Invite Player</title>
<link rel="stylesheet" href="/guild.css">
<link rel="stylesheet" href="/statpanel.css">
</head>
<body>
<div id="statpanel-root"></div>
<link rel="stylesheet" href="/statpanel.css">
<script src="/statpanel.js"></script>

<div class="guild-container">
<div class="guild-title">Invite Player</div>

<form class="guild-form" method="POST" action="/guild/invite">
<input name="player" placeholder="Player name">
<div class="guild-actions">
<button>Invite</button>
<a href="/guild">Back</a>
</div>
</form>

</div>
<script src="/statpanel.js"></script>

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
