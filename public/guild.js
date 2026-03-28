(() => {
  const $ = (id) => document.getElementById(id);

  // --- Modal helpers ---
  function openModal(modalId) {
    const m = $(modalId);
    if (m) m.classList.add("isOpen");
  }
  function closeModal(modalId) {
    const m = $(modalId);
    if (m) m.classList.remove("isOpen");
  }

  // Close on backdrop click
  document.addEventListener("click", (e) => {
    const modal = e.target && e.target.classList && e.target.classList.contains("modal") ? e.target : null;
    if (!modal) return;

    // If user clicked the backdrop (the modal itself), close it and reset delete timer if needed
    if (modal.id === "delete-guild-modal") resetDeleteCountdown();
    modal.classList.remove("isOpen");
  });

  // Close on ESC
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;

    // If delete modal is open, reset countdown before closing
    const delModal = $("delete-guild-modal");
    if (delModal && delModal.classList.contains("isOpen")) {
      resetDeleteCountdown();
    }

    document.querySelectorAll(".modal.isOpen").forEach((m) => m.classList.remove("isOpen"));
  });

  // --- Other modals (safe even if not present) ---
  $("open-contribute")?.addEventListener("click", () => openModal("contribute-modal"));
  $("open-perks")?.addEventListener("click", () => openModal("perks-modal"));
  $("open-log")?.addEventListener("click", () => openModal("log-modal"));

  $("edit-announcement")?.addEventListener("click", () => openModal("announcement-modal"));
  $("close-announcement")?.addEventListener("click", () => closeModal("announcement-modal"));

  $("save-announcement")?.addEventListener("click", async () => {
    const text = ($("announcement-text")?.value || "").trim();
    await fetch("/guild/announcement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    location.reload();
  });

  // Manage member modal
  let currentTargetPlayerId = null;

  document.querySelectorAll(".manage-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentTargetPlayerId = Number(btn.dataset.playerId || 0);
      $("manage-member-name").textContent = btn.dataset.player || "";
      $("manage-member-role").textContent = btn.dataset.role || "";
      openModal("manage-member-modal");
    });
  });

  $("close-manage-member")?.addEventListener("click", () => closeModal("manage-member-modal"));

  $("confirm-role-change")?.addEventListener("click", async () => {
    const roleId = Number($("manage-role-select")?.value || 0);
    if (!currentTargetPlayerId || !roleId) return;

    await fetch("/guild/member/role", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetPlayerId: currentTargetPlayerId, newRoleId: roleId }),
    });

    location.reload();
  });

  $("kick-member-btn")?.addEventListener("click", async () => {
    if (!currentTargetPlayerId) return;
    if (!confirm("Kick this member from the guild?")) return;

    await fetch("/guild/member/kick", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetPlayerId: currentTargetPlayerId }),
    });

    location.reload();
  });

  // Block owner leave
  const leaveLink = $("leave-guild-link");
  leaveLink?.addEventListener("click", (e) => {
    const isOwner = leaveLink.dataset.owner === "1";
    if (!isOwner) return;
    e.preventDefault();
    openModal("leave-blocked-modal");
  });
  $("close-leave-blocked")?.addEventListener("click", () => closeModal("leave-blocked-modal"));

  // =========================
  // DELETE GUILD CONFIRM (5s)
  // =========================
  const deleteLink = $("delete-guild-link");
  const deleteModal = $("delete-guild-modal");
  const cancelDeleteBtn = $("cancel-delete-guild");
  const closeDeleteBtn = $("close-delete-guild");
  const confirmDeleteBtn = $("confirm-delete-guild");
  const timerEl = $("delete-guild-timer");

  let deleteHref = "";
  let countdown = 5;
  let countdownTimer = null;

  function setTimerText() {
    if (timerEl) timerEl.textContent = String(Math.max(0, countdown));
  }

  function resetDeleteCountdown() {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
    countdown = 5;
    setTimerText();
    if (confirmDeleteBtn) confirmDeleteBtn.disabled = true;
  }

  function startDeleteCountdown() {
    resetDeleteCountdown();
    countdownTimer = setInterval(() => {
      countdown -= 1;
      setTimerText();

      if (countdown <= 0) {
        clearInterval(countdownTimer);
        countdownTimer = null;
        if (confirmDeleteBtn) confirmDeleteBtn.disabled = false;
      }
    }, 1000);
  }

  // If any required element is missing, we can’t safely intercept delete
  if (deleteLink && deleteModal && confirmDeleteBtn && cancelDeleteBtn && timerEl) {
    deleteLink.addEventListener("click", (e) => {
      // THIS is the critical line that stops instant deletion
      e.preventDefault();

      deleteHref = deleteLink.getAttribute("href") || "/guild/delete";
      openModal("delete-guild-modal");
      startDeleteCountdown();
    });

    cancelDeleteBtn.addEventListener("click", () => {
      resetDeleteCountdown();
      closeModal("delete-guild-modal");
    });

    closeDeleteBtn?.addEventListener("click", () => {
      resetDeleteCountdown();
      closeModal("delete-guild-modal");
    });

    confirmDeleteBtn.addEventListener("click", () => {
      if (confirmDeleteBtn.disabled) return;
      window.location.href = deleteHref || "/guild/delete";
    });

    // Ensure disabled + timer set on load
    resetDeleteCountdown();
  } else {
    // If you're still seeing instant delete, check console for this.
    // It means your IDs/markup don’t match the script.
    console.warn("[guild.js] Delete confirmation wiring missing. Check IDs: delete-guild-link, delete-guild-modal, cancel-delete-guild, confirm-delete-guild, delete-guild-timer.");
  }
})();
