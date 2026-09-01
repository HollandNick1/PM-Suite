/* ================================================================
   Workbench — core app logic
   Data model, persisted as one object via the `store` object in
   github-sync.js (localStorage today, swappable for the GitHub API
   later without touching this file):

     {
       tasks:    [ ...board task objects, each with an optional projectId... ],
       projects: [ { id, name, createdAt } ],
       trash:    [ ...deleted task objects, with deletedAt/prevStatus... ]
     }

   A project doesn't keep its own task list — the Projects tab just shows
   whichever board tasks have that project's id, sorted by creation. That
   way there's one source of truth: a status change on the board (drag,
   the advance button, the panel) and a done-toggle on the Projects tab
   are the same field, so either view always reflects the other.
================================================================= */

const COLUMNS = [
  { id: "backlog", label: "Backlog" },
  { id: "in-progress", label: "In progress" },
  { id: "review", label: "Review" },
  { id: "done", label: "Done" },
];

let tasks = [];
let projects = [];
let trash = [];

let activeTaskId = null;
let activeProjectId = null; // set while viewing a single project's sub-tasks
let currentView = "board"; // "board" | "projects" | "archive"

/* ---------------------------------------------------------------
   Bootstrapping
---------------------------------------------------------------- */
async function init() {
  const state = await store.load();
  tasks = state.tasks;
  projects = state.projects;
  trash = state.trash;
  render();
  wireGlobalEvents();
  updateSyncIndicator();
}

function uid() {
  return "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function persist() {
  store.save({ tasks, projects, trash });
}

/* ---------------------------------------------------------------
   Rendering — top-level dispatch
---------------------------------------------------------------- */
function render() {
  const board = document.getElementById("board");
  board.classList.toggle("is-list", currentView !== "board");

  if (currentView === "board") {
    renderBoardView(board);
  } else if (currentView === "projects") {
    renderProjectsView(board);
  } else if (currentView === "archive") {
    renderArchiveView(board);
  }

  updateQuickAddVisibility();
  document.getElementById("taskCount").textContent =
    `${tasks.length} task${tasks.length === 1 ? "" : "s"}`;
}

function updateQuickAddVisibility() {
  const form = document.getElementById("quickAddForm");
  // The top quick-add always creates a board task in the backlog, which
  // isn't relevant on the Projects tab (sub-tasks are added per-project)
  // or the Archive tab (a fresh task wouldn't show up there anyway).
  form.style.display = currentView === "board" ? "" : "none";
}

/* ---------------------------------------------------------------
   Board view (Kanban)
---------------------------------------------------------------- */
function renderBoardView(board) {
  board.innerHTML = "";

  COLUMNS.forEach((col) => {
    const colTasks = tasks.filter((t) => t.status === col.id);

    const colEl = document.createElement("div");
    colEl.className = "column";
    colEl.innerHTML = `
      <div class="column__head">
        <span class="column__title">${col.label}</span>
        <span class="column__count">${colTasks.length}</span>
      </div>
      <div class="column__body" data-status="${col.id}"></div>
      ${col.id === "backlog" ? '<button class="column__add" data-add="backlog">+ Add task</button>' : ""}
    `;

    const body = colEl.querySelector(".column__body");
    colTasks
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .forEach((task) => body.appendChild(renderCard(task)));

    wireColumnDrop(body);
    board.appendChild(colEl);
  });

  const addBtn = board.querySelector('[data-add="backlog"]');
  if (addBtn) addBtn.addEventListener("click", () => quickAdd(""));
}

function nextStatusOf(status) {
  const idx = COLUMNS.findIndex((c) => c.id === status);
  if (idx === -1 || idx === COLUMNS.length - 1) return null;
  return COLUMNS[idx + 1];
}

function renderCard(task) {
  const card = document.createElement("div");
  card.className = "card";
  card.draggable = true;
  card.dataset.id = task.id;
  card.dataset.status = task.status;

  const overdue = task.due && task.due < todayISO() && task.status !== "done";
  const next = nextStatusOf(task.status);
  const project = task.projectId ? projects.find((p) => p.id === task.projectId) : null;

  card.innerHTML = `
    <div class="card__title"></div>
    <div class="card__meta">
      ${project ? `<span class="card__project"></span>` : ""}
      ${task.due ? `<span class="card__due ${overdue ? "is-overdue" : ""}">${task.due}</span>` : ""}
      ${task.priority === "high" ? '<span class="card__priority-high">high</span>' : ""}
    </div>
    <div class="card__footer">
      ${
        next
          ? `<button class="card__advance" type="button">Move to ${next.label} →</button>`
          : `<button class="card__delete" type="button">Delete</button>`
      }
    </div>
  `;
  card.querySelector(".card__title").textContent = task.title;
  if (project) card.querySelector(".card__project").textContent = project.name;

  card.addEventListener("click", () => openPanel(task.id));
  card.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", task.id);
  });

  const advanceBtn = card.querySelector(".card__advance");
  if (advanceBtn) {
    advanceBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setStatus(task.id, next.id);
    });
  }

  const deleteBtn = card.querySelector(".card__delete");
  if (deleteBtn) {
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteTask(task.id);
    });
  }

  return card;
}

