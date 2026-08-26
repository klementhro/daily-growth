const PROJECTS = [
  { id: "english", name: "学个英语", color: "var(--english-color)" },
  { id: "lacquer", name: "做个大漆", color: "var(--lacquer-color)" },
  { id: "dance", name: "杂七杂八", color: "var(--misc-color)" }
];
const LEGACY_STORAGE_KEY = "daily-growth:v1";
const DB_NAME = "daily-growth";
const DB_VERSION = 1;
const STATE_STORE = "state";
const MEDIA_STORE = "media";
const MAX_FILES = 5;
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const MAX_RECORD_MEDIA_SIZE = 50 * 1024 * 1024;
const $ = (selector) => document.querySelector(selector);
let data = {};
let database;
let fallbackToLocalStorage = false;
let activeProject;
let activeAttachments = [];
let viewerUrl;
let selectedHistoryDate;
let historyFilter = { applied: false, year: "", month: "", date: "", start: "", end: "" };
let filterMode = "year";

const localDate = (date = new Date()) => {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
};
const displayDate = (key) => new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "short" }).format(new Date(`${key}T12:00:00`));
const displayMonth = (key) => new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long" }).format(new Date(`${key}-01T12:00:00`));
const readLegacyData = () => { try { return JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY)) || {}; } catch { return {}; } };

function projectRecords(day, projectId) {
  const value = day?.[projectId];
  return Array.isArray(value) ? value : value ? [value] : [];
}

function isDone(record) {
  return Boolean(record && (Number(record.minutes) > 0 || record.title || record.content || record.notes || record.media?.length));
}

function dayHasRecords(day) {
  return PROJECTS.some((project) => projectRecords(day, project.id).some(isDone));
}

function doneCount(day) {
  return PROJECTS.filter((project) => projectRecords(day, project.id).some(isDone)).length;
}

