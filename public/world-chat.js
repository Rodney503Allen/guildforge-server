console.log("✅ world-chat.js loaded");

const chatLog = document.getElementById("chatLog");
const chatInput = document.getElementById("chatInput");

if (!chatLog || !chatInput) {
  console.error("❌ Chat elements not found in DOM");
}

async function loadChat() {
  const r = await fetch("/api/chat/world");
  const data = await r.json();

  chatLog.innerHTML = "";

  data.forEach(msg => {
    const div = document.createElement("div");
    div.className = "chatLine";
    div.innerHTML =
      `<span class="chatName">${msg.player_name}:</span> ${escapeHtml(msg.message)}`;
    chatLog.appendChild(div);
  });

  chatLog.scrollTop = chatLog.scrollHeight;
}

chatInput.addEventListener("keydown", async e => {
  if (e.key === "Enter") {
    const text = chatInput.value.trim();
    if (!text) return;

    await fetch("/api/chat/world", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text })
    });

    chatInput.value = "";
    loadChat();
  }
});

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, m =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;', "'":'&#039;'}[m])
  );
}

// Auto-refresh every 2 seconds
setInterval(loadChat, 2000);

// Initial load
loadChat();
