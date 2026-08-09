import { db } from "./db";
import type { Party } from "./party.types";

const PARTY_INVITE_MINUTES = 10;
const DEFAULT_PARTY_SIZE = 4;

/**
 * Promise wrapper around the project's callback-style db.query().
 *
 * If your db.ts already exposes db.promise(), we can simplify this later.
 */
async function query<T = any>(
  sql: string,
  params: any[] = []
): Promise<T> {
  const [rows] = await db.query(sql, params);
  return rows as T;
}

/* =========================================================
   GET PLAYER PARTY
========================================================= */

export async function getPlayerPartyId(
  playerId: number
): Promise<number | null> {
  const rows: any[] = await query(
    `
      SELECT party_id
      FROM party_members
      WHERE player_id = ?
      LIMIT 1
    `,
    [playerId]
  );

  if (!rows.length) {
    return null;
  }

  return Number(rows[0].party_id);
}

/* =========================================================
   GET FULL PARTY
========================================================= */

export async function getParty(
  partyId: number
): Promise<Party | null> {
  const partyRows: any[] = await query(
    `
      SELECT
        id,
        leader_player_id,
        status,
        max_members,
        created_at
      FROM parties
      WHERE id = ?
        AND status = 'active'
      LIMIT 1
    `,
    [partyId]
  );

  if (!partyRows.length) {
    return null;
  }

  const partyRow = partyRows[0];

  const memberRows: any[] = await query(
    `
      SELECT
        pm.player_id,
        pm.role,
        pm.joined_at,

        p.name,
        p.level,
        p.pclass,
        p.hpoints,
        p.maxhp,
        p.spoints,
        p.maxspoints

      FROM party_members pm

      JOIN players p
        ON p.id = pm.player_id

      WHERE pm.party_id = ?

      ORDER BY
        CASE
          WHEN pm.player_id = ? THEN 0
          ELSE 1
        END,
        pm.joined_at ASC
    `,
    [
      partyId,
      partyRow.leader_player_id
    ]
  );

  return {
    id: Number(partyRow.id),

    leaderPlayerId: Number(
      partyRow.leader_player_id
    ),

    status: String(partyRow.status),

    maxMembers: Number(
      partyRow.max_members
    ),

    createdAt: partyRow.created_at,

    members: memberRows.map(row => ({
      playerId: Number(row.player_id),

      name: String(row.name),

      level: Number(row.level),

      className: String(row.pclass),

      role: row.role ?? null,

      hpoints: Number(row.hpoints),
      maxhp: Number(row.maxhp),

      spoints: Number(row.spoints),
      maxspoints: Number(row.maxspoints),

      joinedAt: row.joined_at,

      isLeader:
        Number(row.player_id) ===
        Number(partyRow.leader_player_id)
    }))
  };
}

/* =========================================================
   GET PARTY BY PLAYER
========================================================= */

export async function getPartyByPlayer(
  playerId: number
): Promise<Party | null> {
  const partyId =
    await getPlayerPartyId(playerId);

  if (!partyId) {
    return null;
  }

  return getParty(partyId);
}

/* =========================================================
   CREATE PARTY
========================================================= */

export async function createParty(
  playerId: number
): Promise<Party> {

  const existingParty =
    await getPlayerPartyId(playerId);

  if (existingParty) {
    throw new Error(
      "You are already in a party."
    );
  }

  const result: any = await query(
    `
      INSERT INTO parties (
        leader_player_id,
        status,
        max_members
      )
      VALUES (?, 'active', ?)
    `,
    [
      playerId,
      DEFAULT_PARTY_SIZE
    ]
  );

  const partyId =
    Number(result.insertId);

  await query(
    `
      INSERT INTO party_members (
        party_id,
        player_id
      )
      VALUES (?, ?)
    `,
    [
      partyId,
      playerId
    ]
  );

  const party =
    await getParty(partyId);

  if (!party) {
    throw new Error(
      "Party creation failed."
    );
  }

  return party;
}

