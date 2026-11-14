-- Hosted Plater (packages/hosted/worker.js). Every version of every project is
-- kept: a version is an immutable manifest {path: sha256} over blobs in R2, so a
-- link to /<project>/v<n>/ shows exactly what was reviewed, forever.
CREATE TABLE IF NOT EXISTS projects (
  slug TEXT PRIMARY KEY,
  title TEXT,
  content_path TEXT NOT NULL DEFAULT 'content/site.json',
  head INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- source: publish (an agent shared it), edit (typed on the page), note (a
-- ✎ Note ran), restore (an older version's copy brought back).
CREATE TABLE IF NOT EXISTS versions (
  project TEXT NOT NULL,
  n INTEGER NOT NULL,
  manifest TEXT NOT NULL,
  source TEXT NOT NULL,
  by TEXT,
  message TEXT,
  note_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project, n)
);

CREATE TABLE IF NOT EXISTS blobs (
  sha TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

-- ✎ Note queue. The runner on the owner's always-on machine claims a note,
-- runs it on the owner's ChatGPT plan, and posts the result as a new version.
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  version INTEGER NOT NULL,
  text TEXT NOT NULL,
  capture TEXT,
  email TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  result_version INTEGER,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS notes_queue ON notes (status, created_at);
CREATE INDEX IF NOT EXISTS notes_project ON notes (project, created_at);

-- Append-only review record. path '*' marks a whole version reviewed; any other
-- path is one page, carrying the page's hash at the time so later edits show
-- as "changed since review".
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  version INTEGER NOT NULL,
  path TEXT NOT NULL,
  hash TEXT,
  reviewed INTEGER NOT NULL,
  email TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reviews_project ON reviews (project, path, id);
