const form = document.getElementById("itemForm");
const out = document.getElementById("out");
const btnPreview = document.getElementById("btnPreview");

function formToJSON(f){
  const fd = new FormData(f);
  const o = {};
  for (const [k,v] of fd.entries()) o[k] = v;
  // normalize numeric fields client-side (server still validates)
  const nums = ["attack","defense","agility","vitality","intellect","crit","value","effect_value","is_combat"];
  for (const k of nums) o[k] = Number(o[k] || 0);
  return o;
}

btnPreview?.addEventListener("click", () => {
  const payload = formToJSON(form);
  out.hidden = false;
  out.textContent = JSON.stringify(payload, null, 2);
});

form?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = formToJSON(form);

  out.hidden = false;
  out.textContent = "Creating item…";

  const r = await fetch("/admin/api/items", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify(payload)
  });

  const data = await r.json().catch(() => null);

  if (!r.ok) {
    out.textContent = "Error:\n" + JSON.stringify(data, null, 2);
    return;
  }

  out.textContent = `✅ Created item #${data.id}\n\n` + JSON.stringify(data.item, null, 2);

  // optional: clear form after success
  // form.reset();
});
