import { downloadImage, getRecordById, listRecords, removeImages, uploadImage, upsertRecord } from "./cloudbase.js";

const localCategory = (category) => category === "misc" ? "dance" : category;
const remoteCategory = (category) => category === "dance" ? "misc" : category;
const uuid = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const active = (record) => record?.sync_status !== "pending_delete" && !record?.deleted_at;

export function normaliseAccountRecords(records, ownerId) {
  let changed = false;
  Object.entries(records).forEach(([date, day]) => Object.entries(day || {}).forEach(([category, value]) => {
    const categoryId = localCategory(category);
    const entries = Array.isArray(value) ? value : value ? [value] : [];
    if (categoryId !== category) {
      const current = day[categoryId];
      const existing = Array.isArray(current) ? current : current ? [current] : [];
      day[categoryId] = [...existing, ...entries];
      delete day[category];
      changed = true;
    } else if (!Array.isArray(value) && value && day[categoryId] === value) { day[categoryId] = entries; changed = true; }
    entries.forEach((record) => {
      if (!record.id) { record.id = uuid(); changed = true; }
      if (!record.remote_id) { record.remote_id = record.id; changed = true; }
      if (!record.owner_user_id) { record.owner_user_id = ownerId; changed = true; }
      if (!record.sync_status) { record.sync_status = "pending"; changed = true; }
      if (!record.updated_at) { record.updated_at = new Date().toISOString(); changed = true; }
      if (record.note === undefined && record.notes !== undefined) { record.note = record.notes; changed = true; }
      if (!record.record_date) { record.record_date = date; changed = true; }
      if (record.category !== categoryId) { record.category = categoryId; changed = true; }
    });
  }));
  return changed;
}

function recordsOf(records) {
  return Object.entries(records).flatMap(([date, day]) => Object.entries(day || {}).flatMap(([category, entries]) =>
    (Array.isArray(entries) ? entries : entries ? [entries] : []).map((record) => ({ date, category, record }))));
}

function imagePaths(record) {
  if (!record.image_path) return [];
  if (record.image_path.startsWith("[")) { try { return JSON.parse(record.image_path); } catch { return []; } }
  return [record.image_path];
}

function serialiseImagePaths(paths) {
  if (!paths.length) return null;
  return paths.length === 1 ? paths[0] : JSON.stringify(paths);
}

function imageExtension(blob) {
  const extensions = {
    "image/jpeg": "jpg", "image/jpg": "jpg", "image/webp": "webp", "image/png": "png",
    "image/heic": "heic", "image/heif": "heif", "image/avif": "avif", "image/gif": "gif"
  };
  return extensions[blob.type] || blob.type?.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin";
}

async function loadBitmap(blob) {
  if (globalThis.createImageBitmap) return globalThis.createImageBitmap(blob);
  const url = URL.createObjectURL(blob);
  try {
    const image = await new Promise((resolve, reject) => { const item = new Image(); item.onload = () => resolve(item); item.onerror = reject; item.src = url; });
    return image;
  } finally { URL.revokeObjectURL(url); }
}

