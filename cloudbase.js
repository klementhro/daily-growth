const config = globalThis.DAILY_GROWTH_CLOUDBASE_CONFIG || {};
let app;
let auth;

const configured = () => Boolean(
  config.envId && config.publishableKey &&
  !config.envId.startsWith("REPLACE_") && !config.publishableKey.startsWith("REPLACE_")
);

const messageOf = (error, fallback = "云端请求失败，请稍后重试。") => error?.message || error?.error?.message || fallback;

function throwResult(result) {
  if (result?.error) throw new Error(messageOf(result.error));
  return result?.data;
}

export function isCloudbaseConfigured() {
  return configured();
}

export function cloudbaseConfigurationMessage() {
  return "请先在 cloudbase-config.js 填入实际环境 ID 和 Publishable Key。";
}

export function initialiseCloudbase() {
  if (!configured()) throw new Error(cloudbaseConfigurationMessage());
  if (app) return { app, auth };
  if (!globalThis.cloudbase) throw new Error("CloudBase SDK 本地文件未加载，请重新部署 vendor/cloudbase.bundle.js。");
  app = globalThis.cloudbase.init({ env: config.envId, region: config.region, accessKey: config.publishableKey });
  auth = typeof app.auth === "function" ? app.auth() : app.auth;
  if (!auth) throw new Error("CloudBase 身份认证模块未初始化。");
  return { app, auth };
}

export async function getCurrentUser() {
  const { auth: currentAuth } = initialiseCloudbase();
  const result = await currentAuth.getUser();
  if (result?.error) throw new Error(messageOf(result.error, "无法验证登录状态。"));
  return result?.data?.user || result?.user || null;
}

export async function signInWithEmail(email, password) {
  const { auth: currentAuth } = initialiseCloudbase();
  const result = await currentAuth.signInWithPassword({ email, password });
  return throwResult(result);
}

export async function signUpWithEmail(email, password) {
  const { auth: currentAuth } = initialiseCloudbase();
  const result = await currentAuth.signUp({ email, password });
  return throwResult(result);
}

export async function verifySignUpOtp(signUpData, token) {
  if (typeof signUpData?.verifyOtp !== "function") throw new Error("CloudBase 未返回验证码验证流程，请检查身份认证配置。");
  return throwResult(await signUpData.verifyOtp({ token }));
}

export async function signOut() {
  const { auth: currentAuth } = initialiseCloudbase();
  return throwResult(await currentAuth.signOut());
}

function database() {
  const { app: currentApp } = initialiseCloudbase();
  const db = currentApp.rdb?.();
  if (!db) throw new Error("CloudBase SQL 数据库模块未初始化。");
  return db;
}

async function getAccessToken() {
  const { auth: currentAuth } = initialiseCloudbase();
  const result = await currentAuth.getSession();
  if (result?.error) throw new Error(messageOf(result.error, "无法取得 CloudBase 登录状态。"));
  const session = result?.data?.session;
  if (!session?.access_token) throw new Error("登录已失效，请重新登录。");
  return session.access_token;
}

function encodeObjectPath(path) {
  const parts = String(path || "").split("/");
  if (!parts.length || parts.some((part) => !part)) throw new Error("CloudBase Storage 对象路径无效。");
  return parts.map(encodeURIComponent).join("/");
}

function storageObjectUrl(path) {
  if (!config.storageBucket) throw new Error("请在 cloudbase-config.js 配置 storageBucket。");
  return `https://${config.envId}.api.tcloudbasegateway.com/v1/storages/object/${encodeURIComponent(config.storageBucket)}/${encodeObjectPath(path)}`;
}

async function storageRequest(operation, path, options = {}, ignoreNotFound = false) {
  const token = await getAccessToken();
  let response;
  try {
    response = await fetch(storageObjectUrl(path), {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) }
    });
  } catch (error) {
    const message = `CloudBase Storage ${operation}失败 (网络错误): ${messageOf(error)}`;
    console.error(message);
    throw new Error(message);
  }
  if (ignoreNotFound && response.status === 404) return response;
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const message = `CloudBase Storage ${operation}失败 (${response.status}): ${body || response.statusText}`;
    console.error(message);
    throw new Error(message);
  }
  return response;
}

export async function upsertRecord(row) {
  return throwResult(await database().from("daily_growth_records").upsert(row, { onConflict: "id" }));
}

export async function listRecords() {
  return throwResult(await database().from("daily_growth_records").select("*").order("updated_at", { ascending: true })) || [];
}

export async function getRecordById(id) {
  const rows = throwResult(await database().from("daily_growth_records").select("*").eq("id", id)) || [];
  return rows[0] || null;
}

export async function uploadImage(path, blob) {
  const response = await storageRequest("上传", path, {
    method: "POST",
    headers: {
      "Content-Type": blob.type || "application/octet-stream",
      "x-upsert": "true"
    },
    body: blob
  });
  const text = await response.text();
  if (!text) return { path };
  try { return JSON.parse(text); } catch { return { path }; }
}

export async function downloadImage(path) {
  return (await storageRequest("下载", path, { method: "GET" })).blob();
}

export async function removeImages(paths) {
  if (!paths.length) return;
  for (const path of new Set(paths)) await storageRequest("删除", path, { method: "DELETE" }, true);
}