/* =========================================================
   CHECK LEADER
========================================================= */

export async function isPartyLeader(
  partyId: number,
  playerId: number
): Promise<boolean> {

  const rows: any[] = await query(
    `
      SELECT id
      FROM parties
      WHERE id = ?
        AND leader_player_id = ?
        AND status = 'active'
      LIMIT 1
    `,
    [
      partyId,
      playerId
    ]
  );

  return rows.length > 0;
}

/* =========================================================
   PARTY MEMBER COUNT
========================================================= */

export async function getPartyMemberCount(
  partyId: number
): Promise<number> {

  const rows: any[] = await query(
    `
      SELECT COUNT(*) AS total
      FROM party_members
      WHERE party_id = ?
    `,
    [partyId]
  );

  return Number(rows[0]?.total || 0);
}

/* =========================================================
   INVITE PLAYER
========================================================= */

export async function invitePlayer(
  inviterPlayerId: number,
  invitedPlayerId: number
) {

  if (
    inviterPlayerId === invitedPlayerId
  ) {
    throw new Error(
      "You cannot invite yourself."
    );
  }

  let partyId =
    await getPlayerPartyId(
      inviterPlayerId
    );

  /*
   * Inviting while solo automatically
   * creates a party.
   */
  if (!partyId) {
    const newParty =
      await createParty(
        inviterPlayerId
      );

    partyId = newParty.id;
  }

  const leader =
    await isPartyLeader(
      partyId,
      inviterPlayerId
    );

  if (!leader) {
    throw new Error(
      "Only the party leader can invite players."
    );
  }

  const targetParty =
    await getPlayerPartyId(
      invitedPlayerId
    );

  if (targetParty) {
    throw new Error(
      "That player is already in a party."
    );
  }

  const party =
    await getParty(partyId);

  if (!party) {
    throw new Error(
      "Party not found."
    );
  }

  if (
    party.members.length >=
    party.maxMembers
  ) {
    throw new Error(
      "The party is full."
    );
  }

  /*
   * Remove stale / previous pending
   * invitations between these players.
   */
  await query(
    `
      UPDATE party_invites
      SET status = 'expired'
      WHERE invited_player_id = ?
        AND status = 'pending'
        AND expires_at <= NOW()
    `,
    [invitedPlayerId]
  );

  const existing: any[] =
    await query(
      `
        SELECT id
        FROM party_invites
        WHERE party_id = ?
          AND invited_player_id = ?
          AND status = 'pending'
          AND expires_at > NOW()
        LIMIT 1
      `,
      [
        partyId,
        invitedPlayerId
      ]
    );

  if (existing.length) {
    throw new Error(
      "That player already has a pending invitation."
    );
  }

  const result: any = await query(
    `
      INSERT INTO party_invites (
        party_id,
        inviter_player_id,
        invited_player_id,
        expires_at
      )
      VALUES (
        ?,
        ?,
        ?,
        DATE_ADD(
          NOW(),
          INTERVAL ? MINUTE
        )
      )
    `,
    [
      partyId,
      inviterPlayerId,
      invitedPlayerId,
      PARTY_INVITE_MINUTES
    ]
  );

  return {
    inviteId:
      Number(result.insertId),

    partyId
  };
}

/* =========================================================
   GET PLAYER INVITES
========================================================= */

export async function getPendingInvites(
  playerId: number
) {

  await query(
    `
      UPDATE party_invites
      SET status = 'expired'
      WHERE invited_player_id = ?
        AND status = 'pending'
        AND expires_at <= NOW()
    `,
    [playerId]
  );

  return query<any[]>(
    `
      SELECT
        pi.id,
        pi.party_id,
        pi.inviter_player_id,
        pi.created_at,
        pi.expires_at,

        p.name AS inviter_name,
        p.level AS inviter_level,
        p.pclass AS inviter_class

      FROM party_invites pi

      JOIN players p
        ON p.id =
           pi.inviter_player_id

      WHERE
        pi.invited_player_id = ?
        AND pi.status = 'pending'
        AND pi.expires_at > NOW()

      ORDER BY pi.created_at DESC
    `,
    [playerId]
  );
}

