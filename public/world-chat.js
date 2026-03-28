console.log("✅ world-chat.js loaded");

const chatLog = document.getElementById("chatLog");
const chatInput = document.getElementById("chatInput");
const chatSend = document.getElementById("chatSend");

// If we're not on a page with chat, quietly do nothing.
if (!chatLog || !chatInput) {
  console.warn("⚠️ world-chat.js: chat DOM not found, skipping init");
} else {
  async function loadChat() {
    try {
      const r = await fetch("/api/chat/world", { credentials: "include" });
      if (!r.ok) return;

      const data = await r.json();
      chatLog.innerHTML = "";

      (data || []).forEach(msg => {
        const div = document.createElement("div");
        div.className = "chatLine";
        div.innerHTML =
          `<span class="chatName">${escapeHtml(msg.player_name)}:</span>` +
          `<span class="chatMsg"> ${escapeHtml(msg.message)}</span>`;
        chatLog.appendChild(div);
      });

      chatLog.scrollTop = chatLog.scrollHeight;
    } catch (e) {
      console.error("chat load failed", e);
    }
  }

  async function sendChat() {
    const text = chatInput.value.trim();
    if (!text) return;

    try {
      const r = await fetch("/api/chat/world", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text })
      });

      if (!r.ok) return;

      chatInput.value = "";
      chatInput.focus();
      loadChat();
    } catch (e) {
      console.error("chat send failed", e);
    }
  }

  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendChat();
  });

  if (chatSend) {
    chatSend.addEventListener("click", sendChat);
  }

  function escapeHtml(text) {
    return String(text || "").replace(/[&<>"']/g, m =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[m])
    );
  }

  setInterval(loadChat, 2000);
  loadChat();
}
