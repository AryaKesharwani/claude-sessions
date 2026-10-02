const form = document.getElementById("form");
const status = document.getElementById("status");
const DRAFT_KEY = "cs-feedback-draft";

// 0–10 scale
const nps = form.querySelector(".nps");
for (let i = 0; i <= 10; i++) {
  const l = document.createElement("label");
  l.innerHTML = `<input type="radio" name="nps" value="${i}" aria-label="${i}" /><span>${i}</span>`;
  nps.append(l);
}

// "Did it work?" only for people who tried it.
const tried = form.querySelector(".if-tried");
function syncTried() {
  const v = form.querySelector("input[name=tried]:checked")?.value;
  tried.hidden = !v || v === "not-yet";
}
form.addEventListener("change", syncTried);

// Cap feature picks at 4.
const wants = [...form.querySelectorAll("input[name=wants]")];
function syncWants() {
  const n = wants.filter((w) => w.checked).length;
  for (const w of wants) w.disabled = !w.checked && n >= 4;
  document.getElementById("wants-limit").hidden = n < 4;
}
wants.forEach((w) => w.addEventListener("change", syncWants));

function collect() {
  const fd = new FormData(form);
  const data = {};
  for (const [k, v] of fd.entries()) {
    if (k === "terminal" || k === "wants") (data[k] = data[k] || []).push(v);
    else data[k] = v;
  }
  return data;
}

// Keep an unsent draft in this browser only, in case the tab closes.
function saveDraft() {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(collect()));
  } catch {}
}
function loadDraft() {
  let d;
  try {
    d = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
  } catch {}
  if (!d) return;
  for (const [k, v] of Object.entries(d)) {
    if (k === "website") continue;
    const values = Array.isArray(v) ? v : [v];
    for (const el of form.querySelectorAll(`[name="${k}"]`)) {
      if (el.type === "radio" || el.type === "checkbox") el.checked = values.includes(el.value);
      else el.value = v;
    }
  }
  syncTried();
  syncWants();
}
form.addEventListener("input", saveDraft);
form.addEventListener("change", saveDraft);
loadDraft();

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = collect();
  data.source = new URLSearchParams(location.search).get("ref") || "";
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  status.className = "";
  status.textContent = "Sending…";
  try {
    const r = await fetch("/api/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
    const res = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(res.error || `Error ${r.status}`);
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {}
    if (window.op) window.op("track", "feedback_submitted", { source: data.source || "direct", tried: data.tried || "", nps: data.nps || "" });
    form.hidden = true;
    document.querySelector(".fb-intro").hidden = true;
    document.getElementById("thanks").hidden = false;
    window.scrollTo({ top: 0 });
  } catch (err) {
    status.className = "error";
    status.textContent = err.message || "Couldn't send. Please try again.";
    button.disabled = false;
  }
});
