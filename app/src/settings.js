const { invoke } = window.__TAURI__.core;
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// Preview colours mirror theme.css: [bg, text, muted, accent].
const THEMES = [
  ["system", "System", null],
  ["light", "Light", ["#fbfaf8", "#22201c", "#b9b2a8", "#c8623f"]],
  ["dark", "Dark", ["#1c1b19", "#ece8e1", "#5d5851", "#d97757"]],
  ["paper", "Paper", ["#ffffff", "#111111", "#cccccc", "#111111"]],
  ["solarized", "Solarized", ["#fdf6e3", "#073642", "#93a1a1", "#cb4b16"]],
  ["midnight", "Midnight", ["#0d1117", "#e6edf3", "#484f58", "#58a6ff"]],
  ["nord", "Nord", ["#2e3440", "#eceff4", "#616e88", "#88c0d0"]],
  ["rose", "Rosé", ["#191724", "#e0def4", "#524f67", "#ebbcba"]],
];
const ACCENTS = ["", "#d97757", "#e5534b", "#e0a030", "#3fa66b", "#4c8dff", "#9b6bff", "#e05f9a"];

let settings = null;
let savedTimer;

async function save(patch) {
  settings = { ...settings, ...patch };
  applyAppearance(settings);
  paint();
  try {
    await invoke("save_settings", { settings });
    $("#saved").textContent = "Saved";
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => ($("#saved").textContent = ""), 1200);
  } catch (e) {
    $("#saved").textContent = String(e);
  }
}

function buildThemes() {
  $("#themes").replaceChildren(
    ...THEMES.map(([id, name, c]) => {
      const b = document.createElement("button");
      b.className = "theme";
      b.dataset.id = id;
      const p = document.createElement("span");
      p.className = "preview" + (c ? "" : " split");
      const [bg, text, muted, accent] = c || ["#fbfaf8", "#22201c", "#b9b2a8", "#c8623f"];
      p.style.background = bg;
      for (const color of [text, muted, accent, muted]) {
        const i = document.createElement("i");
        i.style.background = color;
        p.append(i);
      }
      const n = document.createElement("span");
      n.className = "name";
      n.textContent = name;
      b.append(p, n);
      b.onclick = () => save({ theme: id });
      return b;
    }),
  );
  $("#accents").replaceChildren(
    ...ACCENTS.map((color) => {
      const b = document.createElement("button");
      b.className = "swatch" + (color ? "" : " default");
      b.dataset.color = color;
      b.title = color ? color : "Theme default";
      b.setAttribute("aria-label", b.title);
      if (color) b.style.background = color;
      b.onclick = () => save({ accent: color });
      return b;
    }),
  );
}

// Reflect current settings in every control.
function paint() {
  for (const el of $$("[data-key]")) {
    const v = settings[el.dataset.key];
    if (el.classList.contains("seg")) {
      for (const b of el.querySelectorAll("button")) b.classList.toggle("on", b.value === v);
    } else if (el.type === "checkbox") {
      el.checked = !!v;
    } else if (document.activeElement !== el) {
      el.value = String(v ?? "");
    }
  }
  for (const b of $$(".theme")) b.classList.toggle("on", b.dataset.id === settings.theme);
  for (const b of $$(".swatch")) b.classList.toggle("on", b.dataset.color === (settings.accent || ""));
  $("#tray_count").disabled = !settings.show_tray;
  $("#keep_in_menu_bar").disabled = !settings.show_tray;
}

function wire() {
  for (const el of $$("[data-key]")) {
    const key = el.dataset.key;
    if (el.classList.contains("seg")) {
      for (const b of el.querySelectorAll("button")) b.onclick = () => save({ [key]: b.value });
    } else if (el.type === "checkbox") {
      el.onchange = () => save({ [key]: el.checked });
    } else if (el.type === "text") {
      el.onchange = () => save({ [key]: el.value.trim() });
    } else {
      el.onchange = () => save({ [key]: el.dataset.type === "number" ? Number(el.value) : el.value });
    }
  }
  for (const tab of $$("[role=tab]")) {
    tab.onclick = () => {
      for (const t of $$("[role=tab]")) t.setAttribute("aria-selected", String(t === tab));
      for (const p of $$("[data-panel]")) p.hidden = p.dataset.panel !== tab.dataset.tab;
    };
  }
  $("#reset").onclick = async () => {
    settings = await invoke("reset_settings");
    applyAppearance(settings);
    paint();
  };
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" || (e.key === "w" && e.metaKey)) window.__TAURI__.window.getCurrentWindow().close();
  });
}

(async function init() {
  buildThemes();
  wire();
  const installed = await invoke("installed_terminals");
  for (const opt of $("#terminal").options) {
    if (!installed.includes(opt.value)) {
      opt.disabled = true;
      opt.textContent += " (not installed)";
    }
  }
  window.onSettings((s) => {
    settings = s;
    paint();
  });
})();