/* =========================================================
   ACCEPT INVITE
========================================================= */

export async function acceptInvite(
  inviteId: number,
  playerId: number
): Promise<Party> {

  const invites: any[] =
    await query(
      `
        SELECT
          id,
          party_id,
          invited_player_id,
          status,
          expires_at
        FROM party_invites
        WHERE id = ?
        LIMIT 1
      `,
      [inviteId]
    );

  if (!invites.length) {
    throw new Error(
      "Party invitation not found."
    );
  }

  const invite = invites[0];

  if (
    Number(invite.invited_player_id) !==
    playerId
  ) {
    throw new Error(
      "This invitation does not belong to you."
    );
  }

  if (
    invite.status !== "pending"
  ) {
    throw new Error(
      "This invitation is no longer active."
    );
  }

  const expiredRows: any[] =
    await query(
      `
        SELECT
          expires_at <= NOW() AS expired
        FROM party_invites
        WHERE id = ?
      `,
      [inviteId]
    );

  if (
    Number(expiredRows[0]?.expired) === 1
  ) {
    await query(
      `
        UPDATE party_invites
        SET status = 'expired'
        WHERE id = ?
      `,
      [inviteId]
    );

    throw new Error(
      "This invitation has expired."
    );
  }

  const existingParty =
    await getPlayerPartyId(
      playerId
    );

  if (existingParty) {
    throw new Error(
      "You are already in a party."
    );
  }

  const party =
    await getParty(
      Number(invite.party_id)
    );

  if (!party) {
    throw new Error(
      "That party no longer exists."
    );
  }

  if (
    party.members.length >=
    party.maxMembers
  ) {
    throw new Error(
      "That party is already full."
    );
  }

  await query(
    `
      INSERT INTO party_members (
        party_id,
        player_id
      )
      VALUES (?, ?)
    `,
    [
      party.id,
      playerId
    ]
  );

  await query(
    `
      UPDATE party_invites
      SET status = 'accepted'
      WHERE id = ?
    `,
    [inviteId]
  );

  /*
   * Cancel the player's other
   * pending invitations.
   */
  await query(
    `
      UPDATE party_invites
      SET status = 'declined'
      WHERE invited_player_id = ?
        AND id <> ?
        AND status = 'pending'
    `,
    [
      playerId,
      inviteId
    ]
  );

  const updated =
    await getParty(party.id);

  if (!updated) {
    throw new Error(
      "Failed to load party."
    );
  }

  return updated;
}

/* =========================================================
   DECLINE INVITE
========================================================= */

export async function declineInvite(
  inviteId: number,
  playerId: number
) {

  const result: any =
    await query(
      `
        UPDATE party_invites
        SET status = 'declined'
        WHERE id = ?
          AND invited_player_id = ?
          AND status = 'pending'
      `,
      [
        inviteId,
        playerId
      ]
    );

  if (!result.affectedRows) {
    throw new Error(
      "Party invitation not found."
    );
  }
}

/* =========================================================
   DISBAND PARTY
========================================================= */

export async function disbandParty(
  partyId: number,
  leaderPlayerId: number
) {

  const leader =
    await isPartyLeader(
      partyId,
      leaderPlayerId
    );

  if (!leader) {
    throw new Error(
      "Only the party leader can disband the party."
    );
  }

  /*
   * Remove all invites tied to the party.
   */
  await query(
    `
      DELETE FROM party_invites
      WHERE party_id = ?
    `,
    [partyId]
  );

  /*
   * Remove all party members.
   */
  await query(
    `
      DELETE FROM party_members
      WHERE party_id = ?
    `,
    [partyId]
  );

  /*
   * Finally remove the party itself.
   */
  await query(
    `
      DELETE FROM parties
      WHERE id = ?
    `,
    [partyId]
  );
}

