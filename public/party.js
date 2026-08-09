let currentParty = null;
let searchTimer = null;
let currentPlayerId = null;


/* =========================================
   ELEMENTS
========================================= */

const summaryEl =
  document.getElementById(
    "party-summary"
  );

const emptyEl =
  document.getElementById(
    "party-empty"
  );

const rosterEl =
  document.getElementById(
    "party-roster"
  );

const invitesSection =
  document.getElementById(
    "party-invites-section"
  );

const invitesEl =
  document.getElementById(
    "party-invites"
  );

const invitePanel =
  document.getElementById(
    "invite-panel"
  );

const actionsPanel =
  document.getElementById(
    "party-actions"
  );

const ledgerEl =
  document.getElementById(
    "party-ledger"
  );

const searchInput =
  document.getElementById(
    "party-player-search"
  );

const searchResults =
  document.getElementById(
    "party-search-results"
  );

const createPartyBtn =
  document.getElementById(
    "create-party-btn"
  );

const leavePartyBtn =
  document.getElementById(
    "leave-party-btn"
  );

const disbandPartyBtn =
  document.getElementById(
    "disband-party-btn"
  );


/* =========================================
   ESCAPE HTML
========================================= */

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}


/* =========================================
   FETCH HELPER
========================================= */

async function api(
  url,
  options = {}
) {

  const response =
    await fetch(
      url,
      {
        headers: {
          "Content-Type":
            "application/json",

          ...(options.headers || {})
        },

        ...options
      }
    );

  const data =
    await response.json();

  if (
    !response.ok ||
    data.ok === false
  ) {
    throw new Error(
      data.error ||
      "Something went wrong."
    );
  }

  return data;
}


/* =========================================
   LOAD PAGE
========================================= */

async function loadPartyPage() {
  try {

    const [
      partyResponse,
      inviteResponse
    ] = await Promise.all([
      api("/party"),
      api("/party/invites")
    ]);

    currentPlayerId =
      Number(
        partyResponse.currentPlayerId
      );

    currentParty =
      partyResponse.party;

    renderParty();

    renderInvites(
      inviteResponse.invites || []
    );

  } catch (err) {

    console.error(
      "Party page failed:",
      err
    );

  }
}


/* =========================================
   PARTY RENDER
========================================= */

function renderParty() {

  if (!currentParty) {

    summaryEl.innerHTML = `
      <span class="summary-chip">
        No Active Party
      </span>
    `;

    emptyEl.classList.remove(
      "hidden"
    );

    rosterEl.innerHTML = "";

    invitePanel.classList.add(
      "hidden"
    );

    actionsPanel.classList.add(
      "hidden"
    );

    ledgerEl.innerHTML = `
      <div class="ledger-empty">
        No company has been formed.
      </div>
    `;

    return;
  }

  const isLeader =
    currentParty.leaderPlayerId ===
    currentPlayerId;

  emptyEl.classList.add(
    "hidden"
  );

  actionsPanel.classList.remove(
    "hidden"
  );

  const leader =
    currentParty.members.find(
      m => m.isLeader
    );

  summaryEl.innerHTML = `
    <span class="summary-chip">
      👑 ${esc(
        leader?.name ||
        "Unknown"
      )}
    </span>

    <span class="summary-chip">
      Members:
      ${currentParty.members.length}
      /
      ${currentParty.maxMembers}
    </span>
  `;

  rosterEl.innerHTML =
    currentParty.members
      .map(member =>
        renderMember(
          member,
          isLeader
        )
      )
      .join("");

  invitePanel.classList.toggle(
    "hidden",
    !isLeader
  );

  renderLedger();

  disbandPartyBtn.classList.toggle(
    "hidden",
    !isLeader
  );
}


/* =========================================
   MEMBER CARD
========================================= */