function setStatus(id, status) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  task.status = status;
  persist();
  render();
}

/* Deleting a board task moves it to the trash log (shown on the Archive
   tab) rather than destroying it outright, so it can be restored. */
function deleteTask(id) {
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const [task] = tasks.splice(idx, 1);
  trash.unshift({ ...task, deletedAt: todayISO(), prevStatus: task.status });
  persist();
  render();
}

function wireColumnDrop(body) {
  body.addEventListener("dragover", (e) => {
    e.preventDefault();
    body.classList.add("is-dragover");
  });
  body.addEventListener("dragleave", () => body.classList.remove("is-dragover"));
  body.addEventListener("drop", (e) => {
    e.preventDefault();
    body.classList.remove("is-dragover");
    const id = e.dataTransfer.getData("text/plain");
    const task = tasks.find((t) => t.id === id);
    if (!task) return;
    task.status = body.dataset.status;
    persist();
    render();
  });
}

/* ---------------------------------------------------------------
   Projects view — a project list, or one project's sub-tasks
---------------------------------------------------------------- */
function renderProjectsView(board) {
  board.innerHTML = "";
  const project = projects.find((p) => p.id === activeProjectId);

  if (project) {
    board.appendChild(renderProjectDetail(project));
  } else {
    activeProjectId = null;
    board.appendChild(renderProjectsList());
  }
}

function renderProjectsList() {
  const wrap = document.createElement("div");
  wrap.className = "tasklist";

  const addForm = document.createElement("form");
  addForm.className = "inlineadd";
  addForm.innerHTML = `
    <input class="inlineadd__input" type="text" placeholder="New project name…" autocomplete="off" />
    <button class="inlineadd__btn" type="submit">Add project</button>
  `;
  addForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = addForm.querySelector(".inlineadd__input");
    const name = input.value.trim();
    if (!name) return;
    createProject(name);
  });
  wrap.appendChild(addForm);

  if (projects.length === 0) {
    const empty = document.createElement("p");
    empty.className = "tasklist__empty";
    empty.textContent = "No projects yet. Add one above to start breaking it into sub-tasks.";
    wrap.appendChild(empty);
    return wrap;
  }

  projects
    .slice()
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
    .forEach((project) => wrap.appendChild(renderProjectCard(project)));

  return wrap;
}

function tasksForProject(projectId) {
  return tasks
    .filter((t) => t.projectId === projectId)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

function renderProjectCard(project) {
  const projectTasks = tasksForProject(project.id);
  const done = projectTasks.filter((t) => t.status === "done").length;
  const total = projectTasks.length;

  const row = document.createElement("div");
  row.className = "listrow";
  row.innerHTML = `
    <div class="listrow__main">
      <span class="listrow__title"></span>
      <span class="listrow__meta">${total ? `${done}/${total} done` : "No tasks yet"}</span>
    </div>
    <div class="listrow__actions">
      <button class="listrow__action" data-action="open">Open</button>
      <button class="listrow__action listrow__action--danger" data-action="delete">Delete</button>
    </div>
  `;
  row.querySelector(".listrow__title").textContent = project.name;

  row.querySelector('[data-action="open"]').addEventListener("click", (e) => {
    e.stopPropagation();
    openProject(project.id);
  });
  row.querySelector('[data-action="delete"]').addEventListener("click", (e) => {
    e.stopPropagation();
    deleteProject(project.id);
  });
  row.addEventListener("click", () => openProject(project.id));

  return row;
}

function renderProjectDetail(project) {
  const wrap = document.createElement("div");
  wrap.className = "tasklist";

  const header = document.createElement("div");
  header.className = "projecthead";
  header.innerHTML = `
    <button class="projecthead__back" type="button">← Projects</button>
    <span class="projecthead__title"></span>
    <button class="projecthead__delete" type="button">Delete project</button>
  `;
  header.querySelector(".projecthead__title").textContent = project.name;
  header.querySelector(".projecthead__back").addEventListener("click", closeProjectDetail);
  header.querySelector(".projecthead__delete").addEventListener("click", () => deleteProject(project.id));
  wrap.appendChild(header);

  const addForm = document.createElement("form");
  addForm.className = "inlineadd";
  addForm.innerHTML = `
    <input class="inlineadd__input" type="text" placeholder="Add a task…" autocomplete="off" />
    <button class="inlineadd__btn" type="submit">Add</button>
  `;
  addForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = addForm.querySelector(".inlineadd__input");
    const title = input.value.trim();
    if (!title) return;
    addProjectTask(project.id, title);
  });
  wrap.appendChild(addForm);

  const projectTasks = tasksForProject(project.id);
  if (projectTasks.length === 0) {
    const empty = document.createElement("p");
    empty.className = "tasklist__empty";
    empty.textContent = "No tasks yet. Add one above, or assign an existing board task to this project from its detail panel.";
    wrap.appendChild(empty);
  } else {
    projectTasks.forEach((task) => wrap.appendChild(renderProjectTaskRow(task)));
  }

  return wrap;
}

