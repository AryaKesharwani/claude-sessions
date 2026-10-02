// Shared by every window: applies appearance settings and keeps them in sync.
window.applyAppearance = function (s) {
  const root = document.documentElement;
  root.dataset.theme = s.theme || "system";
  root.dataset.size = s.text_size || "medium";
  root.dataset.density = s.density || "comfortable";
  if (s.accent) root.style.setProperty("--accent-override", s.accent);
  else root.style.removeProperty("--accent-override");
};

window.onSettings = function (fn) {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  invoke("get_settings").then((s) => {
    window.applyAppearance(s);
    fn(s);
  });
  listen("settings-changed", (e) => {
    window.applyAppearance(e.payload);
    fn(e.payload);
  });
};