function renderMember(
  member,
  viewerIsLeader
) {

  const hpPercent =
    member.maxhp > 0
      ? Math.max(
          0,
          Math.min(
            100,
            (
              member.hpoints /
              member.maxhp
            ) * 100
          )
        )
      : 0;


  const spPercent =
    member.maxspoints > 0
      ? Math.max(
          0,
          Math.min(
            100,
            (
              member.spoints /
              member.maxspoints
            ) * 100
          )
        )
      : 0;


  return `
    <article
      class="
        party-member
        ${member.isLeader
          ? "is-leader"
          : ""}
      "
    >

      <div class="member-top">

        <div class="member-name-wrap">

          <h3 class="member-name">
            ${esc(member.name)}
          </h3>

          <div class="member-class">
            ${esc(member.className)}
            •
            Level ${member.level}
          </div>

        </div>

        ${
          member.isLeader
            ? `
              <div class="leader-badge">
                👑 Leader
              </div>
            `
            : ""
        }

      </div>


      <div class="member-bars">

        <div class="member-stat">

          <label>HP</label>

          <div class="stat-track">
            <div
              class="
                stat-fill
                hp-fill
              "
              style="
                width:${hpPercent}%
              "
            ></div>
          </div>

          <div class="member-stat-value">
            ${member.hpoints}
            /
            ${member.maxhp}
          </div>

        </div>


        <div class="member-stat">

          <label>SP</label>

          <div class="stat-track">
            <div
              class="
                stat-fill
                sp-fill
              "
              style="
                width:${spPercent}%
              "
            ></div>
          </div>

          <div class="member-stat-value">
            ${member.spoints}
            /
            ${member.maxspoints}
          </div>

        </div>

      </div>


${
  viewerIsLeader &&
  !member.isLeader
    ? `
      <div class="member-actions">

        <button
          class="member-action-btn"
          onclick="
            promoteMember(
              ${member.playerId}
            )
          "
        >
          Promote
        </button>

        <button
          class="
            member-action-btn
            remove
          "
          onclick="
            kickMember(
              ${member.playerId}
            )
          "
        >
          Remove
        </button>

      </div>
    `
    : ""
}

    </article>
  `;
}


/* =========================================
   LEDGER
========================================= */

function renderLedger() {

  if (!currentParty) {
    return;
  }

  const lines =
    currentParty.members.map(
      member => `
        <div class="ledger-line">

          ${
            member.isLeader
              ? "👑"
              : "⚔"
          }

          ${esc(member.name)}

          —

          ${esc(member.className)}

          Level ${member.level}

        </div>
      `
    );

  ledgerEl.innerHTML =
    lines.join("");
}


/* =========================================
   INVITES
========================================= */

function renderInvites(invites) {

  if (!invites.length) {

    invitesSection.classList.add(
      "hidden"
    );

    invitesEl.innerHTML = "";

    return;
  }


  invitesSection.classList.remove(
    "hidden"
  );


  invitesEl.innerHTML =
    invites
      .map(invite => `
        <article class="invite-card">

          <h3>
            ${esc(
              invite.inviter_name
            )}
          </h3>

          <p>
            ${
              esc(
                invite.inviter_class
              )
            }

            •

            Level ${
              invite.inviter_level
            }

            has invited you
            to join their party.
          </p>

          <div class="invite-actions">

            <button
              class="
                invite-btn
                button-frame
              "
              onclick="
                acceptInvite(
                  ${invite.id}
                )
              "
            >
              Accept
            </button>

            <button
              class="
                secondary-btn
                button-frame
              "
              onclick="
                declineInvite(
                  ${invite.id}
                )
              "
            >
              Decline
            </button>

          </div>

        </article>
      `)
      .join("");
}


/* =========================================
   CREATE PARTY
========================================= */

createPartyBtn?.addEventListener(
  "click",
  async () => {

    try {

      await api(
        "/party/create",
        {
          method:"POST"
        }
      );

      await loadPartyPage();

    } catch (err) {

      alert(err.message);

    }

  }
);


/* =========================================
   ACCEPT INVITE
========================================= */

async function acceptInvite(
  inviteId
) {
  try {

    await api(
      `/party/invites/${inviteId}/accept`,
      {
        method:"POST"
      }
    );

    await loadPartyPage();

  } catch (err) {

    alert(err.message);

  }
}


/* =========================================
   DECLINE INVITE
========================================= */

