import { Router } from "express";
import { db } from "./db";

const router = Router();

/* =======================
   LOGIN REQUIRED
======================= */
function requireLogin(req:any,res:any,next:any) {
  if (!req.session || !req.session.playerId) {
    return res.redirect("/login.html");
  }
  next();
}

/* =======================
   GUILD DASHBOARD
======================= */
router.get("/guild", requireLogin, async (req,res)=>{

  const pid = req.session.playerId;

  // Check membership
  const [memberRows] = await db.execute(`
    SELECT gm.guild_id, gm.guild_rank, g.name, g.level, g.experience, g.gold, g.description, g.owner_id
    FROM guild_members gm
    JOIN guilds g ON g.id = gm.guild_id
    WHERE gm.player_id=?
  `,[pid]) as any;

  const member = memberRows[0];

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
<title>Guild Invitations</title>
<link rel="stylesheet" href="/guild.css">
<link rel="stylesheet" href="/statpanel.css">
</head>
<body>

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

  // LOAD MEMBERS
  const [members] = await db.execute(`
    SELECT p.name, gm.guild_rank, gm.joined_at, gm.contribution
    FROM guild_members gm
    JOIN players p ON p.id = gm.player_id
    WHERE gm.guild_id=?
    ORDER BY gm.contribution DESC
  `,[member.guild_id]) as any;

  // GUILD DASHBOARD
  res.send(`
<!DOCTYPE html>
<html>
<head>
<title>${member.name} — Guild</title>
<link rel="stylesheet" href="/guild.css">
<link rel="stylesheet" href="/statpanel.css">
</head>
<body>

<div class="guild-container">

<div class="guild-title">${member.name}</div>
<div class="guild-sub">
Level ${member.level} | XP ${member.experience} | Gold ${member.gold}
</div>

<p style="text-align:center">${member.description || "No guild description."}</p>

<div class="guild-actions">
${member.guild_rank === "Guild Master" || member.owner_id === pid ? `
<a href="/guild/invite">Invite</a>
<a href="/guild/delete"
   style="color:red"
   onclick="return confirm('This will delete the guild for ALL members. Are you sure?')">
   Delete Guild
</a>
` : ""}
<a href="/guild/leave">Leave Guild</a>
<a href="/">Return</a>
</div>


<div class="guild-panel">
<h3>Members</h3>
<table class="guild-table">
<tr><th>Name</th><th>Rank</th><th>Joined</th><th>Contribution</th></tr>
${
members.map((m:any)=>`
<tr>
<td>${m.name}</td>
<td>${m.guild_rank}</td>
<td>${new Date(m.joined_at).toLocaleDateString()}</td>
<td>${m.contribution}</td>
</tr>
`).join("")
}
</table>
</div>

</div>
<script src="/statpanel.js"></script>
</body>
</html>
`);

});

/* =======================
   CREATE GUILD PAGE
======================= */
router.get("/guild/create", requireLogin, (req,res)=>{
  res.send(`
<!DOCTYPE html>
<html>
<head>
<title>Create Guild</title>
<link rel="stylesheet" href="/guild.css">
<link rel="stylesheet" href="/statpanel.css">
</head>
<body>

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
router.post("/guild/create", requireLogin, async (req,res)=>{

  const pid = req.session.playerId;
  const { name, description } = req.body;

  const [rows] = await db.execute(
    "SELECT id FROM guild_members WHERE player_id=?",
    [pid]
  ) as any;

  if (rows.length) return res.send("Leave your current guild first.");

  const [result]:any = await db.execute(`
    INSERT INTO guilds (name, description, owner_id)
    VALUES (?, ?, ?)
  `,[name.trim(), description.trim(), pid]);

  const gid = result.insertId;

  await db.execute(`
    INSERT INTO guild_members (guild_id, player_id, guild_rank)
    VALUES (?, ?, 'Guild Master')
  `,[gid, pid]);

  res.redirect("/guild");
});

/* =======================
   INVITE PAGE
======================= */
router.get("/guild/invite", requireLogin, async (req,res)=>{

  const pid = req.session.playerId;

  const [rows] = await db.execute(`
    SELECT gm.guild_rank, gm.guild_id, g.owner_id
    FROM guild_members gm
    JOIN guilds g ON g.id = gm.guild_id
    WHERE gm.player_id=?
  `,[pid]) as any;

  const member = rows[0];

  if (!member) return res.send("You are not in a guild.");
  if (member.guild_rank !== "Guild Master" && member.owner_id !== pid)
    return res.send("Permission denied.");

  res.send(`
<!DOCTYPE html>
<html>
<head>
<title>Invite Player</title>
<link rel="stylesheet" href="/guild.css">
<link rel="stylesheet" href="/statpanel.css">
</head>
<body>

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

  const pid = req.session.playerId;
  const { player } = req.body;

  const [rows] = await db.execute(`
    SELECT gm.guild_id, gm.guild_rank, g.owner_id
    FROM guild_members gm
    JOIN guilds g ON g.id = gm.guild_id
    WHERE gm.player_id=?
  `,[pid]) as any;

  const inviter = rows[0];

  if (!inviter || (inviter.guild_rank !== "Guild Master" && inviter.owner_id !== pid))
    return res.send("Not allowed.");

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

  const pid = req.session.playerId;
  const inviteId = parseInt(req.params.id);

  const [invRows] = await db.execute(`
    SELECT * FROM guild_invites WHERE id=? AND invitee_id=?
  `,[inviteId, pid]) as any;

  const invite = invRows[0];
  if (!invite) return res.send("Invalid invite.");

  await db.execute(`
    INSERT INTO guild_members (guild_id, player_id, guild_rank)
    VALUES (?, ?, 'Member')
  `,[invite.guild_id, pid]);

  // Remove all invites after joining
  await db.execute("DELETE FROM guild_invites WHERE invitee_id=?", [pid]);

  res.redirect("/guild");
});

/* =======================
   DECLINE INVITE
======================= */
router.get("/guild/decline/:id", requireLogin, async (req,res)=>{
  const pid = req.session.playerId;
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
router.get("/guild/leave", requireLogin, async (req,res)=>{
  const pid = req.session.playerId;
  await db.execute("DELETE FROM guild_members WHERE player_id=?", [pid]);
  res.redirect("/");
});
/* =======================
   DELETE GUILD (MASTER ONLY)
======================= */
router.get("/guild/delete", requireLogin, async (req,res)=>{

  const pid = req.session.playerId;

  // Check ownership
  const [rows] = await db.execute(`
    SELECT gm.guild_id, g.owner_id, gm.guild_rank
    FROM guild_members gm
    JOIN guilds g ON g.id = gm.guild_id
    WHERE gm.player_id=?
  `,[pid]) as any;

  const member = rows[0];

  if (!member) return res.send("You are not in a guild.");
  if (member.guild_rank !== "Guild Master" && member.owner_id !== pid)
    return res.send("Only the Guild Master can delete the guild.");

  const guildId = member.guild_id;

  // ✅ Delete all related references FIRST (safe order)
  await db.execute("DELETE FROM guild_invites WHERE guild_id=?", [guildId]);
  await db.execute("DELETE FROM guild_members WHERE guild_id=?", [guildId]);

  // ✅ Delete actual guild
  await db.execute("DELETE FROM guilds WHERE id=?", [guildId]);

  res.redirect("/");
});

export default router;
