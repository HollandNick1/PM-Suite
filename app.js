/* ================================================================
   Workbench — core app logic
   Data model: array of task objects, persisted via the `store`
   object defined in github-sync.js (localStorage today, swappable
   for the GitHub API later without touching this file).
================================================================= */
const COLUMNS = [
  { id: "backlog", label: "Backlog" },
  { id: "in-progress", label: "In progress" },
  { id: "review", label: "Review" },
  { id: "done", label: "Done" },
];

let tasks = [];
let activeTaskId = null;
let currentView = "board"; // "board" | "backlog" | "archive"

/* ---------------------------------------------------------------
   Bootstrapping
---------------------------------------------------------------- */
async function init() {
  tasks = await store.load();
  render();
  wireGlobalEvents();
  updateSyncIndicator();
}

function uid() {
  return "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function persist() {
  store.save(tasks);
}

/* ---------------------------------------------------------------
   Rendering
---------------------------------------------------------------- */
function render() {
  const board = document.getElementById("board");
  board.classList.toggle("is-list", currentView !== "board");

  if (currentView === "board") {
    renderBoardView(board);
  } else if (currentView === "backlog") {
    renderListView(board, {
      status: "backlog",
      emptyText: "Nothing in the backlog. Add a task above to get started.",
      rowActions: (task) => [
        { label: "Start", onClick: () => setStatus(task.id, "in-progress") },
      ],
    });
  } else if (currentView === "archive") {
    renderListView(board, {
      status: "done",
      emptyText: "No completed tasks yet — finished work will show up here.",
      rowActions: (task) => [
        { label: "Restore", onClick: () => setStatus(task.id, "backlog") },
      ],
    });
  }

  updateQuickAddVisibility();
  document.getElementById("taskCount").textContent =
    `${tasks.length} task${tasks.length === 1 ? "" : "s"}`;
}

function setStatus(id, status) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  task.status = status;
  persist();
  render();
}

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

/* List view — used by the Backlog and Archive tabs. Shows tasks matching
   a single status as a simple vertical list rather than a board. */
function renderListView(board, { status, emptyText, rowActions }) {
  board.innerHTML = "";

  const listTasks = tasks
    .filter((t) => t.status === status)
    .sort((a, b) => (b.order ?? 0) - (a.order ?? 0));

  const wrap = document.createElement("div");
  wrap.className = "tasklist";

  if (listTasks.length === 0) {
    const empty = document.createElement("p");
    empty.className = "tasklist__empty";
    empty.textContent = emptyText;
    wrap.appendChild(empty);
  } else {
    listTasks.forEach((task) => wrap.appendChild(renderListRow(task, rowActions(task))));
  }

  board.appendChild(wrap);
}

function renderListRow(task, actions) {
  const row = document.createElement("div");
  row.className = "listrow";
  row.dataset.status = task.status;

  const overdue = task.due && task.due < todayISO() && task.status !== "done";

  row.innerHTML = `
    <div class="listrow__main">
      <span class="listrow__title"></span>
      <span class="listrow__meta">
        ${task.due ? `<span class="card__due ${overdue ? "is-overdue" : ""}">${task.due}</span>` : ""}
        ${task.priority === "high" ? '<span class="card__priority-high">high</span>' : ""}
      </span>
    </div>
    <div class="listrow__actions"></div>
  `;
  row.querySelector(".listrow__title").textContent = task.title;

  const actionsEl = row.querySelector(".listrow__actions");
  actions.forEach(({ label, onClick }) => {
    const btn = document.createElement("button");
    btn.className = "listrow__action";
    btn.textContent = label;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    actionsEl.appendChild(btn);
  });

  row.addEventListener("click", () => openPanel(task.id));
  return row;
}

function updateQuickAddVisibility() {
  const form = document.getElementById("quickAddForm");
  // Adding a new task always puts it in the backlog, so hide quick-add
  // on the Archive tab where a fresh task wouldn't show up anyway.
  form.style.display = currentView === "archive" ? "none" : "";
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

  card.innerHTML = `
    <div class="card__title"></div>
    <div class="card__meta">
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

function deleteTask(id) {
  tasks = tasks.filter((t) => t.id !== id);
  persist();
  render();
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/* ---------------------------------------------------------------
   Drag and drop between columns
---------------------------------------------------------------- */
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
   Quick add
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

  ["panelTitle", "panelNotes", "panelStatus", "panelDue", "panelPriority"].forEach((id) => {
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
      closePanel();
      render();
    });
  });
}

/* ---------------------------------------------------------------
   Task detail panel
---------------------------------------------------------------- */
function openPanel(id) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  activeTaskId = id;

  document.getElementById("panelTitle").value = task.title;
  document.getElementById("panelNotes").value = task.notes || "";
  document.getElementById("panelStatus").value = task.status;
  document.getElementById("panelDue").value = task.due || "";
  document.getElementById("panelPriority").value = task.priority || "normal";
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
