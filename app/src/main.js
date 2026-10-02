const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const $ = (sel) => document.querySelector(sel);

let sessions = [];
let query = "";
let prefs = { description: "latest", show_time: true, show_archived: true, max_age_days: 0 };

function title(s) {
  return s.custom_title || s.ai_title || s.first_prompt || "Untitled session";
}

function desc(s) {
  if (prefs.description === "first") return s.first_prompt || "";
  if (prefs.description === "summary") return s.summary || s.last_prompt || "";
  return s.last_prompt || s.first_prompt || "";
}

function time(ts) {
  return new Date(ts * 1000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function dayLabel(ts) {
  const d = new Date(ts * 1000);
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(new Date()) - start(d)) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { month: "long", day: "numeric" });
}

let toastTimer;
function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = isError ? "error" : "";
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 6000 : 2000);
}

function explain(e) {
  const msg = String(e);
  return /not allowed|-1743|authoriz/i.test(msg)
    ? "Allow Claude Sessions to control your terminal in System Settings → Privacy & Security → Automation."
    : msg;
}

async function load() {
  try {
    sessions = await invoke("list_sessions");
    render();
  } catch (e) {
    toast(String(e), true);
  }
}

async function open(s, row) {
  row.classList.add("opening");
  try {
    await invoke("open_sessions", { sessions: [[s.id, title(s)]] });
  } catch (e) {
    toast(explain(e), true);
  } finally {
    row.classList.remove("opening");
  }
}

function render() {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const cutoff = prefs.max_age_days ? Date.now() / 1000 - prefs.max_age_days * 86400 : 0;
  const shown = sessions.filter((s) => {
    if (s.mtime < cutoff) return false;
    if (!prefs.show_archived && s.archived_only) return false;
    const h = [title(s), s.first_prompt, s.last_prompt, s.summary, s.cwd].join(" ").toLowerCase();
    return terms.every((t) => h.includes(t));
  });

  const items = [];
  let lastDay = null;
  for (const s of shown) {
    const day = dayLabel(s.mtime);
    if (day !== lastDay) {
      const h = document.createElement("li");
      h.className = "day";
      h.textContent = day;
      items.push(h);
      lastDay = day;
    }
    const li = document.createElement("li");
    li.className = "row";
    li.tabIndex = 0;
    li.title = "Open in a new terminal window";
    const t = document.createElement("span");
    t.className = "title";
    t.textContent = title(s);
    const tm = document.createElement("span");
    tm.className = "time";
    tm.textContent = prefs.show_time ? time(s.mtime) : "";
    const d = document.createElement("span");
    d.className = "desc";
    d.textContent = desc(s);
    li.append(t, tm, d);
    li.onclick = () => open(s, li);
    li.onkeydown = (e) => e.key === "Enter" && open(s, li);
    items.push(li);
  }
  $("#list").replaceChildren(...items);
  const empty = $("#empty");
  empty.hidden = shown.length > 0;
  empty.textContent = sessions.length ? "Nothing matches." : "No sessions yet.";
}

$("#q").addEventListener("input", (e) => {
  query = e.target.value;
  render();
});

$("#settings").onclick = () => invoke("open_settings");

document.addEventListener("keydown", (e) => {
  if (e.key === "f" && e.metaKey) {
    e.preventDefault();
    $("#q").focus();
  } else if (e.key === "Escape") {
    $("#q").value = query = "";
    $("#q").blur();
    render();
  }
});

window.onSettings((s) => {
  prefs = s;
  render();
});
listen("notice", (e) => toast(explain(e.payload), true));
window.addEventListener("focus", load);
load();
