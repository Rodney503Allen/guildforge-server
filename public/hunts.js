let currentParty = null;
let currentPlayerId = null;
let currentActiveHunt = null;


/* =========================================
   ESCAPE HTML
========================================= */

function escHunt(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}


/* =========================================
   API
========================================= */

async function huntApi(
  url,
  options = {}
) {

  const response =
    await fetch(
      url,
      {
        headers:{
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

async function loadHuntsPage() {

  try {

    const [
      huntsData,
      activeData,
      partyData
    ] =
      await Promise.all([
        huntApi("/hunts"),
        huntApi("/hunts/active"),
        huntApi("/party")
      ]);


    currentParty =
      partyData.party;

    currentPlayerId =
      Number(
        partyData.currentPlayerId
      );

    currentActiveHunt =
      activeData.hunt;


    renderPartySummary();

    renderHuntList(
      huntsData.hunts || []
    );

    renderActiveHunt();


  } catch (err) {

    console.error(
      "Failed to load Hunt Board:",
      err
    );


    const list =
      document.getElementById(
        "hunt-list"
      );

    if (list) {
      list.innerHTML = `
        <div class="hunt-list-empty">
          The Hunt Board is currently unavailable.
        </div>
      `;
    }

  }

}


/* =========================================
   PARTY SUMMARY
========================================= */

function renderPartySummary() {

  const summary =
    document.getElementById(
      "hunt-party-summary"
    );


  if (!summary) {
    return;
  }


  if (!currentParty) {

    summary.textContent =
      "No active party";

    return;
  }


  const isLeader =
    Number(
      currentParty.leaderPlayerId
    ) ===
    currentPlayerId;


  summary.textContent =
    `${currentParty.members.length} / ${currentParty.maxMembers} Adventurers · ${
      isLeader
        ? "You are Party Leader"
        : "Party Member"
    }`;
}


/* =========================================
   AVAILABLE HUNTS
========================================= */

function renderHuntList(
  hunts
) {

  const list =
    document.getElementById(
      "hunt-list"
    );

  const count =
    document.getElementById(
      "available-hunt-count"
    );


  if (!list) {
    return;
  }


  if (count) {
    count.textContent =
      String(hunts.length);
  }


  if (!hunts.length) {

    list.innerHTML = `
      <div class="hunt-list-empty">
        No Hunt contracts are currently posted.
      </div>
    `;

    return;
  }


  const isLeader =
    !!currentParty &&
    Number(
      currentParty.leaderPlayerId
    ) ===
    currentPlayerId;


  list.innerHTML =
    hunts.map(hunt => {

      let disabledReason = "";


      if (!currentParty) {

        disabledReason =
          "Form a party before accepting a Hunt.";

      } else if (!isLeader) {

        disabledReason =
          "Only the party leader may accept a Hunt.";

      } else if (
        currentActiveHunt
      ) {

        disabledReason =
          "Your party already has an active Hunt.";

      }


      const difficulty =
        "★".repeat(
          Math.max(
            1,
            Number(
              hunt.difficulty
            ) || 1
          )
        );


      return `
        <article class="hunt-card">

          <div class="hunt-card__head">

            <div class="hunt-title">

              <h3>
                ${escHunt(
                  hunt.name
                )}
              </h3>

              <p>
                ${escHunt(
                  hunt.description ||
                  hunt.flavorText ||
                  ""
                )}
              </p>

            </div>


            <div
              class="hunt-stars"
              title="Difficulty"
            >
              ${difficulty}
            </div>

          </div>


          <div class="hunt-meta">

            <span class="hunt-chip">
              Level
              ${hunt.recommendedLevel}+
            </span>

            <span class="hunt-chip">
              Party
              ${hunt.recommendedPartySize}
            </span>

            <span class="hunt-chip">
              Tracking
              ${hunt.trackingRequired}
            </span>

          </div>


          <div class="hunt-rewards">

            <div class="hunt-rewards-label">
              Contract Rewards
            </div>

            <div class="hunt-reward-list">

              <span>
                ${hunt.rewardXp} XP
              </span>

              <span>
                ${hunt.rewardGold} Gold
              </span>

              <span>
                ${hunt.rewardHuntMarks} Hunt Marks
              </span>

            </div>

          </div>


          <div class="hunt-card__footer">

            <span class="hunt-warning">
              ${
                disabledReason
                  ? escHunt(
                      disabledReason
                    )
                  : `Recommended for ${hunt.recommendedPartySize} adventurers.`
              }
            </span>


            <button
              class="hunt-accept-btn"
              type="button"
              ${
                disabledReason
                  ? "disabled"
                  : ""
              }
              onclick="
                acceptHunt(
                  ${hunt.id}
                )
              "
            >
              ${
                disabledReason
                  ? "Unavailable"
                  : "Accept Hunt"
              }
            </button>

          </div>

        </article>
      `;

    }).join("");

}


/* =========================================
   ACTIVE HUNT
========================================= */

function renderActiveHunt() {

  const root =
    document.getElementById(
      "active-hunt"
    );


  if (!root) {
    return;
  }


  if (!currentActiveHunt) {

    root.innerHTML = `
      <div class="active-hunt-empty">

        <div class="active-hunt-empty__icon">
          🐾
        </div>

        <strong>
          No Active Hunt
        </strong>

        <p>
          No quarry currently bears your
          party's mark. Choose a contract
          from the Hunt Board to begin
          the pursuit.
        </p>

      </div>
    `;

    return;
  }


  const hunt =
    currentActiveHunt;


  const isLeader =
    !!currentParty &&
    Number(
      currentParty.leaderPlayerId
    ) ===
    currentPlayerId;


  const progressPercent =
    hunt.trackingRequired > 0
      ? Math.max(
          0,
          Math.min(
            100,
            (
              hunt.trackingProgress /
              hunt.trackingRequired
            ) * 100
          )
        )
      : 0;


  const objectives =
    (hunt.objectives || [])
      .map(objective => {

        return `
          <div
            class="
              hunt-objective
              ${
                objective.isComplete
                  ? "complete"
                  : ""
              }
            "
          >

            <span class="hunt-objective__state">
              ${
                objective.isComplete
                  ? "✓"
                  : "◇"
              }
            </span>

            <span>
              ${escHunt(
                objective.description
              )}
            </span>

            <span>
              ${objective.progressCount}
              /
              ${objective.requiredCount}
            </span>

          </div>
        `;

      })
      .join("");


  root.innerHTML = `
    <div class="active-hunt-card">

      <div class="active-hunt-kicker">
        Current Quarry
      </div>

      <h3>
        ${escHunt(
          hunt.hunt.name
        )}
      </h3>

      <div class="active-hunt-status">
        ${escHunt(
          hunt.status
        )}
      </div>


      <div class="hunt-progress">

        <div class="hunt-progress__top">

          <span>
            Tracking Progress
          </span>

          <span>
            ${hunt.trackingProgress}
            /
            ${hunt.trackingRequired}
          </span>

        </div>


        <div class="hunt-progress-track">

          <div
            class="hunt-progress-fill"
            style="
              width:${progressPercent}%
            "
          ></div>

        </div>

      </div>


      <div class="hunt-objectives">
        ${objectives}
      </div>


      ${
        isLeader
          ? `
            <button
              class="hunt-abandon"
              type="button"
              onclick="
                abandonHunt()
              "
            >
              Abandon Hunt
            </button>
          `
          : ""
      }

    </div>
  `;

}


/* =========================================
   ACCEPT
========================================= */

async function acceptHunt(
  huntId
) {

  try {

    await huntApi(
      `/hunts/${huntId}/accept`,
      {
        method:"POST"
      }
    );


    await loadHuntsPage();


  } catch (err) {

    alert(
      err.message
    );

  }

}


/* =========================================
   ABANDON
========================================= */

async function abandonHunt() {

  const confirmed =
    confirm(
      "Abandon your party's current Hunt?"
    );


  if (!confirmed) {
    return;
  }


  try {

    await huntApi(
      "/hunts/active/abandon",
      {
        method:"POST"
      }
    );


    await loadHuntsPage();


  } catch (err) {

    alert(
      err.message
    );

  }

}


/* =========================================
   START
========================================= */

loadHuntsPage();