async function declineInvite(
  inviteId
) {

  try {

    await api(
      `/party/invites/${inviteId}/decline`,
      {
        method:"POST"
      }
    );

    await loadPartyPage();

  } catch (err) {

    alert(err.message);

  }

}


/* =========================================
   LEAVE PARTY
========================================= */

leavePartyBtn?.addEventListener(
  "click",
  async () => {

    if (
      !confirm(
        "Leave your current party?"
      )
    ) {
      return;
    }

    try {

      await api(
        "/party/leave",
        {
          method:"POST"
        }
      );

      currentParty = null;

      await loadPartyPage();

    } catch (err) {

      alert(err.message);

    }

  }
);


/* =========================================
   DISBAND PARTY
========================================= */

disbandPartyBtn?.addEventListener(
  "click",
  async () => {

    if (
      !confirm(
        "Disband the entire party?"
      )
    ) {
      return;
    }

    try {

      await api(
        "/party/disband",
        {
          method:"POST"
        }
      );

      currentParty = null;

      await loadPartyPage();

    } catch (err) {

      alert(err.message);

    }

  }
);


/* =========================================
   PROMOTE MEMBER
========================================= */

async function promoteMember(
  playerId
) {

  if (
    !confirm(
      "Promote this player to party leader?"
    )
  ) {
    return;
  }

  try {

    await api(
      "/party/promote",
      {
        method:"POST",

        body:JSON.stringify({
          playerId
        })
      }
    );

    await loadPartyPage();

  } catch (err) {

    alert(err.message);

  }

}


/* =========================================
   KICK MEMBER
========================================= */

async function kickMember(
  playerId
) {

  if (
    !confirm(
      "Remove this player from the party?"
    )
  ) {
    return;
  }

  try {

    await api(
      "/party/kick",
      {
        method:"POST",

        body:JSON.stringify({
          playerId
        })
      }
    );

    await loadPartyPage();

  } catch (err) {

    alert(err.message);

  }

}


/* =========================================
   PLAYER SEARCH
========================================= */

searchInput?.addEventListener(
  "input",
  () => {

    clearTimeout(
      searchTimer
    );

    const value =
      searchInput.value.trim();


    if (value.length < 2) {

      searchResults.innerHTML = `
        <div class="search-hint">
          Enter at least two characters.
        </div>
      `;

      return;
    }


    searchTimer =
      setTimeout(
        () => searchPlayers(value),
        250
      );

  }
);


async function searchPlayers(
  value
) {

  try {

    const data =
      await api(
        `/party/player-search?q=${
          encodeURIComponent(value)
        }`
      );


    if (!data.players.length) {

      searchResults.innerHTML = `
        <div class="search-hint">
          No adventurers found.
        </div>
      `;

      return;
    }


    searchResults.innerHTML =
      data.players
        .map(player => `

          <div class="search-player">

            <div>

              <strong>
                ${esc(player.name)}
              </strong>

              <span>
                ${esc(player.pclass)}
                •
                Level ${player.level}

                ${
                  player.location
                    ? ` • ${esc(
                        player.location
                      )}`
                    : ""
                }
              </span>

            </div>

            ${
              Number(
                player.in_party
              )
                ? `
                  <button
                    class="
                      secondary-btn
                      button-frame
                    "
                    disabled
                  >
                    In Party
                  </button>
                `
                : `
                  <button
                    class="
                      invite-btn
                      button-frame
                    "
                    onclick="
                      invitePlayer(
                        ${player.id}
                      )
                    "
                  >
                    Invite
                  </button>
                `
            }

          </div>

        `)
        .join("");

  } catch (err) {

    console.error(err);

  }

}


/* =========================================
   INVITE PLAYER
========================================= */

async function invitePlayer(
  playerId
) {

  try {

    await api(
      "/party/invite",
      {
        method:"POST",

        body:JSON.stringify({
          playerId
        })
      }
    );

    alert(
      "Party invitation sent."
    );

  } catch (err) {

    alert(err.message);

  }

}


/* =========================================
   INITIAL LOAD
========================================= */

loadPartyPage();