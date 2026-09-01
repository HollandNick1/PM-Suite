# Workbench

A small, self-hosted project/task tracker: a Kanban board with quick-add,
due dates, priority, and notes per task. No build step, no framework —
plain HTML/CSS/JS, so it deploys straight to GitHub Pages.

## Files

```
index.html       Page structure (board, task panel)
style.css        All styling / design tokens
app.js           App logic: rendering, drag-and-drop, task editing
github-sync.js   Storage layer — localStorage today, GitHub API when connected
data/tasks.json  Placeholder — only used once you connect GitHub sync
```

## Run it locally

No server needed for basic use — just open `index.html` in a browser.
(Some browsers restrict `fetch` on `file://` pages if you connect GitHub
sync; if that happens, run a tiny local server instead: `python3 -m http.server`
from this folder, then visit `http://localhost:8000`.)

## Deploy to GitHub Pages

1. Push this folder to a repo (or a `docs/` subfolder / `gh-pages` branch of one).
2. In the repo: **Settings → Pages → Source**, pick the branch/folder these
   files live in.
3. GitHub gives you a URL like `https://yourname.github.io/reponame/` —
   that's your live app.

## How data is stored

By default, tasks are saved in the browser's `localStorage` — nothing to
configure, but it only lives on the one device/browser you're using.

Click **Connect sync** in the sidebar to switch to storing tasks as a JSON
file in a GitHub repo you choose, via the GitHub API. You'll need:

- The repo, in `owner/repo` form (can be this same repo or a private one).
- A path for the data file (defaults to `data/tasks.json`).
- A **fine-grained personal access token** scoped to just that repo with
  `Contents: Read and write` permission.
  (Create one at github.com → Settings → Developer settings →
  Personal access tokens → Fine-grained tokens.)

Once connected, every change writes a commit to that file, so you get
version history and an undo trail for free via `git log`.

**Security note:** the token is stored in that browser's `localStorage`
and used directly from client-side JavaScript — fine for a personal tool
only you use, but don't extend this pattern once other people log in.
At that point, move the GitHub calls behind a small serverless function
(e.g. a Cloudflare Worker or Vercel function) so the token never reaches
the browser.

## Where to go next

- **Views:** the sidebar's Backlog/Archive buttons are wired up as tabs
  but don't filter yet — that's the next natural feature to add.
- **Multi-user:** once you want others using it, swap the GitHub-token
  approach for a proper backend (Supabase/Firebase) with real auth.
- **Recurring tasks, tags, subtasks:** the task object in `app.js` is a
  plain object (`title`, `notes`, `status`, `priority`, `due`) — easy to
  extend with new fields as you need them.
