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

  document.getElementById("taskCount").textContent =
    `${tasks.length} task${tasks.length === 1 ? "" : "s"}`;

  const addBtn = board.querySelector('[data-add="backlog"]');
  if (addBtn) addBtn.addEventListener("click", () => quickAdd(""));
}

function renderCard(task) {
  const card = document.createElement("div");
  card.className = "card";
  card.draggable = true;
  card.dataset.id = task.id;
  card.dataset.status = task.status;

  const overdue = task.due && task.due < todayISO() && task.status !== "done";

  card.innerHTML = `
    <div class="card__title"></div>
    <div class="card__meta">
      ${task.due ? `<span class="card__due ${overdue ? "is-overdue" : ""}">${task.due}</span>` : ""}
      ${task.priority === "high" ? '<span class="card__priority-high">high</span>' : ""}
    </div>
  `;
  card.querySelector(".card__title").textContent = task.title;

  card.addEventListener("click", () => openPanel(task.id));
  card.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", task.id);
  });

  return card;
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
    tasks = tasks.filter((t) => t.id !== activeTaskId);
    persist();
    closePanel();
    render();
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

  // Nav buttons are placeholders for future views (Backlog / Archive filters)
  document.querySelectorAll(".rail__link").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".rail__link").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
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