const STATUS_LABEL = Object.fromEntries(COLUMNS.map((c) => [c.id, c.label]));

function renderProjectTaskRow(task) {
  const done = task.status === "done";
  const row = document.createElement("div");
  row.className = "subtaskrow";
  row.innerHTML = `
    <div class="subtaskrow__main">
      <input type="checkbox" ${done ? "checked" : ""} />
      <span class="subtaskrow__title"></span>
      ${!done ? `<span class="subtaskrow__status">${STATUS_LABEL[task.status] || task.status}</span>` : ""}
    </div>
    <button class="listrow__action listrow__action--danger" type="button">Delete</button>
  `;
  row.querySelector(".subtaskrow__title").textContent = task.title;
  if (done) row.classList.add("is-done");

  row.querySelector('input[type="checkbox"]').addEventListener("change", () => {
    toggleTaskDone(task.id);
  });
  row.querySelector(".listrow__action--danger").addEventListener("click", (e) => {
    e.stopPropagation();
    deleteTask(task.id);
  });
  // Clicking the checkbox fires its own "click" before "change", which would
  // otherwise bubble up and open the panel with the pre-toggle status still
  // showing — so the row only opens the panel for clicks outside the checkbox.
  row.addEventListener("click", (e) => {
    if (e.target.closest('input, button')) return;
    openPanel(task.id);
  });

  return row;
}

/* Marking a project task "done" here just moves it to the Done column on
   the board (remembering where it was, to restore on un-check) — it's the
   same status field the board itself reads, so both views stay in sync. */
function toggleTaskDone(id) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  if (task.status === "done") {
    task.status = task.prevStatus || "backlog";
    delete task.prevStatus;
  } else {
    task.prevStatus = task.status;
    task.status = "done";
  }
  persist();
  render();
}

function createProject(name) {
  projects.push({ id: uid(), name, createdAt: todayISO() });
  persist();
  render();
}

function openProject(id) {
  activeProjectId = id;
  render();
}

function closeProjectDetail() {
  activeProjectId = null;
  render();
}

function deleteProject(id) {
  if (!confirm("Delete this project? Its tasks stay on the board, just no longer tagged to it.")) return;
  tasks.forEach((t) => {
    if (t.projectId === id) t.projectId = "";
  });
  projects = projects.filter((p) => p.id !== id);
  if (activeProjectId === id) activeProjectId = null;
  persist();
  render();
}

function addProjectTask(projectId, title) {
  const project = projects.find((p) => p.id === projectId);
  if (!project) return;
  tasks.push({
    id: uid(),
    title,
    notes: "",
    status: "backlog",
    priority: "normal",
    due: "",
    order: Date.now(),
    created: todayISO(),
    projectId,
  });
  persist();
  render();
}

/* ---------------------------------------------------------------
   Archive view — a log of deleted tasks, restorable or permanent
---------------------------------------------------------------- */
function renderArchiveView(board) {
  board.innerHTML = "";

  const wrap = document.createElement("div");
  wrap.className = "tasklist";

  if (trash.length === 0) {
    const empty = document.createElement("p");
    empty.className = "tasklist__empty";
    empty.textContent = "Nothing deleted yet — tasks you delete will show up here so you can restore them.";
    wrap.appendChild(empty);
  } else {
    trash.forEach((entry) => wrap.appendChild(renderTrashRow(entry)));
  }

  board.appendChild(wrap);
}

function renderTrashRow(entry) {
  const row = document.createElement("div");
  row.className = "listrow";
  row.innerHTML = `
    <div class="listrow__main">
      <span class="listrow__title"></span>
      <span class="listrow__meta">Deleted ${entry.deletedAt}</span>
    </div>
    <div class="listrow__actions">
      <button class="listrow__action" data-action="restore">Restore</button>
      <button class="listrow__action listrow__action--danger" data-action="purge">Delete forever</button>
    </div>
  `;
  row.querySelector(".listrow__title").textContent = entry.title;

  row.querySelector('[data-action="restore"]').addEventListener("click", () => restoreFromTrash(entry.id));
  row.querySelector('[data-action="purge"]').addEventListener("click", () => purgeFromTrash(entry.id));

  return row;
}

