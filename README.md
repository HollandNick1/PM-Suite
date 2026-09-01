# Workbench

A small, self-hosted project tracker with three views:

- **Board** — a Kanban board (Backlog → In progress → Review → Done) for
  day-to-day tasks, with quick-add, due dates, priority, and notes.
- **Projects** — set up a project and break it into a checklist of
  sub-tasks, separate from the day-to-day board.
- **Archive** — a log of deleted board tasks. Deleting a task never
  destroys it outright; it lands here, restorable or removable for good.

No build step, no framework — plain HTML/CSS/JS, so it deploys straight
to GitHub Pages.

## Files

```
index.html       Page structure (board, projects, task panel)
style.css        All styling / design tokens
app.js           App logic: rendering, drag-and-drop, task/project editing
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

By default, everything is saved in the browser's `localStorage` — nothing
to configure, but it only lives on the one device/browser you're using.
The stored shape is one object: `{ tasks, projects, trash }`.

Click **Connect sync** in the sidebar to switch to storing that same object
as a JSON file in a GitHub repo you choose, via the GitHub API. You'll need:

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

- **Multi-user:** once you want others using it, swap the GitHub-token
  approach for a proper backend (Supabase/Firebase) with real auth.
- **Linking projects and board tasks:** right now Projects and the Board
  are independent; a natural next step is letting a project's sub-task
  get promoted to a full board task, or tagging board tasks with a project.
- **Recurring tasks, tags, due dates on sub-tasks:** the task object in
  `app.js` is a plain object (`title`, `notes`, `status`, `priority`,
  `due`) — easy to extend with new fields as you need them.
