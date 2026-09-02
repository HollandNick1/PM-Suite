/* ================================================================
   Workbench — core app logic
   Data model, persisted as one object via the `store` object in
   github-sync.js (localStorage today, swappable for the GitHub API
   later without touching this file):

     {
       tasks:    [ ...board task objects, each with an optional projectId... ],
       projects: [ { id, name, createdAt,
                      value, budget, actualSpend,   // free-text numbers
                      currency,                      // "GBP" | "USD" | "EUR"
                      startDate, endDate } ],        // ISO date strings
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
const STATUS_LABEL = Object.fromEntries(COLUMNS.map((c) => [c.id, c.label]));

let tasks = [];
let projects = [];
let trash = [];

let activeTaskId = null;
let activeProjectId = null; // set while viewing a single project's sub-tasks
let currentView = "board"; // "board" | "projects" | "archive"
let boardMode = "kanban"; // "kanban" | "timeline" | "calendar" — only meaningful on the Board tab
let timelineFilterDate = null; // set by clicking a Calendar day; narrows Timeline to that date
let calendarCursor = monthOf(new Date());

function monthOf(date) {
  return { year: date.getFullYear(), month: date.getMonth() };
}

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

// New tasks default to a due date a week out, since the Timeline view
// orders everything by due date and an undated task has nowhere to sit.
function defaultDueDate() {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return d.toISOString().slice(0, 10);
}

function persist() {
  store.save({ tasks, projects, trash });
}

/* ---------------------------------------------------------------
   Rendering — top-level dispatch
---------------------------------------------------------------- */
function render() {
  const board = document.getElementById("board");
  const isTimeline = currentView === "board" && boardMode === "timeline";
  const isCalendar = currentView === "board" && boardMode === "calendar";
  board.classList.toggle("is-list", currentView !== "board" || isTimeline);
  board.classList.toggle("is-calendar", isCalendar);

  if (currentView === "board") {
    if (isTimeline) {
      renderTimelineView(board);
    } else if (isCalendar) {
      renderCalendarView(board);
    } else {
      renderBoardView(board);
    }
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
  const viewSwitch = document.getElementById("boardViewSwitch");
  // The top quick-add always creates a board task in the backlog, which
  // isn't relevant on the Projects tab (sub-tasks are added per-project)
  // or the Archive tab (a fresh task wouldn't show up there anyway).
  form.style.display = currentView === "board" ? "" : "none";
  viewSwitch.style.display = currentView === "board" ? "" : "none";
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

/* ---------------------------------------------------------------
   Timeline view — every task in one list, ordered by due date
---------------------------------------------------------------- */
function renderTimelineView(board) {
  board.innerHTML = "";

  const wrap = document.createElement("div");
  wrap.className = "tasklist";

  if (timelineFilterDate) {
    const banner = document.createElement("div");
    banner.className = "timelinefilter";
    banner.innerHTML = `
      <span>Showing tasks due <strong>${timelineFilterDate}</strong></span>
      <button class="timelinefilter__clear" type="button">Show all</button>
    `;
    banner.querySelector(".timelinefilter__clear").addEventListener("click", () => {
      timelineFilterDate = null;
      render();
    });
    wrap.appendChild(banner);
  }

  const visible = timelineFilterDate ? tasks.filter((t) => t.due === timelineFilterDate) : tasks;

  if (visible.length === 0) {
    const empty = document.createElement("p");
    empty.className = "tasklist__empty";
    empty.textContent = timelineFilterDate
      ? "No tasks due this day."
      : "No tasks yet. Add one above to see it on the timeline.";
    wrap.appendChild(empty);
  } else {
    // Undated tasks (only possible for ones created before due dates were
    // required) sort to the end rather than the front.
    visible
      .slice()
      .sort((a, b) => (a.due || "9999-99-99").localeCompare(b.due || "9999-99-99"))
      .forEach((task) => wrap.appendChild(renderTimelineRow(task)));
  }

  board.appendChild(wrap);
}

function renderTimelineRow(task) {
  const overdue = task.due && task.due < todayISO() && task.status !== "done";
  const project = task.projectId ? projects.find((p) => p.id === task.projectId) : null;

  const row = document.createElement("div");
  row.className = "listrow";
  row.dataset.status = task.status;
  row.innerHTML = `
    <div class="listrow__main">
      <span class="listrow__title"></span>
      <span class="listrow__meta">
        <span class="listrow__due ${overdue ? "is-overdue" : ""}">${task.due || "No due date"}</span>
        <span class="subtaskrow__status">${STATUS_LABEL[task.status] || task.status}</span>
        ${task.priority === "high" ? '<span class="card__priority-high">high</span>' : ""}
        ${project ? `<span class="card__project"></span>` : ""}
      </span>
    </div>
    <div class="listrow__actions">
      <button class="listrow__action listrow__action--danger" data-action="delete">Delete</button>
    </div>
  `;
  row.querySelector(".listrow__title").textContent = task.title;
  if (project) row.querySelector(".card__project").textContent = project.name;

  row.querySelector('[data-action="delete"]').addEventListener("click", (e) => {
    e.stopPropagation();
    deleteTask(task.id);
  });
  row.addEventListener("click", () => openPanel(task.id));

  return row;
}

/* ---------------------------------------------------------------
   Calendar view — a month grid with a due-task count per day;
   clicking a day drops into Timeline filtered to that date
---------------------------------------------------------------- */
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function renderCalendarView(board) {
  board.innerHTML = "";

  const { year, month } = calendarCursor;
  const firstOfMonth = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayStr = todayISO();

  const dueCounts = {};
  tasks.forEach((t) => {
    if (t.due) dueCounts[t.due] = (dueCounts[t.due] || 0) + 1;
  });

  const wrap = document.createElement("div");
  wrap.className = "calendar";

  const head = document.createElement("div");
  head.className = "calendar__head";
  head.innerHTML = `
    <button class="calendar__nav" type="button" data-nav="-1">‹</button>
    <span class="calendar__title">${firstOfMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</span>
    <button class="calendar__nav" type="button" data-nav="1">›</button>
    <button class="calendar__today" type="button">Today</button>
  `;
  head.querySelector('[data-nav="-1"]').addEventListener("click", () => shiftCalendarMonth(-1));
  head.querySelector('[data-nav="1"]').addEventListener("click", () => shiftCalendarMonth(1));
  head.querySelector(".calendar__today").addEventListener("click", goToCurrentMonth);
  wrap.appendChild(head);

  const grid = document.createElement("div");
  grid.className = "calendar__grid";

  WEEKDAY_LABELS.forEach((label) => {
    const cell = document.createElement("div");
    cell.className = "calendar__weekday";
    cell.textContent = label;
    grid.appendChild(cell);
  });

  for (let i = 0; i < firstOfMonth.getDay(); i++) {
    const filler = document.createElement("div");
    filler.className = "calendar__cell is-empty";
    grid.appendChild(filler);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const count = dueCounts[dateStr] || 0;

    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "calendar__cell";
    if (dateStr === todayStr) cell.classList.add("is-today");
    if (count > 0) cell.classList.add("has-tasks");
    cell.innerHTML = `
      <span class="calendar__day">${day}</span>
      ${count > 0 ? `<span class="calendar__count">${count}</span>` : ""}
    `;
    cell.addEventListener("click", () => openDayInTimeline(dateStr));
    grid.appendChild(cell);
  }

  wrap.appendChild(grid);
  board.appendChild(wrap);
}

function shiftCalendarMonth(delta) {
  let { year, month } = calendarCursor;
  month += delta;
  if (month < 0) {
    month = 11;
    year -= 1;
  } else if (month > 11) {
    month = 0;
    year += 1;
  }
  calendarCursor = { year, month };
  render();
}

function goToCurrentMonth() {
  calendarCursor = monthOf(new Date());
  render();
}

function openDayInTimeline(dateStr) {
  timelineFilterDate = dateStr;
  switchBoardMode("timeline");
}

function switchBoardMode(mode) {
  boardMode = mode;
  if (mode === "calendar") calendarCursor = monthOf(new Date());
  document.querySelectorAll(".viewswitch__btn").forEach((b) => {
    b.classList.toggle("is-active", b.dataset.mode === mode);
  });
  render();
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
  const budget = num(project.budget);
  const usedPct = budget > 0 ? Math.round((num(project.actualSpend) / budget) * 100) : null;

  const row = document.createElement("div");
  row.className = "listrow";
  row.innerHTML = `
    <div class="listrow__main">
      <span class="listrow__title"></span>
      <span class="listrow__meta">
        <span>${total ? `${done}/${total} done` : "No tasks yet"}</span>
        ${usedPct === null ? "" : `<span>${usedPct}% of budget</span>`}
      </span>
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

function num(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

const CURRENCY_SYMBOLS = { GBP: "£", USD: "$", EUR: "€" };

function money(n, currency) {
  const symbol = CURRENCY_SYMBOLS[currency] || CURRENCY_SYMBOLS.GBP;
  const sign = n < 0 ? "-" : "";
  return `${sign}${symbol}${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function pct(n) {
  return `${Math.round(n)}%`;
}

const PROJECT_FIELDS = [
  { key: "value", label: "Project value", type: "number", placeholder: "0" },
  { key: "budget", label: "Budget", type: "number", placeholder: "0" },
  { key: "actualSpend", label: "Actual spend", type: "number", placeholder: "0" },
  { key: "currency", label: "Currency", type: "select", options: ["GBP", "USD", "EUR"] },
  { key: "startDate", label: "Start date", type: "date" },
  { key: "endDate", label: "End date", type: "date" },
];

function renderProjectFields(project) {
  const wrap = document.createElement("div");
  wrap.className = "projectfields";
  wrap.innerHTML = PROJECT_FIELDS.map((f) => {
    const control =
      f.type === "select"
        ? `<select data-field="${f.key}">
            ${f.options
              .map((o) => `<option value="${o}" ${project[f.key] === o ? "selected" : ""}>${o}</option>`)
              .join("")}
          </select>`
        : `<input type="${f.type}" data-field="${f.key}" placeholder="${f.placeholder || ""}" value="${project[f.key] || ""}" />`;
    return `<label class="projectfields__field"><span>${f.label}</span>${control}</label>`;
  }).join("");

  // "change" (not "input") so the whole detail view — including these
  // fields — can safely re-render after each edit without stealing focus
  // out from under the user mid-keystroke.
  wrap.addEventListener("change", (e) => {
    const field = e.target.dataset.field;
    if (!field) return;
    updateProjectField(project.id, field, e.target.value);
  });

  return wrap;
}

function updateProjectField(id, field, value) {
  const project = projects.find((p) => p.id === id);
  if (!project) return;
  project[field] = value;
  persist();
  render();
}

// Days between two ISO date strings, or null if either is missing/invalid.
function daysBetween(fromISO, toISO) {
  if (!fromISO || !toISO) return null;
  const from = new Date(fromISO);
  const to = new Date(toISO);
  if (isNaN(from) || isNaN(to)) return null;
  return Math.round((to - from) / 86400000);
}

function projectTimelineText(project) {
  const totalDays = daysBetween(project.startDate, project.endDate);
  if (totalDays === null) return "Set start/end dates";
  const elapsed = daysBetween(project.startDate, todayISO());
  const pct = totalDays > 0 ? Math.min(100, Math.max(0, Math.round((elapsed / totalDays) * 100))) : 100;
  const daysLeft = daysBetween(todayISO(), project.endDate);
  if (daysLeft < 0) return `${pct}% elapsed · overdue by ${Math.abs(daysLeft)}d`;
  return `${pct}% elapsed · ${daysLeft}d left`;
}

function renderProjectMetrics(project) {
  const value = num(project.value);
  const budget = num(project.budget);
  const spend = num(project.actualSpend);
  const currency = project.currency || "GBP";
  const remaining = budget - spend;
  const usedPct = budget > 0 ? Math.round((spend / budget) * 100) : null;
  const actualMargin = value - spend;
  // Projected margin: what's left of the project value once the planned
  // budget (not actual spend) is accounted for — i.e. margin if spend
  // lands exactly on budget. Actual margin uses real spend instead.
  const projectedMarginPct = value > 0 ? ((value - budget) / value) * 100 : null;
  const actualMarginPct = value > 0 ? ((value - spend) / value) * 100 : null;

  const projectTasks = tasksForProject(project.id);
  const done = projectTasks.filter((t) => t.status === "done").length;

  const tiles = [
    { label: "Budget remaining", value: money(remaining, currency) },
    { label: "Budget used", value: usedPct === null ? "—" : `${usedPct}%` },
    { label: "Margin (value − spend)", value: money(actualMargin, currency) },
    { label: "Projected margin %", value: projectedMarginPct === null ? "—" : pct(projectedMarginPct) },
    { label: "Actual margin %", value: actualMarginPct === null ? "—" : pct(actualMarginPct) },
    { label: "Timeline", value: projectTimelineText(project) },
    { label: "Tasks done", value: projectTasks.length ? `${done}/${projectTasks.length}` : "—" },
  ];

  const wrap = document.createElement("div");
  wrap.className = "projectmetrics";
  wrap.innerHTML = tiles
    .map(
      (t) => `
      <div class="metric">
        <span class="metric__label">${t.label}</span>
        <span class="metric__value">${t.value}</span>
      </div>
    `
    )
    .join("");

  return wrap;
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

  wrap.appendChild(renderProjectFields(project));
  wrap.appendChild(renderProjectMetrics(project));

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
  projects.push({
    id: uid(),
    name,
    createdAt: todayISO(),
    value: "",
    budget: "",
    actualSpend: "",
    currency: "GBP",
    startDate: "",
    endDate: "",
  });
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
    due: defaultDueDate(),
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
      due: defaultDueDate(),
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

  document.querySelectorAll(".viewswitch__btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      // A manual switch to Timeline should show everything — the date
      // filter only makes sense as a result of clicking a Calendar day.
      if (btn.dataset.mode === "timeline") timelineFilterDate = null;
      switchBoardMode(btn.dataset.mode);
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
