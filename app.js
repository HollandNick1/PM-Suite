/* ================================================================
   Workbench — core app logic
   Data model, persisted as one object via the `store` object in
   github-sync.js (localStorage today, swappable for the GitHub API
   later without touching this file):

     {
       tasks:    [ ...board task objects, each with an optional projectId,
                    an optional start date (alongside the existing due
                    date), and dependencies: [ { taskId, lag } ] — other
                    tasks (same project) that must finish first, lag being
                    a day offset after that finish (negative = lead time).
                    Finish-to-start only, no auto-rescheduling: dependencies
                    are shown on the project Gantt view but dates stay
                    whatever the user sets ... ],
       projects: [ { id, name, createdAt,
                      value, budget, actualSpend,   // free-text numbers
                      currency,                      // "GBP" | "USD" | "EUR"
                      startDate, endDate,             // ISO date strings
                      parts: [ { id, name, quantity, unitCost, status } ] } ],
       trash:    [ ...deleted task objects, with deletedAt/prevStatus... ]
     }

   Parts are individual manufacturing items tracked per project — a
   physical thing with a quantity/cost/status, not work to be done, so
   they live on the project directly rather than as board tasks.

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

const PRIORITY_ORDER = { high: 0, normal: 1, low: 2 };

// Shared ordering for Kanban (within a column) and Timeline: soonest due
// date first (undated tasks last), then high-to-low priority as a tiebreak.
function byDueThenPriority(a, b) {
  const dueA = a.due || "9999-99-99";
  const dueB = b.due || "9999-99-99";
  if (dueA !== dueB) return dueA.localeCompare(dueB);
  return (PRIORITY_ORDER[a.priority] ?? 1) - (PRIORITY_ORDER[b.priority] ?? 1);
}

let tasks = [];
let projects = [];
let trash = [];

let activeTaskId = null;
let activeProjectId = null; // set while viewing a single project's sub-tasks
let projectTasksView = "list"; // "list" | "gantt" — only meaningful within a project's detail page
let currentView = "board"; // "board" | "projects" | "archive"
let boardMode = "kanban"; // "kanban" | "timeline" | "calendar" — only meaningful on the Board tab
let timelineFilterDate = null; // set by clicking a Calendar day; narrows Timeline to that date
let boardProjectFilter = ""; // project id, or "" for all — applies to Kanban and Timeline
let calendarCursor = monthOf(new Date());

function monthOf(date) {
  return { year: date.getFullYear(), month: date.getMonth() };
}

/* ---------------------------------------------------------------
   Bootstrapping
---------------------------------------------------------------- */
async function init() {
  initTheme();
  const state = await store.load();
  tasks = state.tasks;
  projects = state.projects;
  trash = state.trash;
  render();
  wireGlobalEvents();
  updateSyncIndicator();
}

const THEME_KEY = "workbench_theme";

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  document.getElementById("themeToggle").textContent = theme === "dark" ? "Light mode" : "Dark mode";
}

function initTheme() {
  applyTheme(localStorage.getItem(THEME_KEY) || "light");
}

function toggleTheme() {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
}

function uid() {
  return "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// Dates are always stored/compared as ISO ("YYYY-MM-DD" sorts and diffs
// correctly) but displayed as DD/MM/YYYY — this only ever touches display.
function formatDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
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
  // The whole Projects tab — the project list and every project's detail
  // page, in either List or Gantt mode — uses the full board width rather
  // than the narrow single-column layout Archive/Timeline still use.
  board.classList.toggle("is-wide", currentView === "projects");

  if (currentView === "board") {
    populateBoardProjectFilter();
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
  const projectFilter = document.getElementById("boardProjectFilter");
  // The top quick-add always creates a board task in the backlog, which
  // isn't relevant on the Projects tab (sub-tasks are added per-project)
  // or the Archive tab (a fresh task wouldn't show up there anyway).
  form.style.display = currentView === "board" ? "" : "none";
  viewSwitch.style.display = currentView === "board" ? "" : "none";
  // The project filter only makes sense for Kanban/Timeline's task lists,
  // not the Calendar (which shows due-date counts across every project).
  projectFilter.style.display = currentView === "board" && boardMode !== "calendar" ? "" : "none";
}

function populateBoardProjectFilter() {
  const select = document.getElementById("boardProjectFilter");
  const current = select.value;
  select.innerHTML =
    '<option value="">All projects</option>' +
    projects
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => `<option value="${p.id}">${p.name}</option>`)
      .join("");
  select.value = current;
}

