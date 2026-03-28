const form = document.getElementById("questForm");

if (form) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const data = Object.fromEntries(new FormData(form));

    const res = await fetch("/admin/api/quests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    });

    const json = await res.json();

    if (json.ok) {
      window.location = `/admin/quests/${json.id}/objectives`;
    } else {
      alert(json.error || "Failed to create quest");
    }
  });
}