function restoreFromTrash(id) {
  const idx = trash.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const [entry] = trash.splice(idx, 1);
  const { deletedAt, prevStatus, ...task } = entry;
  task.status = prevStatus || "backlog";
  tasks.push(task);
  persist();
  render();
}

function purgeFromTrash(id) {
  if (!confirm("Permanently delete this task? This can't be undone.")) return;
  trash = trash.filter((t) => t.id !== id);
  persist();
  render();
}

/* ---------------------------------------------------------------
   Quick add (board tasks only)
---------------------------------------------------------------- */
function quickAdd(prefill) {
  const input = document.getElementById("quickAddInput");
  input.focus();
  if (prefill) input.value = prefill;
}

function wireGlobalEvents() {
  document.getElementById("quickAddForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("quickAddInput");
    const title = input.value.trim();
    if (!title) return;
    tasks.push({
      id: uid(),
      title,
      notes: "",
      status: "backlog",
      priority: "normal",
      due: "",
      order: Date.now(),
      created: todayISO(),
      projectId: "",
    });
    input.value = "";
    persist();
    render();
  });

  document.getElementById("panelClose").addEventListener("click", closePanel);
  document.getElementById("panelBackdrop").addEventListener("click", (e) => {
    if (e.target.id === "panelBackdrop") closePanel();
  });

  document.getElementById("panelDelete").addEventListener("click", () => {
    deleteTask(activeTaskId);
    closePanel();
  });

  ["panelTitle", "panelNotes", "panelStatus", "panelDue", "panelPriority", "panelProject"].forEach((id) => {
    document.getElementById(id).addEventListener("input", saveActiveTaskFromPanel);
    document.getElementById(id).addEventListener("change", saveActiveTaskFromPanel);
  });

  document.getElementById("syncBtn").addEventListener("click", () => {
    store.connect().then(() => {
      updateSyncIndicator();
      init();
    });
  });

  document.querySelectorAll(".rail__link").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".rail__link").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      currentView = btn.dataset.view;
      activeProjectId = null; // always land on the project list, not a stale detail view
      closePanel();
      render();
    });
  });
}

/* ---------------------------------------------------------------
   Task detail panel (board tasks only)
---------------------------------------------------------------- */
function populateProjectSelect(selectedId) {
  const select = document.getElementById("panelProject");
  select.innerHTML = '<option value="">No project</option>';
  projects
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((project) => {
      const option = document.createElement("option");
      option.value = project.id;
      option.textContent = project.name;
      select.appendChild(option);
    });
  select.value = selectedId || "";
}

function openPanel(id) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  activeTaskId = id;

  document.getElementById("panelTitle").value = task.title;
  document.getElementById("panelNotes").value = task.notes || "";
  document.getElementById("panelStatus").value = task.status;
  document.getElementById("panelDue").value = task.due || "";
  document.getElementById("panelPriority").value = task.priority || "normal";
  populateProjectSelect(task.projectId);
  document.getElementById("panelMeta").textContent = `Created ${task.created} · ${task.id}`;

  document.getElementById("panelBackdrop").classList.add("is-open");
}

function closePanel() {
  activeTaskId = null;
  document.getElementById("panelBackdrop").classList.remove("is-open");
}

function saveActiveTaskFromPanel() {
  const task = tasks.find((t) => t.id === activeTaskId);
  if (!task) return;
  task.title = document.getElementById("panelTitle").value.trim() || task.title;
  task.notes = document.getElementById("panelNotes").value;
  task.status = document.getElementById("panelStatus").value;
  task.due = document.getElementById("panelDue").value;
  task.priority = document.getElementById("panelPriority").value;
  task.projectId = document.getElementById("panelProject").value;
  persist();
  render();
}

/* ---------------------------------------------------------------
   Sync indicator (talks to github-sync.js)
---------------------------------------------------------------- */
function updateSyncIndicator() {
  const dot = document.getElementById("syncDot");
  const label = document.getElementById("syncLabel");
  const btn = document.getElementById("syncBtn");

  if (store.isConnected()) {
    dot.classList.add("is-connected");
    label.textContent = "Synced via GitHub";
    btn.textContent = "Manage sync";
  } else {
    dot.classList.remove("is-connected");
    label.textContent = "Saved on this device";
    btn.textContent = "Connect sync";
  }
}

init();
