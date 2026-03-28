document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-go]");
  if (!btn) return;
  const url = btn.getAttribute("data-go");
  if (url) location.href = url;
});
