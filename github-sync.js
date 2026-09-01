/* ================================================================
   Storage layer for Workbench.

   `store` is the only thing app.js talks to. Today it reads/writes
   localStorage, so everything works immediately with zero setup.

   When you're ready for the tasks to follow you across devices,
   click "Connect sync" in the sidebar — it will ask for a GitHub
   repo + a fine-grained personal access token, and from then on
   `store.load()` / `store.save()` read and write a JSON file in
   that repo instead of localStorage. No other file needs to change.

   ⚠️ Security note: a token entered here is stored in this browser's
   localStorage and is used directly from client-side JS. That's a
   reasonable tradeoff for a personal, single-user tool, but do NOT
   reuse this approach once other people are using the app — at that
   point, move the GitHub calls behind a small serverless function
   (e.g. a Cloudflare Worker) so the token never reaches the browser.
================================================================= */

const LOCAL_KEY = "workbench_tasks_v1";
const CONFIG_KEY = "workbench_gh_config_v1";

const store = {
  isConnected() {
    return !!getConfig();
  },

  async load() {
    const config = getConfig();
    if (!config) {
      return normalizeState(JSON.parse(localStorage.getItem(LOCAL_KEY) || "null"));
    }
    try {
      const { data } = await githubGetFile(config);
      return normalizeState(data);
    } catch (err) {
      console.error("GitHub sync load failed, falling back to local copy:", err);
      alert("Couldn't reach GitHub — showing your last locally saved copy instead.");
      return normalizeState(JSON.parse(localStorage.getItem(LOCAL_KEY) || "null"));
    }
  },

  async save(state) {
    // Always keep a local copy too, so a dropped connection never loses data.
    localStorage.setItem(LOCAL_KEY, JSON.stringify(state));

    const config = getConfig();
    if (!config) return;

    try {
      await githubPutFile(config, state);
    } catch (err) {
      console.error("GitHub sync save failed:", err);
      alert("Saved locally, but couldn't sync to GitHub. Check your token/repo settings.");
    }
  },

  async connect() {
    const existing = getConfig();

    if (existing) {
      const disconnect = confirm(
        "Sync is currently connected to " + existing.owner + "/" + existing.repo +
        ".\n\nOK = disconnect and go back to local-only storage.\nCancel = keep current settings."
      );
      if (disconnect) {
        localStorage.removeItem(CONFIG_KEY);
      }
      return;
    }

    const repoInput = prompt(
      "GitHub repo to sync to (format: owner/repo)\n\n" +
      "This should be a repo you own. A new file will be created at the path you choose below."
    );
    if (!repoInput || !repoInput.includes("/")) return;
    const [owner, repo] = repoInput.split("/").map((s) => s.trim());

    const path = prompt(
      "Path to the data file inside that repo:",
      "data/tasks.json"
    );
    if (!path) return;

    const token = prompt(
      "GitHub personal access token (fine-grained, scoped to just this repo, " +
      "with Contents: Read and write permission).\n\n" +
      "This is stored only in this browser's localStorage — see the note at " +
      "the top of github-sync.js before using this on a shared machine."
    );
    if (!token) return;

    localStorage.setItem(CONFIG_KEY, JSON.stringify({ owner, repo, path, token }));
  },
};

// Accepts the old format (a bare array of tasks) or the current format
// ({ tasks, projects, trash }) and always returns the current shape, so
// nobody's existing saved data gets dropped when this schema changed.
function normalizeState(raw) {
  if (!raw) return { tasks: [], projects: [], trash: [] };
  if (Array.isArray(raw)) return { tasks: raw, projects: [], trash: [] };
  return {
    tasks: raw.tasks || [],
    projects: raw.projects || [],
    trash: raw.trash || [],
  };
}

function getConfig() {
  const raw = localStorage.getItem(CONFIG_KEY);
  return raw ? JSON.parse(raw) : null;
}

/* ---------------------------------------------------------------
   Raw GitHub API calls (Contents API)
   Docs: https://docs.github.com/en/rest/repos/contents
---------------------------------------------------------------- */
async function githubGetFile(config) {
  const url = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${config.path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: "application/vnd.github+json",
    },
  });

  if (res.status === 404) {
    // File doesn't exist yet — treat as empty state.
    return { data: null, sha: null };
  }
  if (!res.ok) throw new Error(`GitHub GET failed: ${res.status}`);

  const json = await res.json();
  const decoded = decodeURIComponent(escape(atob(json.content.replace(/\n/g, ""))));
  return { data: JSON.parse(decoded || "null"), sha: json.sha };
}

async function githubPutFile(config, state) {
  const url = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${config.path}`;

  // Need the current sha to update an existing file; skip if it's a new file.
  let sha = null;
  try {
    const current = await githubGetFile(config);
    sha = current.sha;
  } catch (_) {
    /* first save — no sha yet */
  }

  const content = btoa(unescape(encodeURIComponent(JSON.stringify(state, null, 2))));

  const body = {
    message: `Update tasks — ${new Date().toISOString()}`,
    content,
  };
  if (sha) body.sha = sha;

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`GitHub PUT failed: ${res.status} ${errText}`);
  }
}