export async function compressImage(blob) {
  if (!blob?.type?.startsWith("image/") || blob.size <= 320 * 1024) return blob;
  try {
    const image = await loadBitmap(blob);
    const scale = Math.min(1, 1920 / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    image.close?.();
    const encode = (quality) => new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    let compressed = await encode(.84);
    if (compressed?.size > 1.5 * 1024 * 1024) compressed = await encode(.72);
    return compressed || blob;
  } catch {
    return blob;
  }
}

function removeLocalRecord(records, target) {
  const day = records[target.date];
  const entries = Array.isArray(day?.[target.category]) ? day[target.category] : day?.[target.category] ? [day[target.category]] : [];
  day[target.category] = entries.filter((item) => item.id !== target.record.id);
  if (!day[target.category].length) delete day[target.category];
  if (!Object.keys(day).length) delete records[target.date];
}

function asRemoteRow(date, category, record, ownerId) {
  const mediaPaths = record.media?.map((image) => image.path).filter(Boolean) || [];
  const paths = mediaPaths.length ? mediaPaths : imagePaths(record);
  return {
    id: record.remote_id || record.id,
    user_id: ownerId,
    record_date: date,
    category: remoteCategory(category),
    title: record.title || null,
    minutes: Math.max(0, Number(record.minutes) || 0),
    content: record.content || null,
    note: record.note ?? record.notes ?? null,
    image_path: serialiseImagePaths(paths),
    deleted_at: record.deleted_at || null,
    updated_at: record.updated_at || new Date().toISOString()
  };
}

async function ensureRemoteImages(record, ownerId, getImage, saveImage) {
  const images = record.media || [];
  for (const image of images) {
    if (image.path) continue;
    const source = await getImage(image.id);
    if (!source) throw new Error("找不到本地图片，暂不能上传该条记录。");
    const blob = await compressImage(source);
    const path = `${ownerId}/${image.id}.${imageExtension(blob)}`;
    await uploadImage(path, blob);
    image.path = path;
    image.type = blob.type || image.type;
    image.size = blob.size;
    await saveImage({ ...image, blob });
  }
}

function remoteToLocal(row, ownerId) {
  const paths = imagePaths(row);
  return {
    id: row.id,
    remote_id: row.id,
    owner_user_id: ownerId,
    sync_status: "synced",
    sync_error: "",
    updated_at: row.updated_at,
    record_date: row.record_date,
    category: localCategory(row.category),
    deleted_at: row.deleted_at || null,
    title: row.title || "",
    minutes: Number(row.minutes) || 0,
    content: row.content || "",
    notes: row.note || "",
    note: row.note || "",
    media: paths.map((path) => ({ id: `${row.id}:${path}`, name: path.split("/").pop(), type: "image/jpeg", path }))
  };
}

function remoteIsNewer(remote, local) {
  return new Date(remote.updated_at || 0).getTime() >= new Date(local.updated_at || 0).getTime();
}

function remoteIsNewerThanDelete(remote, local) {
  const deletedAt = local.deleted_at || local.updated_at || 0;
  return new Date(remote.updated_at || 0).getTime() > new Date(deletedAt).getTime();
}

async function cacheRemoteImages(record, download, saveImage) {
  for (const image of record.media || []) {
    try {
      const blob = await download(image.path);
      if (blob) await saveImage({ ...image, type: blob.type || image.type, size: blob.size, blob });
    } catch (error) {
      console.warn("图片将在查看时重试下载", error);
    }
  }
}

export function createSyncService({ getRecords, saveRecords, getImage, saveImage, deleteImages, ownerId, onStatus, onChanged }) {
  let running;
  const notify = (status) => onStatus?.(status);
  const changed = async () => { await saveRecords(); onChanged?.(); };

  async function deleteUnreferencedImages(previous, next) {
    const retained = new Set((next.media || []).map((image) => image.id));
    const stale = (previous.media || []).map((image) => image.id).filter((id) => id && !retained.has(id));
    if (stale.length) await deleteImages(stale);
  }

  async function applyRemoteRow(target, row) {
    const records = getRecords();
    if (row.deleted_at) {
      await deleteImages((target.record.media || []).map((image) => image.id));
      removeLocalRecord(records, target);
      return;
    }
    const item = remoteToLocal(row, ownerId);
    await cacheRemoteImages(item, downloadImage, saveImage);
    await deleteUnreferencedImages(target.record, item);
    removeLocalRecord(records, target);
    records[row.record_date] ||= {};
    const category = localCategory(row.category);
    records[row.record_date][category] = [...(records[row.record_date][category] || []), item];
  }

  async function pushPending() {
    for (const target of recordsOf(getRecords())) {
      const { date, category, record } = target;
      if (!active(record) || !["pending", "failed", "syncing"].includes(record.sync_status)) continue;
      record.sync_status = "syncing"; record.sync_error = ""; await changed();
      try {
        const remote = await getRecordById(record.remote_id || record.id);
        if (remote && remoteIsNewer(remote, record)) {
          await applyRemoteRow(target, remote);
          await changed();
          continue;
        }
        await ensureRemoteImages(record, ownerId, getImage, saveImage);
        await upsertRecord(asRemoteRow(date, category, record, ownerId));
        record.sync_status = "synced"; record.sync_error = ""; await changed();
      } catch (error) {
        record.sync_status = "failed"; record.sync_error = error.message || "同步失败"; await changed();
      }
    }
  }

  async function pushDeletes() {
    for (const target of recordsOf(getRecords())) {
      const { date, category, record } = target;
      if (record.sync_status !== "pending_delete") continue;
      try {
        record.deleted_at ||= new Date().toISOString();
        const remote = await getRecordById(record.remote_id || record.id);
        if (remote && remoteIsNewerThanDelete(remote, record)) {
          await applyRemoteRow(target, remote);
          await changed();
          continue;
        }
        await upsertRecord(asRemoteRow(date, category, record, ownerId));
        await removeImages([...new Set([
          ...(record.media || []).map((image) => image.path).filter(Boolean),
          ...imagePaths(record)
        ])]);
        await deleteImages((record.media || []).map((image) => image.id));
        removeLocalRecord(getRecords(), target); await changed();
      } catch (error) {
        record.sync_error = error.message || "删除同步失败"; await changed();
      }
    }
  }

  async function pullRemote() {
    const remote = await listRecords();
    const records = getRecords();
    for (const row of remote) {
      const category = localCategory(row.category);
      if (!["english", "lacquer", "dance"].includes(category)) continue;
      const existing = recordsOf(records).find((target) => (target.record.remote_id || target.record.id) === row.id);
      if (row.deleted_at) {
        if (existing) { await deleteImages((existing.record.media || []).map((image) => image.id)); removeLocalRecord(records, existing); }
        continue;
      }
      if (existing?.record.sync_status === "pending_delete" || existing?.record.sync_status === "pending" || existing?.record.sync_status === "failed") continue;
      if (existing && new Date(existing.record.updated_at || 0) >= new Date(row.updated_at || 0)) continue;
      if (existing) {
        await applyRemoteRow(existing, row);
      } else {
        const item = remoteToLocal(row, ownerId);
        await cacheRemoteImages(item, downloadImage, saveImage);
        records[row.record_date] ||= {};
        const entries = Array.isArray(records[row.record_date][category]) ? records[row.record_date][category] : records[row.record_date][category] ? [records[row.record_date][category]] : [];
        records[row.record_date][category] = [...entries, item];
      }
    }
    await changed();
  }

  async function syncAll() {
    if (running) return running;
    running = (async () => {
      notify({ state: "syncing" });
      try {
        await pushDeletes();
        await pushPending();
        await pullRemote();
        const pending = recordsOf(getRecords()).filter(({ record }) => ["pending", "failed", "pending_delete"].includes(record.sync_status)).length;
        notify(pending ? { state: "pending", count: pending } : { state: "synced" });
      } catch (error) {
        notify({ state: "failed", message: error.message || "同步失败" });
      } finally { running = undefined; }
    })();
    return running;
  }

  return { syncAll, pullRemote, pushPending, pushDeletes };
}
