-- Questionnaire answers from sessions.aryakesarwani.tech/feedback
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  source TEXT,          -- ?ref= tag, e.g. "reddit-claudecode"
  country TEXT,         -- from Cloudflare, two letters
  ip_hash TEXT,         -- salted hash, only used for rate limiting
  answers TEXT NOT NULL -- JSON
);
CREATE INDEX IF NOT EXISTS feedback_ip_time ON feedback (ip_hash, created_at);
