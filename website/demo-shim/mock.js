// Stand-in for Tauri's window.__TAURI__ so the real app UI (app/src) can run in a
// browser on the website with made-up sessions. Nothing here touches the disk.
(function () {
  const now = Date.now() / 1000;
  const h = 3600;
  const d = 86400;
  const SESSIONS = [
    ["Fix flaky checkout test", "~/code/shop-api", 0.2 * h, "the retry is still racing the webhook, can you add a lock around it?", "checkout.spec.ts fails 1 in 5 runs on CI"],
    ["Dark mode for settings page", "~/code/dashboard", 1.1 * h, "looks good, now match the toggle to the system accent", "add dark mode to the settings page"],
    ["Postgres to D1 migration plan", "~/code/notes-app", 3.5 * h, "write the migration script and a rollback", "can we move this off Postgres onto Cloudflare D1?"],
    ["Release notes for v2.3", "~/code/mobile", 5 * h, "shorter, and lead with the offline mode", "draft release notes from the merged PRs since v2.2"],
    ["Rate limiter for public API", "~/code/shop-api", 1 * d + 2 * h, "ship it behind a flag first", "we're getting hammered on /search, add a rate limiter"],
    ["Onboarding email copy", "~/code/marketing-site", 1 * d + 6 * h, "make the second email less salesy", "write a 3-email onboarding sequence"],
    ["Profile crash on Android 14", "~/code/mobile", 2 * d + 1 * h, "that fixed it, open a PR", "app crashes when opening profile on Android 14"],
    ["Refactor auth middleware", "~/code/dashboard", 3 * d, "split the session refresh into its own file", "the auth middleware is 600 lines, help me break it up"],
    ["Invoice PDF layout", "~/code/billing", 4 * d + 3 * h, "the totals column wraps on A4, fix that", "generate invoice PDFs from the order data"],
    ["Search ranking tweaks", "~/code/shop-api", 6 * d, "boost exact title matches above tags", "search results feel random, can we tune the ranking?"],
    ["Set up Cloudflare Worker", "~/code/landing", 9 * d, "add the custom domain too", "deploy this static site to a Worker"],
    ["Image upload resizing", "~/code/notes-app", 13 * d, "keep the originals in R2 as well", "resize uploaded images to 3 sizes"],
  ].map(([title, cwd, age, last, first], i) => ({
    id: `demo${String(i).padStart(4, "0")}-0000-4000-8000-000000000000`,
    ai_title: title,
    cwd: cwd.replace("~", "/Users/you"),
    mtime: now - age,
    last_prompt: last,
    first_prompt: first,
    summary: `Worked on ${title.toLowerCase()} in ${cwd}. Ended with: ${last}`,
    prompts: 4 + ((i * 7) % 23),
  }));

  const DEFAULTS = {
    terminal: "terminal", tile_after_open: false, claude_args: "", keep_in_menu_bar: true,
    show_tray: true, tray_count: 10, theme: "system", accent: "", text_size: "medium",
    density: "comfortable", description: "latest", show_time: true, show_archived: true, max_age_days: 0,
  };
  let settings = { ...DEFAULTS };
  try {
    const t = new URLSearchParams(location.search).get("theme");
    if (t) settings.theme = t;
  } catch {}

  const listeners = {};
  function emit(name, payload) {
    (listeners[name] || []).forEach((fn) => fn({ payload }));
  }
  // Settings changes made in one demo frame reach the other through the parent page.
  window.addEventListener("message", (e) => {
    if (e.data && e.data.type === "settings-changed") {
      settings = e.data.settings;
      emit("settings-changed", settings);
    }
  });
  const tell = (msg) => window.parent !== window && window.parent.postMessage(msg, "*");

  const commands = {
    list_sessions: () => SESSIONS,
    get_settings: () => settings,
    installed_terminals: () => ["terminal", "iterm", "ghostty"],
    save_settings: ({ settings: s }) => {
      settings = s;
      emit("settings-changed", s);
      tell({ type: "settings-changed", settings: s });
    },
    reset_settings: () => {
      settings = { ...DEFAULTS };
      emit("settings-changed", settings);
      tell({ type: "settings-changed", settings });
      return settings;
    },
    open_settings: () => tell({ type: "open-settings" }),
    open_sessions: ({ sessions }) => {
      const [id] = sessions[0];
      const s = SESSIONS.find((x) => x.id === id);
      tell({ type: "open", cwd: s.cwd.replace("/Users/you", "~"), id, title: s.ai_title });
    },
    tile_all: () => 0,
    summarize: () => "",
  };

  // Draw the macOS window buttons the real title bar would show.
  const style = document.createElement("style");
  style.textContent = `.topbar, .bar { position: relative; }
    .topbar::before, .bar::before { content: ""; position: absolute; left: 18px; top: 50%; width: 12px; height: 12px;
      margin-top: -6px; border-radius: 50%; background: #ff5f57; box-shadow: 20px 0 #febc2e, 40px 0 #28c840; }`;
  document.head.append(style);

  window.__TAURI__ = {
    core: {
      invoke: (cmd, args) =>
        new Promise((resolve) => setTimeout(() => resolve(commands[cmd] ? commands[cmd](args || {}) : null), 60)),
    },
    event: {
      listen: (name, fn) => {
        (listeners[name] = listeners[name] || []).push(fn);
        return Promise.resolve(() => {});
      },
    },
    window: { getCurrentWindow: () => ({ close() {} }) },
  };
})();