/* ---------------------------------------------------------------
   Board view (Kanban)
---------------------------------------------------------------- */
function renderBoardView(board) {
  board.innerHTML = "";

  const visibleTasks = boardProjectFilter ? tasks.filter((t) => t.projectId === boardProjectFilter) : tasks;

  COLUMNS.forEach((col) => {
    const colTasks = visibleTasks.filter((t) => t.status === col.id);

    const colEl = document.createElement("div");
    colEl.className = "column";
    colEl.innerHTML = `
      <div class="column__head">
        <span class="column__title">${col.label}</span>
        <span class="column__count">${colTasks.length}</span>
      </div>
      <div class="column__body" data-status="${col.id}"></div>
    `;

    const body = colEl.querySelector(".column__body");
    colTasks
      .sort(byDueThenPriority)
      .forEach((task) => body.appendChild(renderCard(task)));

    // Lives inside the body (not after it) so it sits right under the last
    // card rather than getting pushed to the bottom of a stretched column —
    // the empty space below it is still part of the drop target either way.
    if (col.id === "backlog") {
      const addBtn = document.createElement("button");
      addBtn.className = "column__add";
      addBtn.type = "button";
      addBtn.textContent = "+ Add task";
      addBtn.addEventListener("click", () => quickAdd(""));
      body.appendChild(addBtn);
    }

    wireColumnDrop(body);
    board.appendChild(colEl);
  });
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
      <span>Showing tasks due <strong>${formatDate(timelineFilterDate)}</strong></span>
      <button class="timelinefilter__clear" type="button">Show all</button>
    `;
    banner.querySelector(".timelinefilter__clear").addEventListener("click", () => {
      timelineFilterDate = null;
      render();
    });
    wrap.appendChild(banner);
  }

  let visible = boardProjectFilter ? tasks.filter((t) => t.projectId === boardProjectFilter) : tasks;
  if (timelineFilterDate) visible = visible.filter((t) => t.due === timelineFilterDate);

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
      .sort(byDueThenPriority)
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
        <span class="listrow__due ${overdue ? "is-overdue" : ""}">${task.due ? formatDate(task.due) : "No due date"}</span>
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
      ${task.due ? `<span class="card__due ${overdue ? "is-overdue" : ""}">${formatDate(task.due)}</span>` : ""}
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
  const spend = num(project.actualSpend) + partsTotalCost(project);
  const usedPct = budget > 0 ? Math.round((spend / budget) * 100) : null;

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
  { key: "actualSpend", label: "Other spend (excl. parts)", type: "number", placeholder: "0" },
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
  const currency = project.currency || "GBP";
  const parts = projectParts(project);
  const partsCost = partsTotalCost(project);
  // Actual spend is manual entry (labour, misc costs) — parts cost is
  // tracked separately in its own table, so every budget/margin figure
  // has to add the two together to reflect what's really been spent.
  const spend = num(project.actualSpend) + partsCost;
  const remaining = budget - spend;
  const usedPct = budget > 0 ? Math.round((spend / budget) * 100) : null;
  const actualMargin = value - spend;
  // Projected margin: what's left of the project value once the planned
  // budget (not actual spend) is accounted for — i.e. margin if spend
  // lands exactly on budget. Actual margin uses real total spend instead.
  const projectedMarginPct = value > 0 ? ((value - budget) / value) * 100 : null;
  const actualMarginPct = value > 0 ? ((value - spend) / value) * 100 : null;

  const projectTasks = tasksForProject(project.id);
  const done = projectTasks.filter((t) => t.status === "done").length;

  const tiles = [
    { label: "Total spend (incl. parts)", value: money(spend, currency) },
    { label: "Budget remaining", value: money(remaining, currency) },
    { label: "Budget used", value: usedPct === null ? "—" : `${usedPct}%` },
    { label: "Margin (value − spend)", value: money(actualMargin, currency) },
    { label: "Projected margin %", value: projectedMarginPct === null ? "—" : pct(projectedMarginPct) },
    { label: "Actual margin %", value: actualMarginPct === null ? "—" : pct(actualMarginPct) },
    { label: "Timeline", value: projectTimelineText(project) },
    { label: "Tasks done", value: projectTasks.length ? `${done}/${projectTasks.length}` : "—" },
    { label: "Parts cost", value: parts.length ? money(partsCost, currency) : "—" },
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

/* ---------------------------------------------------------------
   Parts — individual manufacturing items tracked per project,
   separate from tasks (a part isn't work to do, it's a physical
   item with a quantity, a cost, and a manufacturing status)
---------------------------------------------------------------- */
const PART_STATUSES = ["Pending", "Ordered", "In production", "Received", "Delivered"];

function projectParts(project) {
  return project.parts || [];
}

function partsTotalCost(project) {
  return projectParts(project).reduce((sum, p) => sum + num(p.quantity) * num(p.unitCost), 0);
}

function addPart(projectId, name) {
  const project = projects.find((p) => p.id === projectId);
  if (!project) return;
  if (!project.parts) project.parts = [];
  project.parts.push({ id: uid(), name, quantity: "1", unitCost: "", status: PART_STATUSES[0] });
  persist();
  render();
}

function updatePartField(projectId, partId, field, value) {
  const project = projects.find((p) => p.id === projectId);
  if (!project) return;
  const part = projectParts(project).find((p) => p.id === partId);
  if (!part) return;
  part[field] = value;
  persist();
  render();
}

function deletePart(projectId, partId) {
  const project = projects.find((p) => p.id === projectId);
  if (!project) return;
  project.parts = projectParts(project).filter((p) => p.id !== partId);
  persist();
  render();
}

function renderProjectParts(project) {
  const wrap = document.createElement("div");
  wrap.className = "partswrap";

  const addForm = document.createElement("form");
  addForm.className = "inlineadd";
  addForm.innerHTML = `
    <input class="inlineadd__input" type="text" placeholder="Add a part…" autocomplete="off" />
    <button class="inlineadd__btn" type="submit">Add</button>
  `;
  addForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = addForm.querySelector(".inlineadd__input");
    const name = input.value.trim();
    if (!name) return;
    addPart(project.id, name);
  });
  wrap.appendChild(addForm);

  const parts = projectParts(project);
  if (parts.length === 0) {
    const empty = document.createElement("p");
    empty.className = "tasklist__empty";
    empty.textContent = "No parts yet. Add one above to start tracking manufacturing items.";
    wrap.appendChild(empty);
    return wrap;
  }

  const currency = project.currency || "GBP";

  const table = document.createElement("div");
  table.className = "partstable";
  table.innerHTML = `
    <div class="partrow partrow--head">
      <span>Part</span>
      <span>Qty</span>
      <span>Unit cost</span>
      <span>Total</span>
      <span>Status</span>
      <span></span>
    </div>
  `;

  parts.forEach((part) => {
    const total = num(part.quantity) * num(part.unitCost);
    const row = document.createElement("div");
    row.className = "partrow";
    row.innerHTML = `
      <span class="partrow__name"></span>
      <input type="number" min="0" data-field="quantity" value="${part.quantity || ""}" />
      <input type="number" min="0" data-field="unitCost" value="${part.unitCost || ""}" />
      <span class="partrow__total">${money(total, currency)}</span>
      <select data-field="status">
        ${PART_STATUSES.map((s) => `<option value="${s}" ${part.status === s ? "selected" : ""}>${s}</option>`).join("")}
      </select>
      <button class="listrow__action listrow__action--danger" type="button">Delete</button>
    `;
    row.querySelector(".partrow__name").textContent = part.name;
    row.querySelectorAll("[data-field]").forEach((el) => {
      el.addEventListener("change", (e) => updatePartField(project.id, part.id, e.target.dataset.field, e.target.value));
    });
    row.querySelector(".listrow__action--danger").addEventListener("click", () => deletePart(project.id, part.id));
    table.appendChild(row);
  });

  wrap.appendChild(table);
  return wrap;
}

/* ---------------------------------------------------------------
   Gantt view — a simple day-scaled bar chart of a project's tasks,
   with dependency connectors drawn between predecessor and successor
   bars (finish-to-start; the lag is only shown as a label, dates are
   never auto-shifted).
---------------------------------------------------------------- */
const GANTT_ROW_H = 40;
const GANTT_HEAD_H = 28;
const GANTT_VISIBLE_ROWS = 10;

// A task can't start before its dependencies allow: for each one, the
// predecessor's own due date plus that link's lag/lead is the earliest
// this task could begin. The calculated start is whichever is later —
// that constraint, or the task's own manually-set start (never earlier).
// Due dates are fixed by the user, so this doesn't cascade through a
// predecessor's own calculated start — only its due date is used.
// Builds calculated start/end for every task in a project, cascading
// through the whole dependency chain: a task's calculated date is driven
// by its predecessors' calculated finish (not their raw due date), so a
// task pushed out by ITS OWN dependencies passes that push downstream.
// When a task has dependencies, they fully determine its calculated
// start (the latest predecessor-finish-plus-lag) — its own start/due
// field only matters as a baseline for tasks with no dependencies, and
// to preserve each task's planned duration once it does get pushed.
function computeProjectSchedule(projectTasks) {
  const byId = new Map(projectTasks.map((t) => [t.id, t]));
  const startCache = new Map();
  const endCache = new Map();
  const visiting = new Set(); // cycle guard

  function plannedStart(t) {
    return t.start || t.due;
  }
  function plannedDuration(t) {
    const s = plannedStart(t);
    if (!s || !t.due) return 0;
    return Math.max(0, daysBetween(s, t.due) || 0);
  }

  function calcStart(id) {
    if (startCache.has(id)) return startCache.get(id);
    const t = byId.get(id);
    if (!t) return null;
    if (visiting.has(id)) return plannedStart(t); // break cycles rather than recurse forever
    visiting.add(id);

    let start = plannedStart(t);
    const deps = t.dependencies || [];
    let latest = null;
    deps.forEach((dep) => {
      const predEnd = calcEnd(dep.taskId);
      if (!predEnd) return;
      const d = new Date(predEnd);
      // A predecessor's due date is fully occupied by it, so a successor
      // starts the day after by default (0 lag) — lag/lead is an
      // additional adjustment on top of that natural one-day gap.
      d.setDate(d.getDate() + 1 + num(dep.lag));
      const candidate = d.toISOString().slice(0, 10);
      if (latest === null || candidate > latest) latest = candidate;
    });
    if (latest !== null) start = latest; // dependencies fully drive the date, not just a floor on it

    visiting.delete(id);
    startCache.set(id, start);
    return start;
  }

  function calcEnd(id) {
    if (endCache.has(id)) return endCache.get(id);
    const t = byId.get(id);
    if (!t) return null;
    const start = calcStart(id);
    if (!start) return null;
    const d = new Date(start);
    d.setDate(d.getDate() + plannedDuration(t));
    const end = d.toISOString().slice(0, 10);
    endCache.set(id, end);
    return end;
  }

  return { calcStart, calcEnd };
}

function renderProjectGantt(project) {
  const wrap = document.createElement("div");
  wrap.className = "ganttwrap";

  const projectTasks = tasksForProject(project.id).filter((t) => t.due || t.start);
  const schedule = computeProjectSchedule(projectTasks);

  // The bar spans the calculated start/end (cascaded through the whole
  // dependency chain, preserving each task's planned duration); if that
  // calculated finish lands after the task's own due date, it's flagged
  // as a conflict rather than silently missing the deadline.
  const span = (t) => {
    const start = schedule.calcStart(t.id) || t.due;
    const end = schedule.calcEnd(t.id) || start;
    return { start, end, conflict: !!(t.due && end > t.due) };
  };

  if (projectTasks.length === 0) {
    const empty = document.createElement("p");
    empty.className = "tasklist__empty";
    empty.textContent = "No dated tasks yet. Set a due date (and optionally a start date) on a task to see it here.";
    wrap.appendChild(empty);
    return wrap;
  }

  const allDates = [];
  projectTasks.forEach((t) => {
    const s = span(t);
    allDates.push(s.start, s.end);
  });
  const dayMs = 86400000;
  const rangeStart = new Date(allDates.reduce((a, b) => (a < b ? a : b)));
  rangeStart.setDate(rangeStart.getDate() - 1);
  const rangeEnd = new Date(allDates.reduce((a, b) => (a > b ? a : b)));
  rangeEnd.setDate(rangeEnd.getDate() + 2);

  const totalDays = Math.max(1, Math.round((rangeEnd - rangeStart) / dayMs));
  const pxPerDay = totalDays > 90 ? 12 : totalDays > 45 ? 18 : totalDays > 20 ? 28 : 40;
  const chartWidth = totalDays * pxPerDay;
  const xFor = (iso) => Math.round(((new Date(iso) - rangeStart) / dayMs) * pxPerDay);

  const sorted = projectTasks.slice().sort((a, b) => span(a).start.localeCompare(span(b).start));

  const layout = document.createElement("div");
  layout.className = "gantt__layout";
  layout.style.maxHeight = GANTT_HEAD_H + GANTT_VISIBLE_ROWS * GANTT_ROW_H + "px";

  // Sidebar — task names, fixed width, scrolls vertically with the chart
  const sidebar = document.createElement("div");
  sidebar.className = "gantt__sidebar";
  const sidebarHead = document.createElement("div");
  sidebarHead.className = "gantt__sidebar-head";
  sidebarHead.style.height = GANTT_HEAD_H + "px";
  sidebarHead.textContent = "Task";
  sidebar.appendChild(sidebarHead);
  sorted.forEach((task) => {
    const nameRow = document.createElement("div");
    nameRow.className = "gantt__name";
    nameRow.style.height = GANTT_ROW_H + "px";
    nameRow.textContent = task.title;
    nameRow.title = task.title;
    nameRow.addEventListener("click", () => openPanel(task.id));
    sidebar.appendChild(nameRow);
  });
  layout.appendChild(sidebar);

  // Header — date ticks
  const header = document.createElement("div");
  header.className = "gantt__header";
  header.style.width = chartWidth + "px";
  header.style.height = GANTT_HEAD_H + "px";
  const tickEvery = totalDays > 60 ? 14 : totalDays > 30 ? 7 : totalDays > 14 ? 3 : 1;
  for (let d = 0; d <= totalDays; d += tickEvery) {
    const tickDate = new Date(rangeStart.getTime() + d * dayMs);
    const tick = document.createElement("span");
    tick.className = "gantt__tick";
    tick.style.left = d * pxPerDay + "px";
    tick.textContent = formatDate(tickDate.toISOString().slice(0, 10)).slice(0, 5);
    header.appendChild(tick);
  }

  // Chart — bars + dependency connectors, absolutely positioned
  const chart = document.createElement("div");
  chart.className = "gantt__chart";
  chart.style.width = chartWidth + "px";
  chart.style.height = sorted.length * GANTT_ROW_H + "px";

  const todayStr = todayISO();
  if (todayStr >= rangeStart.toISOString().slice(0, 10) && todayStr <= rangeEnd.toISOString().slice(0, 10)) {
    const todayLine = document.createElement("div");
    todayLine.className = "gantt__today";
    todayLine.style.left = xFor(todayStr) + "px";
    chart.appendChild(todayLine);
  }

  const barRects = new Map();
  sorted.forEach((task, i) => {
    const { start, end, conflict } = span(task);
    const x1 = xFor(start);
    const x2 = Math.max(x1 + pxPerDay * 0.6, xFor(end) + pxPerDay);
    barRects.set(task.id, { x1, x2, y: i * GANTT_ROW_H + GANTT_ROW_H / 2 });

    const row = document.createElement("div");
    row.className = "gantt__row";
    row.style.top = i * GANTT_ROW_H + "px";
    row.style.height = GANTT_ROW_H + "px";

    const bar = document.createElement("div");
    bar.className = "gantt__bar";
    if (task.status === "done") bar.classList.add("is-done");
    if (conflict) bar.classList.add("is-conflict");
    bar.style.left = x1 + "px";
    bar.style.width = x2 - x1 + "px";
    bar.title = task.title + (conflict ? " — dependencies push the start past its due date" : "");
    bar.textContent = task.title;
    bar.addEventListener("click", () => openPanel(task.id));
    row.appendChild(bar);
    chart.appendChild(row);
  });

  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("class", "gantt__deps");
  svg.setAttribute("width", chartWidth);
  svg.setAttribute("height", sorted.length * GANTT_ROW_H);

  const DEP_STUB = 14;
  sorted.forEach((task) => {
    (task.dependencies || []).forEach((dep) => {
      const from = barRects.get(dep.taskId);
      const to = barRects.get(task.id);
      if (!from || !to) return; // predecessor has no due date, so isn't on this chart

      let d, labelX, labelY;
      if (to.x1 - DEP_STUB >= from.x2 + DEP_STUB) {
        // Enough room: a simple step out of the predecessor and into the
        // successor's left edge, approaching left-to-right the whole way.
        const midX = from.x2 + DEP_STUB;
        d = `M ${from.x2} ${from.y} H ${midX} V ${to.y} H ${to.x1}`;
        labelX = midX + 3;
        labelY = (from.y + to.y) / 2 - 3;
      } else {
        // Not enough horizontal gap — a direct step would have to run
        // backwards through the successor bar to reach its left edge.
        // Loop out and around via the gutter between the two rows instead,
        // so the final approach is still always left-to-right into the bar.
        const outX = from.x2 + DEP_STUB;
        const approachX = to.x1 - DEP_STUB;
        const gutterY = (from.y + to.y) / 2;
        d = `M ${from.x2} ${from.y} H ${outX} V ${gutterY} H ${approachX} V ${to.y} H ${to.x1}`;
        labelX = outX + 3;
        labelY = (from.y + gutterY) / 2 - 3;
      }

      const path = document.createElementNS(svgNS, "path");
      path.setAttribute("d", d);
      path.setAttribute("class", "gantt__deplink");
      svg.appendChild(path);

      if (num(dep.lag) !== 0) {
        const label = document.createElementNS(svgNS, "text");
        label.setAttribute("x", labelX);
        label.setAttribute("y", labelY);
        label.setAttribute("class", "gantt__deplabel");
        label.textContent = (num(dep.lag) > 0 ? "+" : "") + num(dep.lag) + "d";
        svg.appendChild(label);
      }
    });
  });
  chart.appendChild(svg);

  const scrollArea = document.createElement("div");
  scrollArea.className = "gantt__scroll";
  scrollArea.appendChild(header);
  scrollArea.appendChild(chart);
  layout.appendChild(scrollArea);

  wrap.appendChild(layout);
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

  const tasksHead = document.createElement("div");
  tasksHead.className = "sectionhead-row";
  tasksHead.innerHTML = `
    <h3 class="section-title">Tasks</h3>
    <div class="viewswitch">
      <button class="viewswitch__btn ${projectTasksView === "list" ? "is-active" : ""}" data-taskview="list" type="button">List</button>
      <button class="viewswitch__btn ${projectTasksView === "gantt" ? "is-active" : ""}" data-taskview="gantt" type="button">Gantt</button>
    </div>
  `;
  tasksHead.querySelectorAll("[data-taskview]").forEach((btn) => {
    btn.addEventListener("click", () => {
      projectTasksView = btn.dataset.taskview;
      render();
    });
  });
  wrap.appendChild(tasksHead);

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

  if (projectTasksView === "gantt") {
    wrap.appendChild(renderProjectGantt(project));
  } else {
    const projectTasks = tasksForProject(project.id);
    if (projectTasks.length === 0) {
      const empty = document.createElement("p");
      empty.className = "tasklist__empty";
      empty.textContent = "No tasks yet. Add one above, or assign an existing board task to this project from its detail panel.";
      wrap.appendChild(empty);
    } else {
      projectTasks.forEach((task) => wrap.appendChild(renderProjectTaskRow(task)));
    }
  }

  const partsHead = document.createElement("h3");
  partsHead.className = "section-title";
  partsHead.textContent = "Parts";
  wrap.appendChild(partsHead);
  wrap.appendChild(renderProjectParts(project));

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
    parts: [],
  });
  persist();
  render();
}

function openProject(id) {
  activeProjectId = id;
  projectTasksView = "list";
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
    start: "",
    due: defaultDueDate(),
    order: Date.now(),
    created: todayISO(),
    projectId,
    dependencies: [],
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
    const bulkHead = document.createElement("div");
    bulkHead.className = "sectionhead-row";
    bulkHead.innerHTML = `
      <span></span>
      <div class="archive__bulk">
        <button class="listrow__action" type="button" data-bulk="restore">Restore all</button>
        <button class="listrow__action listrow__action--danger" type="button" data-bulk="purge">Delete all</button>
      </div>
    `;
    bulkHead.querySelector('[data-bulk="restore"]').addEventListener("click", restoreAllFromTrash);
    bulkHead.querySelector('[data-bulk="purge"]').addEventListener("click", purgeAllFromTrash);
    wrap.appendChild(bulkHead);

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
      <span class="listrow__meta">Deleted ${formatDate(entry.deletedAt)}</span>
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

function restoreAllFromTrash() {
  if (trash.length === 0) return;
  trash.forEach((entry) => {
    const { deletedAt, prevStatus, ...task } = entry;
    task.status = prevStatus || "backlog";
    tasks.push(task);
  });
  trash = [];
  persist();
  render();
}

function purgeAllFromTrash() {
  if (trash.length === 0) return;
  if (!confirm(`Permanently delete all ${trash.length} archived task${trash.length === 1 ? "" : "s"}? This can't be undone.`)) return;
  trash = [];
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
      start: "",
      due: defaultDueDate(),
      order: Date.now(),
      created: todayISO(),
      projectId: "",
      dependencies: [],
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

  ["panelTitle", "panelNotes", "panelStatus", "panelStart", "panelDue", "panelPriority", "panelProject"].forEach((id) => {
    document.getElementById(id).addEventListener("input", saveActiveTaskFromPanel);
    document.getElementById(id).addEventListener("change", saveActiveTaskFromPanel);
  });

  document.getElementById("panelDepsAdd").addEventListener("click", () => {
    const depId = document.getElementById("panelDepsSelect").value;
    const lag = document.getElementById("panelDepsLag").value;
    addDependency(activeTaskId, depId, lag);
    document.getElementById("panelDepsLag").value = "0";
  });

  document.getElementById("syncBtn").addEventListener("click", () => {
    store.connect().then(() => {
      updateSyncIndicator();
      init();
    });
  });

  document.getElementById("themeToggle").addEventListener("click", toggleTheme);

  document.getElementById("boardProjectFilter").addEventListener("change", (e) => {
    boardProjectFilter = e.target.value;
    render();
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
  document.getElementById("panelStart").value = task.start || "";
  document.getElementById("panelDue").value = task.due || "";
  document.getElementById("panelPriority").value = task.priority || "normal";
  populateProjectSelect(task.projectId);
  populateDependencyUI(task);
  document.getElementById("panelMeta").textContent = `Created ${formatDate(task.created)} · ${task.id}`;

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
  task.start = document.getElementById("panelStart").value;
  task.due = document.getElementById("panelDue").value;
  task.priority = document.getElementById("panelPriority").value;

  const newProjectId = document.getElementById("panelProject").value;
  if (newProjectId !== task.projectId) {
    // Dependencies only make sense within one project's task list, so
    // moving a task to a different project (or off one) drops them.
    task.dependencies = [];
    task.projectId = newProjectId;
    populateDependencyUI(task);
  }

  persist();
  render();
}

/* ---------------------------------------------------------------
   Task dependencies (finish-to-start, with lead/lag in days) —
   only offered for tasks that belong to a project, since the picker
   lists that project's other tasks as possible predecessors.
---------------------------------------------------------------- */
function populateDependencyUI(task) {
  const section = document.getElementById("panelDeps");
  const select = document.getElementById("panelDepsSelect");

  if (!task.projectId) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  const candidates = tasksForProject(task.projectId).filter((t) => t.id !== task.id);
  select.innerHTML = candidates.map((t) => `<option value="${t.id}">${t.title}</option>`).join("");

  renderDependencyList(task);
}

function renderDependencyList(task) {
  const list = document.getElementById("panelDepsList");
  const deps = task.dependencies || [];

  if (deps.length === 0) {
    list.innerHTML = '<p class="panel__deps-empty">No dependencies — this task can start any time.</p>';
    return;
  }

  list.innerHTML = deps
    .map((dep) => {
      const predecessor = tasks.find((t) => t.id === dep.taskId);
      const name = predecessor ? predecessor.title : "(deleted task)";
      const lag = num(dep.lag);
      const lagText = lag === 0 ? "starts next day" : lag > 0 ? `+${lag}d lag` : `${lag}d lead`;
      return `
        <div class="panel__dep" data-dep-id="${dep.taskId}">
          <span>${name} <span class="panel__dep-lag">(${lagText})</span></span>
          <button type="button" data-remove-dep="${dep.taskId}">Remove</button>
        </div>
      `;
    })
    .join("");

  list.querySelectorAll("[data-remove-dep]").forEach((btn) => {
    btn.addEventListener("click", () => {
      removeDependency(task.id, btn.dataset.removeDep);
    });
  });
}

function addDependency(taskId, depId, lag) {
  const task = tasks.find((t) => t.id === taskId);
  if (!task || !depId || depId === taskId) return;
  if (!task.dependencies) task.dependencies = [];
  if (task.dependencies.some((d) => d.taskId === depId)) return;
  task.dependencies.push({ taskId: depId, lag: num(lag) });
  persist();
  renderDependencyList(task);
  render();
}

function removeDependency(taskId, depId) {
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return;
  task.dependencies = (task.dependencies || []).filter((d) => d.taskId !== depId);
  persist();
  renderDependencyList(task);
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
