(function () {
  const DEFAULT_DURATION_MS = 3800;

  function ensureWrap() {
    let wrap = document.getElementById("toastWrap");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.id = "toastWrap";
      wrap.className = "toast-wrap";
      document.body.appendChild(wrap);
    }
    return wrap;
  }

  function show(title, body, opts = {}) {
    const wrap = ensureWrap();

    const type = opts.type || "";
    const durationMs = Number.isFinite(opts.durationMs) ? opts.durationMs : DEFAULT_DURATION_MS;

    const el = document.createElement("div");
    el.className = "toast " + type;

    el.innerHTML =
      '<div class="toast-title">' + String(title || "") + "</div>" +
      '<div class="toast-body">' + String(body || "") + "</div>";

    wrap.appendChild(el);

    setTimeout(() => {
      el.style.animation = "toastOut .20s ease forwards";
      setTimeout(() => el.remove(), 240);
    }, durationMs);
  }

  // Global API
  window.GFToast = { show };
})();