function formatMinutes(value) {
  const minutes = Math.max(0, Math.round(Number(value) || 0));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest}分钟`;
  return `${hours}小时${rest ? `${rest}分钟` : ""}`;
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error("本地数据库写入失败。"));
    transaction.onabort = () => reject(transaction.error || new Error("本地数据库写入失败。"));
  });
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STATE_STORE)) db.createObjectStore(STATE_STORE);
      if (!db.objectStoreNames.contains(MEDIA_STORE)) db.createObjectStore(MEDIA_STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readRecords() {
  const transaction = database.transaction(STATE_STORE, "readonly");
  const request = transaction.objectStore(STATE_STORE).get("records");
  const value = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  await transactionDone(transaction);
  return value;
}

async function saveRecords() {
  if (fallbackToLocalStorage) return localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(data));
  const transaction = database.transaction(STATE_STORE, "readwrite");
  transaction.objectStore(STATE_STORE).put(data, "records");
  await transactionDone(transaction);
}

async function saveImage(image) {
  if (fallbackToLocalStorage) throw new Error("当前浏览器无法保存图片，请使用 Safari 的正常浏览模式后重试。");
  const transaction = database.transaction(MEDIA_STORE, "readwrite");
  transaction.objectStore(MEDIA_STORE).put(image);
  await transactionDone(transaction);
}

async function getImage(id) {
  if (fallbackToLocalStorage) return undefined;
  const transaction = database.transaction(MEDIA_STORE, "readonly");
  const request = transaction.objectStore(MEDIA_STORE).get(id);
  const result = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  await transactionDone(transaction);
  return result?.blob;
}

async function deleteImages(ids) {
  if (fallbackToLocalStorage || !ids.length) return;
  const transaction = database.transaction(MEDIA_STORE, "readwrite");
  const store = transaction.objectStore(MEDIA_STORE);
  ids.forEach((id) => store.delete(id));
  await transactionDone(transaction);
}

async function initialiseStorage() {
  try {
    database = await openDatabase();
    const saved = await readRecords();
    if (saved) data = saved;
    else {
      data = readLegacyData();
      await saveRecords();
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    }
  } catch (error) {
    fallbackToLocalStorage = true;
    data = readLegacyData();
    console.warn("IndexedDB unavailable", error);
  }
}

function streakDays(records, today = localDate()) {
  let streak = 0;
  const cursor = new Date(`${today}T12:00:00`);
  while (dayHasRecords(records[localDate(cursor)])) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

function clearPreviewUrls(container) {
  (container._previewUrls || []).forEach((url) => URL.revokeObjectURL(url));
  container._previewUrls = [];
}

function newImageId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function makeImage(file) {
  return { id: newImageId(), name: file.name || "未命名图片", type: file.type, size: file.size, file };
}

function imageError(files, images) {
  if (images.length + files.length > MAX_FILES) return `每条记录最多添加 ${MAX_FILES} 张图片。`;
  for (const file of files) {
    if (!file.type.startsWith("image/")) return `「${file.name}」不是图片，请从相册选择图片。`;
    if (file.size > MAX_IMAGE_SIZE) return `图片「${file.name}」超过 10MB，请压缩后再上传。`;
  }
  const total = [...images, ...files].reduce((sum, item) => sum + (item.size || 0), 0);
  return total > MAX_RECORD_MEDIA_SIZE ? "这一条记录的图片总大小不能超过 50MB。" : "";
}

async function ensureStorageSpace(files) {
  if (!navigator.storage?.estimate || !files.length) return;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  const incoming = files.reduce((sum, file) => sum + file.size, 0);
  if (quota && usage + incoming > quota * 0.9) throw new Error("手机本地存储空间不足，请删除一些旧图片后重试。");
}

function closeImageViewer() {
  $("#media-viewer").hidden = true;
  $("#media-viewer img").removeAttribute("src");
  if (viewerUrl) URL.revokeObjectURL(viewerUrl);
  viewerUrl = undefined;
}

function showImage(blob) {
  closeImageViewer();
  viewerUrl = URL.createObjectURL(blob);
  $("#media-viewer img").src = viewerUrl;
  $("#media-viewer").hidden = false;
}

async function renderImages(container, images, { editable = false, onRemove } = {}) {
  clearPreviewUrls(container);
  const renderId = Symbol("image-render");
  container._imageRenderId = renderId;
  container.replaceChildren();
  for (const image of images || []) {
    const blob = image.file || await getImage(image.id);
    if (!blob || !blob.type.startsWith("image/") || !container.isConnected || container._imageRenderId !== renderId) continue;
    const url = URL.createObjectURL(blob);
    container._previewUrls.push(url);
    const item = document.createElement("div");
    const trigger = document.createElement("button");
    const preview = document.createElement("img");
    item.className = "media-item";
    trigger.className = "image-trigger";
    trigger.type = "button";
    preview.src = url;
    preview.alt = image.name || "打卡图片";
    trigger.append(preview);
    trigger.addEventListener("click", () => showImage(blob));
    item.append(trigger);
    if (editable) {
      const remove = document.createElement("button");
      remove.className = "media-remove";
      remove.type = "button";
      remove.setAttribute("aria-label", `移除 ${image.name}`);
      remove.textContent = "×";
      remove.addEventListener("click", () => onRemove(image.id));
      item.append(remove);
    }
    container.append(item);
  }
}

function showSuccess(project) {
  $("#success-title").textContent = `${project.name} 打卡成功`;
  $("#success-modal").hidden = false;
}

function closeSuccess() {
  $("#success-modal").hidden = true;
  closeCheckin();
}

function renderToday() {
  const today = localDate();
  const day = data[today] || {};
  const completed = doneCount(day);
  $("#today-label").textContent = displayDate(today);
  $("#streak-count").textContent = streakDays(data, today);
  $("#completion-copy").textContent = completed ? `今天已完成 ${completed} / ${PROJECTS.length} 项` : "今天还未开始";
  const list = $("#project-list");
  list.replaceChildren();
  PROJECTS.forEach((project) => {
    const checkedIn = projectRecords(day, project.id).some(isDone);
    const card = document.createElement("button");
    const copy = document.createElement("span");
    const heading = document.createElement("h3");
    const note = document.createElement("p");
    card.className = "project-card";
    card.type = "button";
    card.style.setProperty("--project", project.color);
    heading.textContent = project.name;
    if (checkedIn) {
      const check = document.createElement("span");
      check.className = "done-check";
      check.setAttribute("aria-label", "今天已打卡");
      check.textContent = " ✓";
      heading.append(check);
    }
    note.textContent = checkedIn ? "今天已打卡" : "点击开始打卡";
    copy.append(heading, note);
    card.append(copy);
    const arrow = document.createElement("span");
    arrow.className = "arrow";
    arrow.textContent = "›";
    card.append(arrow);
    card.addEventListener("click", () => openCheckin(project));
    list.append(card);
  });
}

function openCheckin(project) {
  activeProject = project;
  activeAttachments = [];
  const count = projectRecords(data[localDate()], project.id).length;
  $("#checkin-heading").textContent = `${project.name}打卡页面`;
  $("#checkin-mark").style.background = project.color;
  $("#checkin-status").textContent = count ? `今天已有 ${count} 条记录，可继续添加` : "填写今天的打卡";
  $("#title-field").hidden = project.id !== "dance";
  $("#checkin-title").value = "";
  $("#checkin-content").value = "";
  $("#checkin-minutes").value = "";
  $("#checkin-notes").value = "";
  $("#media-input").value = "";
  $("#save-checkin").disabled = false;
  $("#save-checkin").textContent = "保存记录";
  renderImages($("#media-preview"), activeAttachments, { editable: true, onRemove: removeActiveImage });
  showView("checkin-view");
  window.scrollTo(0, 0);
}

function closeCheckin() {
  clearPreviewUrls($("#media-preview"));
  activeProject = undefined;
  activeAttachments = [];
  showView("today-view");
  renderToday();
}

function removeActiveImage(id) {
  activeAttachments = activeAttachments.filter((image) => image.id !== id);
  renderImages($("#media-preview"), activeAttachments, { editable: true, onRemove: removeActiveImage });
}

async function saveCheckin() {
  if (!activeProject) return;
  const saveButton = $("#save-checkin");
  if (saveButton.disabled) return;
  const title = activeProject.id === "dance" ? $("#checkin-title").value.trim() : "";
  const content = $("#checkin-content").value.trim();
  const minutes = Math.max(0, Number($("#checkin-minutes").value) || 0);
  const notes = $("#checkin-notes").value.trim();
  if (!(title || content || minutes || notes || activeAttachments.length)) return alert("请至少填写打卡内容、时间、备注或添加一张图片。");
  const today = localDate();
  const previousDay = data[today] && { ...data[today] };
  const savedImageIds = [];
  saveButton.disabled = true;
  saveButton.textContent = "保存中…";
  try {
    await ensureStorageSpace(activeAttachments.map((image) => image.file));
    for (const image of activeAttachments) {
      const { file, ...metadata } = image;
      await saveImage({ ...metadata, blob: file });
      savedImageIds.push(image.id);
    }
    data[today] ||= {};
    const existing = projectRecords(data[today], activeProject.id);
    data[today][activeProject.id] = [...existing, { title, content, minutes, notes, media: activeAttachments.map(({ file, ...image }) => image) }];
    await saveRecords();
    renderToday(); renderHistory(); renderStats();
    showSuccess(activeProject);
  } catch (error) {
    try { await deleteImages(savedImageIds); } catch (cleanupError) { console.warn("未能清理未保存的图片", cleanupError); }
    if (previousDay) data[today] = previousDay;
    else delete data[today];
    console.error(error);
    alert(error.message || "保存失败，请检查手机存储空间后重试。");
    saveButton.disabled = false;
    saveButton.textContent = "保存记录";
  }
}

function daySummary(day) {
  const result = [];
  PROJECTS.slice(0, 2).forEach((project) => {
    const records = projectRecords(day, project.id).filter(isDone);
    if (!records.length) return;
    result.push({ label: project.name, minutes: records.reduce((sum, record) => sum + (Number(record.minutes) || 0), 0), color: project.color, yellow: false });
  });
  const titles = new Map();
  projectRecords(day, "dance").filter(isDone).forEach((record) => {
    const title = record.title || "杂七杂八";
    titles.set(title, (titles.get(title) || 0) + (Number(record.minutes) || 0));
  });
  titles.forEach((minutes, label) => result.push({ label, minutes, color: PROJECTS[2].color, yellow: true }));
  return result;
}

function populateYearOptions() {
  const select = $("#filter-year");
  const current = select.value;
  const years = [...new Set(Object.keys(data).filter((date) => dayHasRecords(data[date])).map((date) => date.slice(0, 4)))].sort();
  select.replaceChildren(new Option("选择年份", ""));
  years.forEach((year) => select.append(new Option(`${year}年`, year)));
  select.value = years.includes(current) ? current : "";
}

function historyDates() {
  let dates = Object.keys(data).filter((date) => dayHasRecords(data[date]));
  const { applied, year, month, date, start, end } = historyFilter;
  if (applied) {
    if (date) dates = dates.filter((key) => key === date);
    else if (start || end) dates = dates.filter((key) => (!start || key >= start) && (!end || key <= end));
    else dates = dates.filter((key) => (!year || key.slice(0, 4) === year) && (!month || Number(key.slice(5, 7)) === Number(month)));
  }
  return dates.sort((a, b) => applied ? a.localeCompare(b) : b.localeCompare(a));
}

function groupedHistoryDates(dates) {
  const keys = new Set(dates.map((date) => date.slice(0, 7)));
  const groupForYear = historyFilter.applied && historyFilter.year && !historyFilter.month && !historyFilter.date && !historyFilter.start && !historyFilter.end;
  const groupForRange = historyFilter.applied && (historyFilter.start || historyFilter.end) && keys.size > 1;
  if (!groupForYear && !groupForRange) return [];
  const groups = new Map();
  dates.forEach((date) => {
    const key = date.slice(0, 7);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(date);
  });
  return [...groups.entries()];
}

function makeHistoryCard(date) {
  const card = document.createElement("button");
  const header = document.createElement("header");
  const time = document.createElement("time");
  const chevron = document.createElement("span");
  const summaries = document.createElement("div");
  card.className = "history-row";
  card.type = "button";
  time.textContent = displayDate(date);
  chevron.className = "history-chevron";
  chevron.textContent = "›";
  header.append(time, chevron);
  summaries.className = "day-summary";
  const overview = daySummary(data[date]);
  overview.filter((summary) => !summary.yellow).forEach((summary) => {
    const group = document.createElement("section");
    const name = document.createElement("strong");
    const duration = document.createElement("span");
    group.className = "day-project";
    group.style.setProperty("--project", summary.color);
    name.textContent = summary.label;
    duration.textContent = formatMinutes(summary.minutes);
    group.append(name, duration);
    summaries.append(group);
  });
  const misc = overview.filter((summary) => summary.yellow);
  if (misc.length) {
    const group = document.createElement("section");
    const name = document.createElement("strong");
    const items = document.createElement("div");
    group.className = "day-project day-project-misc";
    group.style.setProperty("--project", PROJECTS[2].color);
    name.textContent = PROJECTS[2].name;
    items.className = "misc-summary-list";
    misc.forEach((summary) => {
      const item = document.createElement("div");
      const title = document.createElement("span");
      const duration = document.createElement("span");
      title.textContent = summary.label;
      duration.textContent = formatMinutes(summary.minutes);
      item.append(title, duration);
      items.append(item);
    });
    group.append(name, items);
    summaries.append(group);
  }
  card.append(header, summaries);
  card.addEventListener("click", () => openHistoryDay(date));
  return card;
}

function renderMonthJump(groups) {
  const jump = $("#month-jump");
  jump.replaceChildren();
  if (!groups.length) { jump.hidden = true; return; }
  groups.forEach(([month]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = displayMonth(month);
    button.addEventListener("click", () => {
      document.getElementById(`month-${month}`).scrollIntoView({ behavior: "smooth", block: "start" });
      jump.querySelectorAll("button").forEach((item) => item.classList.toggle("is-active", item === button));
    });
    jump.append(button);
  });
  jump.hidden = false;
}

function filterDescription() {
  if (!historyFilter.applied) return "";
  if (historyFilter.date) return `筛选：${historyFilter.date.replaceAll("-", "/")}`;
  if (historyFilter.start || historyFilter.end) return `筛选：${historyFilter.start.replaceAll("-", "/") || "最早"} - ${historyFilter.end.replaceAll("-", "/") || "今天"}`;
  if (historyFilter.month) return `筛选：${historyFilter.year}年${historyFilter.month}月`;
  return `筛选：${historyFilter.year}年`;
}

function renderFilterStatus() {
  const status = $("#filter-status");
  status.hidden = !historyFilter.applied;
  $("#filter-summary").textContent = filterDescription();
}

function renderHistory() {
  populateYearOptions();
  renderFilterStatus();
  const dates = historyDates();
  const groups = groupedHistoryDates(dates);
  const list = $("#history-list");
  list.replaceChildren();
  renderMonthJump(groups);
  if (!dates.length) {
    list.innerHTML = '<p class="empty">没有符合条件的打卡记录。</p>';
    return;
  }
  if (!groups.length) dates.forEach((date) => list.append(makeHistoryCard(date)));
  else groups.forEach(([month, monthDates]) => {
    const section = document.createElement("section");
    const heading = document.createElement("h3");
    section.className = "month-group";
    section.id = `month-${month}`;
    heading.className = "month-heading";
    heading.textContent = displayMonth(month);
    section.append(heading);
    monthDates.forEach((date) => section.append(makeHistoryCard(date)));
    list.append(section);
  });
}

function openHistoryDay(date) {
  selectedHistoryDate = date;
  const day = data[date] || {};
  const detail = $("#history-detail");
  detail.querySelectorAll(".media-preview").forEach(clearPreviewUrls);
  detail.replaceChildren();
  $("#history-day-heading").textContent = displayDate(date);
  PROJECTS.forEach((project) => projectRecords(day, project.id).forEach((record) => {
    const row = document.createElement("article");
    const tag = document.createElement("span");
    const title = document.createElement("strong");
    const copy = document.createElement("span");
    row.className = "record-line";
    row.style.setProperty("--project", project.color);
    tag.className = `project-tag${project.id === "dance" ? " is-yellow" : ""}`;
    tag.textContent = project.id === "dance" && record.title ? record.title : project.name;
    title.textContent = `${project.name}${project.id === "dance" && record.title ? ` · ${record.title}` : ""} · ${formatMinutes(record.minutes)}`;
    copy.textContent = [record.content, record.notes].filter(Boolean).join("\n") || "未填写内容和备注";
    row.append(tag, title, copy);
    const images = (record.media || []).filter((image) => image.type?.startsWith("image/"));
    if (images.length) {
      const gallery = document.createElement("div");
      gallery.className = "media-preview record-media";
      row.append(gallery);
      renderImages(gallery, images);
    }
    detail.append(row);
  }));
  showView("history-day-view");
  window.scrollTo(0, 0);
}

function renderStats() {
  const dates = Object.keys(data);
  const list = $("#stats-list");
  list.replaceChildren();
  PROJECTS.forEach((project) => {
    const records = dates.flatMap((date) => projectRecords(data[date], project.id));
    const minutes = records.reduce((total, record) => total + (Number(record.minutes) || 0), 0);
    const activeDays = dates.filter((date) => projectRecords(data[date], project.id).some(isDone)).length;
    const card = document.createElement("article");
    card.className = "stat-card";
    card.style.setProperty("--project", project.color);
    card.innerHTML = `<header><h3>${project.name}</h3><strong>${formatMinutes(minutes)}</strong></header><p>累计练习 ${activeDays} 天 · ${records.length} 条记录</p>`;
    list.append(card);
  });
}

function showView(id) {
  document.querySelectorAll(".view").forEach((view) => { view.hidden = view.id !== id; });
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("is-active", tab.dataset.view === id));
}

function applyHistoryFilter() {
  const values = {
    year: $("#filter-year").value,
    month: $("#filter-month").value,
    date: $("#filter-date").value,
    start: $("#filter-start").value,
    end: $("#filter-end").value
  };
  if (filterMode === "year") {
    if (!values.year) return alert("请选择年份。");
    historyFilter = { applied: true, ...values, month: "", date: "", start: "", end: "" };
  } else if (filterMode === "month") {
    if (!values.year || !values.month) return alert("请选择年份和月份。");
    historyFilter = { applied: true, ...values, date: "", start: "", end: "" };
  } else if (filterMode === "date") {
    if (!values.date) return alert("请选择日期。");
    historyFilter = { applied: true, ...values, year: "", month: "", start: "", end: "" };
  } else {
    if (!values.start && !values.end) return alert("请选择开始日期或结束日期。");
    if (values.start && values.end && values.start > values.end) return alert("开始日期不能晚于结束日期。");
    historyFilter = { applied: true, ...values, year: "", month: "", date: "" };
  }
  renderHistory();
  closeFilterSheet();
}

function clearHistoryFilter() {
  ["#filter-year", "#filter-month", "#filter-date", "#filter-start", "#filter-end"].forEach((selector) => { $(selector).value = ""; });
  historyFilter = { applied: false, year: "", month: "", date: "", start: "", end: "" };
  renderHistory();
  closeFilterSheet();
}

function setFilterMode(mode) {
  filterMode = mode;
  document.querySelectorAll("[data-filter-mode]").forEach((button) => button.classList.toggle("is-active", button.dataset.filterMode === mode));
  $("#filter-year-field").hidden = !["year", "month"].includes(mode);
  $("#filter-month-field").hidden = mode !== "month";
  $("#filter-date-field").hidden = mode !== "date";
  $("#filter-start-field").hidden = mode !== "range";
  $("#filter-end-field").hidden = mode !== "range";
}

function openFilterSheet() {
  populateYearOptions();
  const mode = historyFilter.date ? "date" : historyFilter.start || historyFilter.end ? "range" : historyFilter.month ? "month" : "year";
  setFilterMode(mode);
  $("#filter-sheet").hidden = false;
}

function closeFilterSheet() {
  $("#filter-sheet").hidden = true;
}

document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => {
  if (activeProject) { clearPreviewUrls($("#media-preview")); activeProject = undefined; activeAttachments = []; }
  showView(tab.dataset.view);
}));
$("#back-home").addEventListener("click", closeCheckin);
$("#back-history").addEventListener("click", () => showView("history-view"));
$("#open-filter").addEventListener("click", openFilterSheet);
$("#close-filter").addEventListener("click", closeFilterSheet);
$("#filter-sheet").addEventListener("click", (event) => { if (event.target === event.currentTarget) closeFilterSheet(); });
document.querySelectorAll("[data-filter-mode]").forEach((button) => button.addEventListener("click", () => setFilterMode(button.dataset.filterMode)));
$("#apply-filter").addEventListener("click", applyHistoryFilter);
$("#clear-filter").addEventListener("click", clearHistoryFilter);
$("#quick-clear-filter").addEventListener("click", clearHistoryFilter);
$("#media-input").addEventListener("change", (event) => {
  const files = [...event.target.files];
  const error = imageError(files, activeAttachments);
  event.target.value = "";
  if (error) return alert(error);
  activeAttachments.push(...files.map(makeImage));
  renderImages($("#media-preview"), activeAttachments, { editable: true, onRemove: removeActiveImage });
});
$("#save-checkin").addEventListener("click", saveCheckin);
$("#success-modal").addEventListener("click", (event) => { if (event.target === event.currentTarget) closeSuccess(); });
$("#success-modal .modal-close").addEventListener("click", closeSuccess);
$("#media-viewer").addEventListener("click", (event) => { if (event.target === event.currentTarget) closeImageViewer(); });
$("#media-viewer .viewer-close").addEventListener("click", closeImageViewer);
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js", { scope: "./" }));
initialiseStorage().then(() => { renderToday(); renderHistory(); renderStats(); });
console.assert(formatMinutes(80) === "1小时20分钟", "duration formatting failed");
console.assert(streakDays({ "2026-08-26": { english: { minutes: 20 } }, "2026-08-25": { dance: { minutes: 10 } } }, "2026-08-26") === 2, "streak calculation failed");