/* =========================================================
   LEAVE PARTY
========================================================= */

export async function leaveParty(
  playerId: number
) {

  const party =
    await getPartyByPlayer(
      playerId
    );

  if (!party) {
    throw new Error(
      "You are not in a party."
    );
  }

  /*
   * If solo, just disband.
   */
  if (
    party.members.length <= 1
  ) {
    await disbandParty(
      party.id,
      playerId
    );

    return {
      disbanded: true
    };
  }

  const isLeader =
    party.leaderPlayerId ===
    playerId;

  /*
   * Remove the leaving member.
   */
  await query(
    `
      DELETE FROM party_members
      WHERE party_id = ?
        AND player_id = ?
    `,
    [
      party.id,
      playerId
    ]
  );

  /*
   * Leader leaving:
   * oldest remaining member becomes
   * the new leader.
   */
  if (isLeader) {

    const remaining: any[] =
      await query(
        `
          SELECT player_id
          FROM party_members
          WHERE party_id = ?
          ORDER BY joined_at ASC
          LIMIT 1
        `,
        [party.id]
      );

    if (remaining.length) {
      await query(
        `
          UPDATE parties
          SET leader_player_id = ?
          WHERE id = ?
        `,
        [
          remaining[0].player_id,
          party.id
        ]
      );
    }
  }

  return {
    disbanded: false
  };
}

/* =========================================================
   KICK PLAYER
========================================================= */

export async function kickPlayer(
  leaderPlayerId: number,
  targetPlayerId: number
) {

  const party =
    await getPartyByPlayer(
      leaderPlayerId
    );

  if (!party) {
    throw new Error(
      "You are not in a party."
    );
  }

  if (
    party.leaderPlayerId !==
    leaderPlayerId
  ) {
    throw new Error(
      "Only the party leader can remove members."
    );
  }

  if (
    targetPlayerId === leaderPlayerId
  ) {
    throw new Error(
      "Use Leave Party instead."
    );
  }

  const target =
    party.members.find(
      member =>
        member.playerId ===
        targetPlayerId
    );

  if (!target) {
    throw new Error(
      "That player is not in your party."
    );
  }

  await query(
    `
      DELETE FROM party_members
      WHERE party_id = ?
        AND player_id = ?
    `,
    [
      party.id,
      targetPlayerId
    ]
  );
}

/* =========================================================
   PROMOTE LEADER
========================================================= */

export async function promoteLeader(
  currentLeaderId: number,
  targetPlayerId: number
) {

  const party =
    await getPartyByPlayer(
      currentLeaderId
    );

  if (!party) {
    throw new Error(
      "You are not in a party."
    );
  }

  if (
    party.leaderPlayerId !==
    currentLeaderId
  ) {
    throw new Error(
      "Only the party leader can promote another member."
    );
  }

  const member =
    party.members.find(
      member =>
        member.playerId ===
        targetPlayerId
    );

  if (!member) {
    throw new Error(
      "That player is not in your party."
    );
  }

  await query(
    `
      UPDATE parties
      SET leader_player_id = ?
      WHERE id = ?
    `,
    [
      targetPlayerId,
      party.id
    ]
  );
}

/* =========================================================
   PLAYER SEARCH
========================================================= */
export async function searchPartyPlayers(
  currentPlayerId: number,
  search: string
) {
  const term = String(search || "").trim();

  if (term.length < 2) {
    return [];
  }

  return query<any[]>(
    `
      SELECT
        p.id,
        p.name,
        p.level,
        p.pclass,
        p.location,

        CASE
          WHEN pm.player_id IS NULL THEN 0
          ELSE 1
        END AS in_party

      FROM players p

      LEFT JOIN party_members pm
        ON pm.player_id = p.id

      WHERE p.id <> ?
        AND p.name LIKE ?

      ORDER BY
        p.name ASC

      LIMIT 10
    `,
    [
      currentPlayerId,
      `%${term}%`
    ]
  );
}