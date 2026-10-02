// sessions.aryakesarwani.tech: static site (ASSETS) plus one endpoint that stores
// questionnaire answers in D1. Everything else is served from dist/.

const MAX_BODY = 16 * 1024;
const MAX_TEXT = 3000;
const PER_HOUR = 5;

// What each field may contain. Unknown fields are dropped.
const CHOICE = {
  usage: ["1-2", "3-5", "6-10", "10+"],
  finding: ["resume", "continue", "remember", "lose", "other"],
  tried: ["app", "cli", "both", "not-yet"],
  worked: ["yes", "partly", "no"],
  os: ["mac-arm", "mac-intel", "linux", "windows", "wsl"],
};
const MULTI = {
  terminal: ["terminal", "iterm", "ghostty", "warp", "kitty", "wezterm", "alacritty", "vscode", "tmux", "other"],
  wants: [
    "linux", "windows", "intel", "signed", "warp", "tmux", "multi-open", "full-search",
    "auto-summary", "notes-tags", "launch-login", "vscode", "delete-rename", "export",
  ],
};
const TEXT = ["broke", "change", "else", "contact", "terminal_other"];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function clean(input) {
  const out = {};
  for (const [k, allowed] of Object.entries(CHOICE)) {
    if (allowed.includes(input[k])) out[k] = input[k];
  }
  for (const [k, allowed] of Object.entries(MULTI)) {
    if (Array.isArray(input[k])) {
      const picked = [...new Set(input[k].filter((v) => allowed.includes(v)))];
      if (picked.length) out[k] = picked;
    }
  }
  for (const k of TEXT) {
    if (typeof input[k] === "string" && input[k].trim()) out[k] = input[k].trim().slice(0, MAX_TEXT);
  }
  const nps = Number(input.nps);
  if (Number.isInteger(nps) && nps >= 0 && nps <= 10) out.nps = nps;
  return out;
}

async function hash(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

async function saveFeedback(request, env) {
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) return json({ error: "bad origin" }, 403);

  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ error: "too long" }, 413);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  // Honeypot: real people never see or fill this field.
  if (body.website) return json({ ok: true });

  const answers = clean(body);
  if (Object.keys(answers).length < 2) return json({ error: "Please answer at least a couple of questions." }, 400);

  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const ipHash = await hash(`${env.FEEDBACK_SALT || "dev"}:${ip}`);
  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM feedback WHERE ip_hash = ? AND created_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 hour')",
  )
    .bind(ipHash)
    .first();
  if (recent && recent.n >= PER_HOUR) return json({ error: "Thanks! You've already sent a few answers this hour." }, 429);

  const source = typeof body.source === "string" ? body.source.replace(/[^a-z0-9_-]/gi, "").slice(0, 40) : null;
  await env.DB.prepare("INSERT INTO feedback (source, country, ip_hash, answers) VALUES (?, ?, ?, ?)")
    .bind(source || null, request.cf?.country || null, ipHash, JSON.stringify(answers))
    .run();
  return json({ ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/feedback") {
      if (request.method !== "POST") return json({ error: "POST only" }, 405);
      try {
        return await saveFeedback(request, env);
      } catch (e) {
        console.error("feedback failed", e);
        return json({ error: "Something went wrong saving your answers. Please try again." }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};
