import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { QRScanModal, StickerPrintModal, PrintStickersArea, IconQr } from "./qr.jsx";

/* ===================== CLOUD STORAGE LAYER =====================
   Data is stored under a single key/value scheme so every device
   that opens this app sees the SAME data — that's what makes it
   usable "everywhere" instead of being stuck on one phone/tablet.
   Boxes/history/water are split into chunks so the app scales to
   tens of thousands of records without hitting size limits, and a
   normal edit only has to re-write the one chunk it touched.

   BACKEND: this file works in two environments without any code
   changes and WITHOUT any extra npm packages:
   1) Inside a Claude.ai artifact — uses the built-in window.storage.
   2) Deployed on Vercel / Netlify / GitHub Pages / anywhere else —
      talks to Supabase directly over its REST API using plain
      fetch() (no @supabase/supabase-js import needed). Provide
      window.CRABFARM_CONFIG before this script loads (e.g. a
      <script> tag in public/index.html) and it "just works".
   Whichever backend is available is picked automatically at runtime. */
const RUNTIME_CONFIG = typeof window !== "undefined" && window.CRABFARM_CONFIG || {};
const SUPABASE_URL = RUNTIME_CONFIG.supabaseUrl || "";
const SUPABASE_ANON_KEY = RUNTIME_CONFIG.supabaseAnonKey || "";
const KV_TABLE = "crabfarm_kv";
function hasClaudeStorage() {
  return typeof window !== "undefined" && !!window.storage;
}
function hasSupabase() {
  return !!(SUPABASE_URL && SUPABASE_ANON_KEY);
}
async function supabaseRequest(pathAndQuery, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    ...options,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Supabase request failed (${res.status}): ${text}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
const SHARED = true;
const SETTINGS_KEY = "crabfarm:settings";
const COL_BOXES = "boxes";
const COL_HISTORY = "history";
const COL_WATER = "water";
const CHUNKS = { boxes: 24, history: 10, water: 10 }; // 24 chunks * ~1200 boxes each supports 30,000+ boxes safely under the size limit per key
function chunkKey(prefix, i) {
  return `crabfarm:${prefix}:${i}`;
}
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h << 5) + h + s.charCodeAt(i) >>> 0;
  return h;
}
function chunkIndex(id, n) {
  return hashStr(String(id)) % n;
}
function groupByChunk(items, n) {
  const map = /* @__PURE__ */ new Map();
  for (let i = 0; i < n; i++) map.set(i, []);
  items.forEach((item) => {
    const c = chunkIndex(item.id, n);
    map.get(c).push(item);
  });
  return map;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function storageGetRaw(key, attempts = 3) {
  if (hasClaudeStorage()) {
    try {
      const res = await window.storage.get(key, SHARED);
      return res ? res.value : null;
    } catch (e) {
      // window.storage.get throws for a key that hasn't been saved yet —
      // that's expected on first run, not a real failure, so no retry/log here.
      return null;
    }
  }
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      if (hasSupabase()) {
        const rows = await supabaseRequest(`${KV_TABLE}?key=eq.${encodeURIComponent(key)}&select=value`);
        return rows && rows[0] ? rows[0].value : null;
      }
      console.error("crabfarm: no storage backend configured (set window.CRABFARM_CONFIG)");
      return null;
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await sleep(300 * (i + 1));
    }
  }
  if (lastErr) console.error("storage get failed after retries", key, lastErr);
  return null;
}
async function storageSetRaw(key, value, attempts = 4) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      if (hasClaudeStorage()) {
        const res = await window.storage.set(key, value, SHARED);
        if (res) return true;
        lastErr = new Error("storage set returned null");
      } else if (hasSupabase()) {
        await supabaseRequest(`${KV_TABLE}?on_conflict=key`, {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify([{ key, value, updated_at: (/* @__PURE__ */ new Date()).toISOString() }])
        });
        return true;
      } else {
        console.error("crabfarm: no storage backend configured (set window.CRABFARM_CONFIG)");
        return false;
      }
    } catch (e) {
      lastErr = e;
    }
    if (i < attempts - 1) await sleep(400 * (i + 1));
  }
  console.error("storage set failed after retries", key, lastErr);
  return false;
}
async function storageDeleteRaw(key) {
  try {
    if (hasClaudeStorage()) {
      await window.storage.delete(key, SHARED);
    } else if (hasSupabase()) {
      await supabaseRequest(`${KV_TABLE}?key=eq.${encodeURIComponent(key)}`, {
        method: "DELETE",
        headers: { Prefer: "return=minimal" }
      });
    }
  } catch (e) {
  }
}
async function storeGetCollection(prefix) {
  let keys = [];
  try {
    if (hasClaudeStorage()) {
      const res = await window.storage.list(`crabfarm:${prefix}:`, SHARED);
      keys = res && res.keys ? res.keys : [];
    } else if (hasSupabase()) {
      const rows = await supabaseRequest(`${KV_TABLE}?key=like.crabfarm:${prefix}:*&select=key`);
      keys = (rows || []).map((r) => r.key);
    }
  } catch (e) {
    keys = [];
  }
  if (!keys.length) return [];
  const raws = await Promise.all(keys.map((k) => storageGetRaw(k)));
  let out = [];
  raws.forEach((raw) => {
    if (!raw) return;
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) out = out.concat(arr);
    } catch (e) {
    }
  });
  return out;
}
async function storeSetCollection(prefix, fullArray, changedIds) {
  const n = CHUNKS[prefix];
  const map = groupByChunk(fullArray, n);
  const targets = changedIds && changedIds.length ? Array.from(new Set(changedIds.map((id) => chunkIndex(id, n)))) : Array.from({ length: n }, (_, i) => i);
  await Promise.all(targets.map((c) => storageSetRaw(chunkKey(prefix, c), JSON.stringify(map.get(c) || []))));
}
async function storeClearCollection(prefix) {
  const n = CHUNKS[prefix];
  await Promise.all(Array.from({ length: n }, (_, i) => storageDeleteRaw(chunkKey(prefix, i))));
}
async function storeGetSettings() {
  const raw = await storageGetRaw(SETTINGS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}
async function storeSetSettings(s) {
  return await storageSetRaw(SETTINGS_KEY, JSON.stringify(s));
}
async function storeClearSettings() {
  await storageDeleteRaw(SETTINGS_KEY);
}
/* ---- app password gate ---- */
const AUTH_KEY = "crabfarm:auth-credentials";
const DEFAULT_USERNAME = "anda";
const DEFAULT_PASSWORD = "Tt0890008848";
async function storeGetCredentials() {
  const raw = await storageGetRaw(AUTH_KEY);
  if (!raw) return { username: DEFAULT_USERNAME, password: DEFAULT_PASSWORD };
  try {
    const parsed = JSON.parse(raw);
    return {
      username: parsed && parsed.username ? parsed.username : DEFAULT_USERNAME,
      password: parsed && parsed.password ? parsed.password : DEFAULT_PASSWORD
    };
  } catch (e) {
    return { username: DEFAULT_USERNAME, password: DEFAULT_PASSWORD };
  }
}
async function storeSetPassword(pw) {
  const current = await storeGetCredentials();
  await storageSetRaw(AUTH_KEY, JSON.stringify({ username: current.username, password: pw }));
}
async function storeSetCredentials(username, password) {
  await storageSetRaw(AUTH_KEY, JSON.stringify({ username, password }));
}
/* ================================================================= */

const DEFAULT_PARAMS = [
  { key: "salinity", label: "\u0E04\u0E27\u0E32\u0E21\u0E40\u0E04\u0E47\u0E21", unit: "ppt", min: 28, target: 32, max: 35, doseFactor: 1, doseUnit: "\u0E01\u0E23\u0E31\u0E21 \u0E40\u0E01\u0E25\u0E37\u0E2D\u0E2A\u0E31\u0E07\u0E40\u0E04\u0E23\u0E32\u0E30\u0E2B\u0E4C / \u0E25\u0E34\u0E15\u0E23 \u0E15\u0E48\u0E2D\u0E01\u0E32\u0E23\u0E40\u0E1E\u0E34\u0E48\u0E21 1 ppt", dosable: true, lowerIsBetter: false },
  { key: "ph", label: "pH", unit: "", min: 7.8, target: 8.1, max: 8.4, doseFactor: 0, doseUnit: "", dosable: false, lowerIsBetter: false },
  { key: "temp", label: "\u0E2D\u0E38\u0E13\u0E2B\u0E20\u0E39\u0E21\u0E34", unit: "\xB0C", min: 26, target: 29, max: 32, doseFactor: 0, doseUnit: "", dosable: false, lowerIsBetter: false },
  { key: "ammonia", label: "\u0E41\u0E2D\u0E21\u0E42\u0E21\u0E40\u0E19\u0E35\u0E22 (NH3/NH4)", unit: "mg/L", min: 0, target: 0, max: 0.25, doseFactor: 0, doseUnit: "", dosable: false, lowerIsBetter: true },
  { key: "nitrite", label: "\u0E44\u0E19\u0E44\u0E15\u0E23\u0E17\u0E4C", unit: "mg/L", min: 0, target: 0, max: 0.5, doseFactor: 0, doseUnit: "", dosable: false, lowerIsBetter: true },
  { key: "alkalinity", label: "\u0E04\u0E48\u0E32\u0E14\u0E48\u0E32\u0E07", unit: "dKH", min: 7, target: 9, max: 12, doseFactor: 0.05, doseUnit: "\u0E2B\u0E19\u0E48\u0E27\u0E22\u0E1C\u0E07\u0E1B\u0E23\u0E31\u0E1A\u0E14\u0E48\u0E32\u0E07 / \u0E25\u0E34\u0E15\u0E23 \u0E15\u0E48\u0E2D 1 dKH", dosable: true, lowerIsBetter: false },
  { key: "calcium", label: "\u0E41\u0E04\u0E25\u0E40\u0E0B\u0E35\u0E22\u0E21", unit: "mg/L", min: 380, target: 420, max: 450, doseFactor: 0.02, doseUnit: "\u0E2B\u0E19\u0E48\u0E27\u0E22\u0E41\u0E04\u0E25\u0E40\u0E0B\u0E35\u0E22\u0E21\u0E40\u0E2A\u0E23\u0E34\u0E21 / \u0E25\u0E34\u0E15\u0E23 \u0E15\u0E48\u0E2D 1 mg/L", dosable: true, lowerIsBetter: false },
  { key: "do", label: "\u0E2D\u0E2D\u0E01\u0E0B\u0E34\u0E40\u0E08\u0E19\u0E25\u0E30\u0E25\u0E32\u0E22\u0E19\u0E49\u0E33 (DO)", unit: "mg/L", min: 5, target: 6.5, max: 9, doseFactor: 0, doseUnit: "", dosable: false, lowerIsBetter: false },
  { key: "waterLevel", label: "\u0E23\u0E30\u0E14\u0E31\u0E1A\u0E19\u0E49\u0E33", unit: "%", min: 30, target: 80, max: 100, doseFactor: 0, doseUnit: "", dosable: false, lowerIsBetter: false }
];
const DEFAULT_PUMP_LINES = [
  { id: "A", label: "\u0E2A\u0E32\u0E22 A", enabled: false, onTime: "06:00", offTime: "06:30" },
  { id: "B", label: "\u0E2A\u0E32\u0E22 B", enabled: false, onTime: "12:00", offTime: "12:30" },
  { id: "C", label: "\u0E2A\u0E32\u0E22 C", enabled: false, onTime: "18:00", offTime: "18:30" }
];
const CRAB_CATEGORIES = [
  { key: "male", label: "\u0E15\u0E31\u0E27\u0E1C\u0E39\u0E49" },
  { key: "female", label: "\u0E15\u0E31\u0E27\u0E40\u0E21\u0E35\u0E22" },
  { key: "eggs", label: "\u0E1B\u0E39\u0E44\u0E02\u0E48" }
];
const DEFAULT_PRICING = {
  male: { current: 350, forecast: 380 },
  female: { current: 450, forecast: 480 },
  eggs: { current: 600, forecast: 650 }
};
const DEFAULT_SALES_TARGETS = {
  male: 0,
  female: 0,
  eggs: 0
};
const DEFAULT_SETTINGS = {
  tankVolumeLiters: 1e3,
  feedRatePercent: 5,
  feedPelletWeightGrams: 0.1,
  feedIntervalDays: 1,
  moltReminderDays: 21,
  moltStandardGrowthPercent: 10,
  parameters: DEFAULT_PARAMS,
  layoutRows: ["A", "B", "C", "D"],
  layoutSlotsPerRow: 5,
  pumpLines: DEFAULT_PUMP_LINES,
  farmLat: 9.4744,
  farmLon: 98.3785,
  farmLocationName: "\u0E1E\u0E31\u0E07\u0E07\u0E32, \u0E2D\u0E31\u0E19\u0E14\u0E32\u0E21\u0E31\u0E19",
  feedCostPerKg: 35,
  pricing: DEFAULT_PRICING,
  salesTargets: DEFAULT_SALES_TARGETS
};
function mergeSettings(s) {
  if (!s || !s.parameters) return DEFAULT_SETTINGS;
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    parameters: s.parameters,
    pricing: {
      male: { ...DEFAULT_PRICING.male, ...(s.pricing && s.pricing.male) },
      female: { ...DEFAULT_PRICING.female, ...(s.pricing && s.pricing.female) },
      eggs: { ...DEFAULT_PRICING.eggs, ...(s.pricing && s.pricing.eggs) }
    },
    salesTargets: { ...DEFAULT_SALES_TARGETS, ...s.salesTargets }
  };
}
const DISPLAY = "'Space Grotesk', 'Segoe UI', sans-serif";
const BODY = "'IBM Plex Sans', 'Segoe UI', sans-serif";
const MONO = "'IBM Plex Mono', 'SFMono-Regular', Consolas, monospace";
const C = {
  ink: "#0B2333",
  brine: "#123B4F",
  paper: "#EEF2ED",
  card: "#FFFFFF",
  line: "#D7E0D8",
  text: "#0F241E",
  muted: "#5B7268",
  coral: "#E2603A",
  seagrass: "#2E7D58",
  water: "#2C7DA0",
  amber: "#C98A2E"
};
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const ConfirmBus = { request: null };
function askConfirm(message) {
  if (ConfirmBus.request) {
    return new Promise((resolve) => ConfirmBus.request(message, resolve));
  }
  return Promise.resolve(window.confirm ? window.confirm(message) : true);
}
const todayStr = () => (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
const fmtDate = (d) => {
  if (!d) return "\u2014";
  try {
    return new Date(d).toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return d;
  }
};
const daysBetween = (a, b) => {
  if (!a || !b) return null;
  const d1 = new Date(a), d2 = new Date(b);
  return Math.round((d2 - d1) / 864e5);
};
// Molt history entries used to be plain date strings; newer entries are
// records with weight/complete/limbLoss so we can track growth per molt.
// These helpers read either shape safely.
function moltEntryDate(m) {
  if (!m) return null;
  return typeof m === "string" ? m : m.date || null;
}
function moltEntryWeight(m) {
  if (!m || typeof m === "string") return null;
  return m.weight === "" || m.weight === null || m.weight === void 0 ? null : Number(m.weight);
}
function moltGrowthStats(moltHistory, initialWeight, standardPercent) {
  const list = moltHistory || [];
  let prevWeight = initialWeight === "" || initialWeight === null || initialWeight === void 0 || isNaN(initialWeight) ? null : Number(initialWeight);
  return list.map((entry) => {
    const w = moltEntryWeight(entry);
    let gain = null, gainPercent = null, passedStandard = null;
    if (w !== null && prevWeight !== null && prevWeight > 0) {
      gain = w - prevWeight;
      gainPercent = gain / prevWeight * 100;
      passedStandard = gainPercent >= (standardPercent != null ? standardPercent : 10);
    }
    const stat = {
      date: moltEntryDate(entry),
      weight: w,
      complete: typeof entry === "object" && entry ? !!entry.complete : null,
      limbLoss: typeof entry === "object" && entry ? !!entry.limbLoss : false,
      notes: typeof entry === "object" && entry ? entry.notes || "" : "",
      prevWeight,
      gain,
      gainPercent,
      passedStandard
    };
    if (w !== null) prevWeight = w;
    return stat;
  });
}
const money = (n) => n === "" || n === null || n === void 0 || isNaN(n) ? "\u2014" : Number(n).toLocaleString("th-TH", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const num = (n, d = 0) => n === "" || n === null || n === void 0 || isNaN(n) ? "\u2014" : Number(n).toLocaleString("th-TH", { minimumFractionDigits: d, maximumFractionDigits: d });
function crabCategory(box) {
  if (box.sex === "female") return box.goal === "eggs" ? "eggs" : "female";
  return "male";
}
function computeBoxFinance(box, settings) {
  const days = box.stockDate ? Math.max(0, daysBetween(box.stockDate, todayStr())) : 0;
  const feedPerDay = Number(box.feedPerDay || 0);
  const feedCostPerKg = Number((settings && settings.feedCostPerKg) || 0);
  const feedCostAccrued = feedPerDay * days * (feedCostPerKg / 1000);
  const category = crabCategory(box);
  const pricing = (settings && settings.pricing && settings.pricing[category]) || { current: 0, forecast: 0 };
  const hasOverride = box.sellPriceOverride !== "" && box.sellPriceOverride !== null && box.sellPriceOverride !== void 0 && !isNaN(box.sellPriceOverride);
  const priceNow = hasOverride ? Number(box.sellPriceOverride) : Number(pricing.current || 0);
  const priceForecast = hasOverride ? Number(box.sellPriceOverride) : Number(pricing.forecast || 0);
  const weightKg = Number(box.currentWeight || 0) / 1e3;
  const revenueNow = weightKg * priceNow;
  const revenueForecast = weightKg * priceForecast;
  const costBasis = Number(box.costPerCrab || 0) + feedCostAccrued;
  const profitNow = revenueNow - costBasis;
  const profitForecast = revenueForecast - costBasis;
  return {
    category,
    days,
    feedPerDayGrams: feedPerDay,
    feedCostAccrued,
    priceNow,
    priceForecast,
    hasOverride,
    weightKg,
    revenueNow,
    revenueForecast,
    costBasis,
    profitNow,
    profitForecast,
    profitPerKgNow: weightKg > 0 ? profitNow / weightKg : 0,
    profitPerKgForecast: weightKg > 0 ? profitForecast / weightKg : 0
  };
}
function LogoMark({ size = 40 }) {
  return /* @__PURE__ */ React.createElement("svg", { width: size, height: size * 0.75, viewBox: "0 0 400 300" }, /* @__PURE__ */ React.createElement("g", { transform: "translate(200,150) scale(1.25)" }, /* @__PURE__ */ React.createElement("g", { stroke: C.coral, strokeWidth: "17", strokeLinecap: "round", fill: "none" }, /* @__PURE__ */ React.createElement("path", { d: "M-52,44 Q-96,58 -116,92" }), /* @__PURE__ */ React.createElement("path", { d: "M-46,66 Q-84,84 -102,116" }), /* @__PURE__ */ React.createElement("path", { d: "M-34,84 Q-66,102 -80,130" }), /* @__PURE__ */ React.createElement("path", { d: "M52,44 Q96,58 116,92" }), /* @__PURE__ */ React.createElement("path", { d: "M46,66 Q84,84 102,116" }), /* @__PURE__ */ React.createElement("path", { d: "M34,84 Q66,102 80,130" })), /* @__PURE__ */ React.createElement("g", { transform: "translate(-50,0) rotate(-24) scale(1.1)" }, /* @__PURE__ */ React.createElement("path", { d: "M0,4 C -20,-6 -28,-28 -24,-50 C -20,-74 -2,-90 18,-86 C 34,-82 40,-62 34,-42 C 30,-28 18,-10 4,2 Z", fill: C.coral }), /* @__PURE__ */ React.createElement("path", { d: "M14,-56 C 22,-52 24,-42 20,-34", fill: "none", stroke: C.ink, strokeWidth: "4", strokeLinecap: "round", opacity: "0.55" })), /* @__PURE__ */ React.createElement("g", { transform: "translate(50,0) rotate(24) scale(-1.1,1.1)" }, /* @__PURE__ */ React.createElement("path", { d: "M0,4 C -20,-6 -28,-28 -24,-50 C -20,-74 -2,-90 18,-86 C 34,-82 40,-62 34,-42 C 30,-28 18,-10 4,2 Z", fill: C.coral }), /* @__PURE__ */ React.createElement("path", { d: "M14,-56 C 22,-52 24,-42 20,-34", fill: "none", stroke: C.ink, strokeWidth: "4", strokeLinecap: "round", opacity: "0.55" })), /* @__PURE__ */ React.createElement("ellipse", { cx: "0", cy: "32", rx: "78", ry: "48", fill: C.coral }), /* @__PURE__ */ React.createElement("path", { d: "M-56,17 Q0,-6 56,17", fill: "none", stroke: C.ink, strokeWidth: "3", opacity: "0.3" }), /* @__PURE__ */ React.createElement("path", { d: "M-64,42 Q0,66 64,42", fill: "none", stroke: C.ink, strokeWidth: "3", opacity: "0.3" }), /* @__PURE__ */ React.createElement("line", { x1: "-22", y1: "-6", x2: "-31", y2: "-30", stroke: C.ink, strokeWidth: "6", strokeLinecap: "round" }), /* @__PURE__ */ React.createElement("line", { x1: "22", y1: "-6", x2: "31", y2: "-30", stroke: C.ink, strokeWidth: "6", strokeLinecap: "round" }), /* @__PURE__ */ React.createElement("circle", { cx: "-31", cy: "-34", r: "8.5", fill: C.ink }), /* @__PURE__ */ React.createElement("circle", { cx: "31", cy: "-34", r: "8.5", fill: C.ink })));
}
function IconBell({ size = 18 }) {
  return /* @__PURE__ */ React.createElement("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round" }, /* @__PURE__ */ React.createElement("path", { d: "M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" }), /* @__PURE__ */ React.createElement("path", { d: "M13.73 21a2 2 0 0 1-3.46 0" }));
}
function IconSearch({ size = 18 }) {
  return /* @__PURE__ */ React.createElement("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round" }, /* @__PURE__ */ React.createElement("circle", { cx: "11", cy: "11", r: "7" }), /* @__PURE__ */ React.createElement("line", { x1: "21", y1: "21", x2: "16.65", y2: "16.65" }));
}
function IconLogout({ size = 18 }) {
  return /* @__PURE__ */ React.createElement("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round" }, /* @__PURE__ */ React.createElement("path", { d: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" }), /* @__PURE__ */ React.createElement("polyline", { points: "16 17 21 12 16 7" }), /* @__PURE__ */ React.createElement("line", { x1: "21", y1: "12", x2: "9", y2: "12" }));
}
function IconMenu({ size = 18 }) {
  return /* @__PURE__ */ React.createElement("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round" }, /* @__PURE__ */ React.createElement("line", { x1: "3", y1: "6", x2: "21", y2: "6" }), /* @__PURE__ */ React.createElement("line", { x1: "3", y1: "12", x2: "21", y2: "12" }), /* @__PURE__ */ React.createElement("line", { x1: "3", y1: "18", x2: "21", y2: "18" }));
}
function Sparkline({ values, min, max, color }) {
  if (!values || values.length < 2) {
    return /* @__PURE__ */ React.createElement("div", { style: { fontSize: 11, color: C.muted, fontFamily: MONO } }, "\u0E22\u0E31\u0E07\u0E44\u0E21\u0E48\u0E21\u0E35\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E1E\u0E2D");
  }
  const w = 160, h = 36, pad = 3;
  const lo = Math.min(min, ...values), hi = Math.max(max, ...values);
  const range = hi - lo || 1;
  const pts = values.map((v, i) => {
    const x = pad + i / (values.length - 1) * (w - pad * 2);
    const y = h - pad - (v - lo) / range * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return /* @__PURE__ */ React.createElement("svg", { width: w, height: h, viewBox: `0 0 ${w} ${h}` }, /* @__PURE__ */ React.createElement("polyline", { points: pts.join(" "), fill: "none", stroke: color, strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round" }), /* @__PURE__ */ React.createElement("circle", { cx: pts[pts.length - 1].split(",")[0], cy: pts[pts.length - 1].split(",")[1], r: "2.6", fill: color }));
}
function GaugeBar({ param, value }) {
  const { min, target, max, unit, label, lowerIsBetter } = param;
  const lo = Math.min(min, value != null ? value : min) - (max - min) * 0.15 || 0;
  const hi = Math.max(max, value != null ? value : max) + (max - min) * 0.15 || 1;
  const span = hi - lo || 1;
  const pct = (v) => Math.max(0, Math.min(100, (v - lo) / span * 100));
  const inRange = value !== null && value !== void 0 && value >= min && value <= max;
  const markColor = value === null || value === void 0 ? C.muted : inRange ? C.seagrass : C.coral;
  return /* @__PURE__ */ React.createElement("div", { style: { marginBottom: 14 } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 4 } }, /* @__PURE__ */ React.createElement("span", { style: { color: C.text, fontWeight: 600 } }, label), /* @__PURE__ */ React.createElement("span", { style: { fontFamily: MONO, color: markColor, fontWeight: 700 } }, value === null || value === void 0 ? "\u2014" : `${num(value, value < 10 ? 2 : 1)} ${unit}`)), /* @__PURE__ */ React.createElement("div", { style: { position: "relative", height: 10, borderRadius: 6, background: "#E4E9E2", overflow: "visible" } }, /* @__PURE__ */ React.createElement(
    "div",
    {
      style: {
        position: "absolute",
        left: `${pct(min)}%`,
        width: `${Math.max(2, pct(max) - pct(min))}%`,
        top: 0,
        bottom: 0,
        background: "rgba(46,125,88,0.28)",
        borderRadius: 6
      }
    }
  ), value !== null && value !== void 0 && /* @__PURE__ */ React.createElement(
    "div",
    {
      title: `${value}`,
      style: {
        position: "absolute",
        left: `calc(${pct(value)}% - 4px)`,
        top: -3,
        width: 8,
        height: 16,
        borderRadius: 3,
        background: markColor,
        boxShadow: "0 1px 3px rgba(0,0,0,0.35)"
      }
    }
  )), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "space-between", fontSize: 10, color: C.muted, marginTop: 2, fontFamily: MONO } }, /* @__PURE__ */ React.createElement("span", null, min, unit), /* @__PURE__ */ React.createElement("span", { style: { opacity: 0.7 } }, "\u0E40\u0E1B\u0E49\u0E32\u0E2B\u0E21\u0E32\u0E22 ", target, unit), /* @__PURE__ */ React.createElement("span", null, max, unit)));
}
function Pill({ children, tone = "muted" }) {
  const tones = {
    muted: { bg: "#E4E9E2", fg: C.muted },
    good: { bg: "rgba(46,125,88,0.14)", fg: C.seagrass },
    warn: { bg: "rgba(201,138,46,0.16)", fg: C.amber },
    danger: { bg: "rgba(226,96,58,0.14)", fg: C.coral },
    info: { bg: "rgba(44,125,160,0.14)", fg: C.water }
  };
  const t = tones[tone] || tones.muted;
  return /* @__PURE__ */ React.createElement("span", { style: { background: t.bg, color: t.fg, fontSize: 11.5, fontWeight: 700, padding: "3px 9px", borderRadius: 20, letterSpacing: 0.2 } }, children);
}
function Field({ label, children, hint }) {
  return /* @__PURE__ */ React.createElement("label", { style: { display: "block", marginBottom: 12, minWidth: 0 } }, /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12.5, fontWeight: 700, color: C.brine, marginBottom: 4 } }, label), children, hint && /* @__PURE__ */ React.createElement("div", { style: { fontSize: 11, color: C.muted, marginTop: 3 } }, hint));
}
const inputStyle = {
  width: "100%",
  minWidth: 0,
  padding: "9px 11px",
  borderRadius: 8,
  border: `1px solid ${C.line}`,
  fontSize: 14,
  fontFamily: BODY,
  color: C.text,
  background: "#FBFCFA",
  boxSizing: "border-box"
};
function Btn({ children, onClick, tone = "ink", size = "md", type = "button", disabled }) {
  const tones = {
    ink: { bg: C.ink, fg: "#fff" },
    coral: { bg: C.coral, fg: "#fff" },
    seagrass: { bg: C.seagrass, fg: "#fff" },
    ghost: { bg: "transparent", fg: C.ink, border: `1px solid ${C.line}` },
    danger: { bg: "transparent", fg: C.coral, border: `1px solid rgba(226,96,58,0.4)` }
  };
  const t = tones[tone] || tones.ink;
  const pad = size === "sm" ? "6px 12px" : "10px 16px";
  return /* @__PURE__ */ React.createElement(
    "button",
    {
      type,
      onClick,
      disabled,
      style: {
        background: t.bg,
        color: t.fg,
        border: t.border || "none",
        padding: pad,
        borderRadius: 8,
        fontSize: size === "sm" ? 12.5 : 14,
        fontWeight: 700,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        fontFamily: BODY,
        letterSpacing: 0.1,
        whiteSpace: "nowrap"
      }
    },
    children
  );
}
function ConfirmModal({ message, onYes, onNo }) {
  return /* @__PURE__ */ React.createElement(
    "div",
    {
      onClick: onNo,
      style: {
        position: "fixed",
        inset: 0,
        background: "rgba(11,35,51,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 300,
        padding: 16
      }
    },
    /* @__PURE__ */ React.createElement(
      "div",
      {
        onClick: (e) => e.stopPropagation(),
        style: {
          background: C.card,
          borderRadius: 14,
          padding: 22,
          width: 380,
          maxWidth: "94vw",
          boxShadow: "0 20px 60px rgba(11,35,51,0.35)"
        }
      },
      /* @__PURE__ */ React.createElement("div", { style: { fontSize: 14.5, color: C.ink, marginBottom: 20, lineHeight: 1.5, whiteSpace: "pre-line" } }, message),
      /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "flex-end", gap: 10 } }, /* @__PURE__ */ React.createElement(Btn, { tone: "ghost", onClick: onNo }, "\u0E22\u0E01\u0E40\u0E25\u0E34\u0E01"), /* @__PURE__ */ React.createElement(Btn, { tone: "danger", onClick: onYes }, "\u0E22\u0E37\u0E19\u0E22\u0E31\u0E19"))
    )
  );
}
function Modal({ title, onClose, children, wide }) {
  return /* @__PURE__ */ React.createElement(
    "div",
    {
      className: "cf-modal-overlay",
      onClick: onClose,
      style: {
        position: "fixed",
        inset: 0,
        background: "rgba(11,35,51,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
        padding: 16
      }
    },
    /* @__PURE__ */ React.createElement(
      "div",
      {
        className: "cf-modal-box",
        onClick: (e) => e.stopPropagation(),
        style: {
          background: C.card,
          borderRadius: 14,
          padding: 22,
          width: wide ? 620 : 440,
          maxWidth: "94vw",
          maxHeight: "88vh",
          overflowY: "auto",
          boxShadow: "0 20px 60px rgba(11,35,51,0.35)"
        }
      },
      /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 } }, /* @__PURE__ */ React.createElement("div", { style: { fontFamily: DISPLAY, fontSize: 19, fontWeight: 700, color: C.ink } }, title), /* @__PURE__ */ React.createElement("button", { onClick: onClose, style: { background: "none", border: "none", fontSize: 20, color: C.muted, cursor: "pointer", lineHeight: 1 } }, "\u2715")),
      children
    )
  );
}
function computeBoxStatus(box, moltReminderDays) {
  const isEmpty = box.status === "empty";
  const lastMoltEntry = box.moltHistory && box.moltHistory.length ? box.moltHistory[box.moltHistory.length - 1] : null;
  const lastMolt = lastMoltEntry ? moltEntryDate(lastMoltEntry) : null;
  const daysSinceMolt = lastMolt ? daysBetween(lastMolt, todayStr()) : null;
  const daysSinceStock = box.stockDate ? daysBetween(box.stockDate, todayStr()) : null;
  const eggReady = !isEmpty && box.sex === "female" && Number(box.eggPercent) >= 100;
  const weightReady = !isEmpty && box.targetWeight && Number(box.currentWeight) >= Number(box.targetWeight);
  const moltDue = !isEmpty && daysSinceMolt !== null && daysSinceMolt >= moltReminderDays;
  const ready = eggReady || weightReady;
  return { isEmpty, lastMolt, daysSinceMolt, daysSinceStock, eggReady, weightReady, moltDue, ready };
}
function parseBoxCode(code) {
  const m = String(code || "").trim().toUpperCase().match(/^([A-Z]+)0*([0-9]+)$/);
  if (!m) return null;
  return { row: m[1], col: Number(m[2]) };
}
function makeBoxCode(row, col) {
  return `${row}${String(col).padStart(2, "0")}`;
}
function BoxCard({ box, onOpen, onQuickHarvest, onQuickDeath, moltReminderDays }) {
  const { isEmpty, lastMolt, daysSinceMolt, daysSinceStock, eggReady, weightReady, moltDue } = computeBoxStatus(box, moltReminderDays);
  return /* @__PURE__ */ React.createElement(
    "div",
    {
      onClick: () => onOpen(box),
      style: {
        background: C.card,
        border: `1px solid ${C.line}`,
        borderRadius: 12,
        padding: 14,
        cursor: "pointer",
        position: "relative",
        transition: "box-shadow .15s",
        borderLeft: `4px solid ${isEmpty ? C.line : eggReady || weightReady ? C.coral : C.seagrass}`
      }
    },
    /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start" } }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { fontFamily: MONO, fontWeight: 700, fontSize: 16, color: C.ink } }, "#", box.boxNumber), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 11, color: C.muted } }, "\u0E23\u0E38\u0E48\u0E19\u0E17\u0E35\u0E48 ", box.batchNumber)), isEmpty ? /* @__PURE__ */ React.createElement(Pill, { tone: "muted" }, "\u0E27\u0E48\u0E32\u0E07") : /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 4, flexWrap: "wrap", justifyContent: "flex-end" } }, /* @__PURE__ */ React.createElement(Pill, { tone: box.sex === "female" ? "danger" : "info" }, box.sex === "female" ? "\u2640 \u0E15\u0E31\u0E27\u0E40\u0E21\u0E35\u0E22" : "\u2642 \u0E15\u0E31\u0E27\u0E1C\u0E39\u0E49"), box.sex === "female" && box.unmated && /* @__PURE__ */ React.createElement(Pill, { tone: "muted" }, "\u0E01\u0E30\u0E40\u0E17\u0E22"))),
    !isEmpty ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { style: { marginTop: 10, fontSize: 12.5, color: C.text, lineHeight: 1.9 } }, /* @__PURE__ */ React.createElement("div", null, "\u0E19\u0E49\u0E33\u0E2B\u0E19\u0E31\u0E01: ", /* @__PURE__ */ React.createElement("b", { style: { fontFamily: MONO } }, num(box.currentWeight), " g"), box.targetWeight ? /* @__PURE__ */ React.createElement("span", { style: { color: C.muted } }, " / \u0E40\u0E1B\u0E49\u0E32\u0E2B\u0E21\u0E32\u0E22 ", num(box.targetWeight), " g") : null), box.sex === "female" && /* @__PURE__ */ React.createElement("div", null, "\u0E44\u0E02\u0E48: ", box.unmated ? /* @__PURE__ */ React.createElement("b", { style: { fontFamily: MONO, color: C.muted } }, "\u2014 (\u0E01\u0E30\u0E40\u0E17\u0E22)") : /* @__PURE__ */ React.createElement("b", { style: { fontFamily: MONO, color: box.eggPercent >= 100 ? C.coral : C.text } }, num(box.eggPercent), "%")), /* @__PURE__ */ React.createElement("div", null, "\u0E40\u0E25\u0E35\u0E49\u0E22\u0E07\u0E21\u0E32\u0E41\u0E25\u0E49\u0E27: ", /* @__PURE__ */ React.createElement("b", { style: { fontFamily: MONO } }, daysSinceStock != null ? daysSinceStock : "\u2014", " \u0E27\u0E31\u0E19")), /* @__PURE__ */ React.createElement("div", null, "\u0E25\u0E2D\u0E01\u0E04\u0E23\u0E32\u0E1A\u0E25\u0E48\u0E32\u0E2A\u0E38\u0E14: ", lastMolt ? `${fmtDate(lastMolt)} (${daysSinceMolt} \u0E27\u0E31\u0E19\u0E01\u0E48\u0E2D\u0E19)` : "\u0E22\u0E31\u0E07\u0E44\u0E21\u0E48\u0E1A\u0E31\u0E19\u0E17\u0E36\u0E01")), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" } }, eggReady && /* @__PURE__ */ React.createElement(Pill, { tone: "danger" }, "\u0E44\u0E02\u0E48\u0E40\u0E15\u0E47\u0E21 \u0E1E\u0E23\u0E49\u0E2D\u0E21\u0E08\u0E31\u0E1A"), weightReady && /* @__PURE__ */ React.createElement(Pill, { tone: "danger" }, "\u0E16\u0E36\u0E07\u0E19\u0E49\u0E33\u0E2B\u0E19\u0E31\u0E01\u0E40\u0E1B\u0E49\u0E32\u0E2B\u0E21\u0E32\u0E22"), moltDue && /* @__PURE__ */ React.createElement(Pill, { tone: "warn" }, "\u0E40\u0E01\u0E34\u0E19\u0E01\u0E33\u0E2B\u0E19\u0E14\u0E15\u0E23\u0E27\u0E08\u0E25\u0E2D\u0E01\u0E04\u0E23\u0E32\u0E1A")), /* @__PURE__ */ React.createElement("div", { style: { marginTop: 12, display: "flex", gap: 6 } }, /* @__PURE__ */ React.createElement(Btn, { size: "sm", tone: "coral", onClick: (e) => {
      e.stopPropagation();
      onQuickHarvest(box);
    } }, "\u0E1A\u0E31\u0E19\u0E17\u0E36\u0E01\u0E08\u0E31\u0E1A\u0E1B\u0E39"), onQuickDeath && /* @__PURE__ */ React.createElement(Btn, { size: "sm", tone: "ghost", onClick: (e) => {
      e.stopPropagation();
      onQuickDeath(box);
    } }, "\u{1F480} \u0E1B\u0E39\u0E15\u0E32\u0E22"))) : /* @__PURE__ */ React.createElement("div", { style: { marginTop: 14, fontSize: 12.5, color: C.muted } }, "\u0E41\u0E15\u0E30\u0E40\u0E1E\u0E37\u0E48\u0E2D\u0E25\u0E07\u0E1B\u0E39\u0E43\u0E2B\u0E21\u0E48\u0E43\u0E19\u0E01\u0E25\u0E48\u0E2D\u0E07\u0E19\u0E35\u0E49")
  );
}
function FloorPlanCell({ code, box, moltReminderDays, onOpen, onQuickHarvest, onAddAt }) {
  if (!box) {
    return /* @__PURE__ */ React.createElement(
      "button",
      {
        onClick: () => onAddAt(code),
        style: {
          background: "#F2F5F1",
          border: `1.5px dashed ${C.line}`,
          borderRadius: 10,
          padding: "12px 10px",
          textAlign: "left",
          cursor: "pointer",
          minHeight: 84,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between"
        }
      },
      /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start" } }, /* @__PURE__ */ React.createElement("span", { style: { fontFamily: MONO, fontWeight: 700, fontSize: 14, color: C.muted } }, code), /* @__PURE__ */ React.createElement("span", { style: { fontSize: 14, opacity: 0.5 } }, "\u{1F4E6}")),
      /* @__PURE__ */ React.createElement("div", { style: { fontSize: 11, color: C.muted } }, "\u0E27\u0E48\u0E32\u0E07")
    );
  }
  const { isEmpty, daysSinceStock, ready, moltDue } = computeBoxStatus(box, moltReminderDays);
  const tone = ready ? "good" : moltDue ? "bad" : "warn";
  const palette = {
    good: { bg: "rgba(46,125,88,0.10)", border: C.seagrass, icon: "\u2713", iconBg: C.seagrass },
    warn: { bg: "rgba(201,138,46,0.10)", border: C.amber, icon: null, iconBg: null },
    bad: { bg: "rgba(226,96,58,0.10)", border: C.coral, icon: "!", iconBg: C.coral }
  }[tone];
  return /* @__PURE__ */ React.createElement(
    "div",
    {
      onClick: () => onOpen(box),
      style: {
        background: palette.bg,
        border: `1.5px solid ${palette.border}`,
        borderRadius: 10,
        padding: "12px 10px",
        cursor: "pointer",
        minHeight: 84,
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between"
      }
    },
    /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start" } }, /* @__PURE__ */ React.createElement("span", { style: { fontFamily: MONO, fontWeight: 700, fontSize: 14, color: C.ink } }, box.boxNumber), palette.icon && /* @__PURE__ */ React.createElement(
      "span",
      {
        onClick: (e) => {
          if (tone === "good") {
            e.stopPropagation();
            onQuickHarvest(box);
          }
        },
        title: tone === "good" ? "\u0E1E\u0E23\u0E49\u0E2D\u0E21\u0E08\u0E31\u0E1A \u2014 \u0E41\u0E15\u0E30\u0E40\u0E1E\u0E37\u0E48\u0E2D\u0E1A\u0E31\u0E19\u0E17\u0E36\u0E01\u0E08\u0E31\u0E1A\u0E1B\u0E39" : "\u0E40\u0E01\u0E34\u0E19\u0E01\u0E33\u0E2B\u0E19\u0E14\u0E15\u0E23\u0E27\u0E08\u0E25\u0E2D\u0E01\u0E04\u0E23\u0E32\u0E1A",
        style: {
          width: 18,
          height: 18,
          borderRadius: "50%",
          background: palette.iconBg,
          color: "#fff",
          fontSize: 11,
          fontWeight: 700,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0
        }
      },
      palette.icon
    )),
    /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12, color: C.text, fontFamily: MONO, lineHeight: 1.5 } }, /* @__PURE__ */ React.createElement("div", null, num(box.currentWeight), "g"), /* @__PURE__ */ React.createElement("div", { style: { color: C.muted } }, daysSinceStock != null ? daysSinceStock : "\u2014", " \u0E27\u0E31\u0E19"))
  );
}
function FloorPlanView({ boxes, settings, onOpenBox, onQuickHarvest, onAddAt }) {
  const configuredRows = settings.layoutRows && settings.layoutRows.length ? settings.layoutRows : ["A"];
  const basePerRow = settings.layoutSlotsPerRow || 5;
  const detectedRows = useMemo(() => {
    const set = /* @__PURE__ */ new Set();
    boxes.forEach((b) => {
      const parsed = parseBoxCode(b.boxNumber);
      if (parsed) set.add(parsed.row);
    });
    return set;
  }, [boxes]);
  const allRows = useMemo(() => {
    const merged = new Set(configuredRows);
    detectedRows.forEach((r) => merged.add(r));
    return Array.from(merged).sort();
  }, [configuredRows, detectedRows]);
  const maxColByRow = useMemo(() => {
    const map = {};
    boxes.forEach((b) => {
      const parsed = parseBoxCode(b.boxNumber);
      if (!parsed) return;
      map[parsed.row] = Math.max(map[parsed.row] || 0, parsed.col);
    });
    return map;
  }, [boxes]);
  const perRowFor = useCallback(
    (row) => Math.max(basePerRow, (maxColByRow[row] || 0) + 1),
    [basePerRow, maxColByRow]
  );
  const totalCells = useMemo(
    () => allRows.reduce((sum, r) => sum + perRowFor(r), 0),
    [allRows, perRowFor]
  );
  const LARGE_LAYOUT = totalCells > 400;
  const [activeRow, setActiveRow] = useState(allRows[0]);
  const rows = LARGE_LAYOUT ? [allRows.includes(activeRow) ? activeRow : allRows[0]] : allRows;
  const byCode = useMemo(() => {
    const map = {};
    boxes.forEach((b) => {
      map[String(b.boxNumber).trim().toUpperCase()] = b;
    });
    return map;
  }, [boxes]);
  const unmatched = useMemo(
    () => boxes.filter((b) => {
      const parsed = parseBoxCode(b.boxNumber);
      return !parsed;
    }),
    [boxes]
  );
  return /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 16, fontSize: 12, color: C.muted, alignItems: "center" } }, /* @__PURE__ */ React.createElement("span", { style: { display: "flex", alignItems: "center", gap: 5 } }, /* @__PURE__ */ React.createElement("span", { style: { width: 12, height: 12, borderRadius: 3, background: "rgba(46,125,88,0.5)", display: "inline-block" } }), " \u0E1E\u0E23\u0E49\u0E2D\u0E21\u0E08\u0E31\u0E1A"), /* @__PURE__ */ React.createElement("span", { style: { display: "flex", alignItems: "center", gap: 5 } }, /* @__PURE__ */ React.createElement("span", { style: { width: 12, height: 12, borderRadius: 3, background: "rgba(201,138,46,0.5)", display: "inline-block" } }), " \u0E01\u0E33\u0E25\u0E31\u0E07\u0E40\u0E25\u0E35\u0E49\u0E22\u0E07"), /* @__PURE__ */ React.createElement("span", { style: { display: "flex", alignItems: "center", gap: 5 } }, /* @__PURE__ */ React.createElement("span", { style: { width: 12, height: 12, borderRadius: 3, background: "rgba(226,96,58,0.5)", display: "inline-block" } }), " \u0E15\u0E49\u0E2D\u0E07\u0E15\u0E23\u0E27\u0E08\u0E2A\u0E2D\u0E1A"), /* @__PURE__ */ React.createElement("span", { style: { display: "flex", alignItems: "center", gap: 5 } }, /* @__PURE__ */ React.createElement("span", { style: { width: 12, height: 12, borderRadius: 3, background: "#F2F5F1", border: `1px dashed ${C.line}`, display: "inline-block" } }), " \u0E27\u0E48\u0E32\u0E07")), LARGE_LAYOUT && /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 10, marginBottom: 16, flexWrap: "wrap" } }, /* @__PURE__ */ React.createElement("select", { style: { ...inputStyle, width: 160 }, value: rows[0], onChange: (e) => setActiveRow(e.target.value) }, allRows.map((r) => /* @__PURE__ */ React.createElement("option", { key: r, value: r }, "\u0E41\u0E16\u0E27 ", r))), /* @__PURE__ */ React.createElement("span", { style: { fontSize: 12, color: C.muted } }, "\u0E1C\u0E31\u0E07\u0E04\u0E2D\u0E19\u0E42\u0E14\u0E17\u0E31\u0E49\u0E07\u0E2B\u0E21\u0E14 ", totalCells.toLocaleString(), " \u0E0A\u0E48\u0E2D\u0E07 \u2014 \u0E40\u0E25\u0E37\u0E2D\u0E01\u0E14\u0E39\u0E17\u0E35\u0E25\u0E30\u0E41\u0E16\u0E27\u0E40\u0E1E\u0E37\u0E48\u0E2D\u0E04\u0E27\u0E32\u0E21\u0E25\u0E37\u0E48\u0E19\u0E44\u0E2B\u0E25 \u0E2B\u0E23\u0E37\u0E2D\u0E2A\u0E25\u0E31\u0E1A\u0E44\u0E1B\u0E43\u0E0A\u0E49 \u0E23\u0E32\u0E22\u0E01\u0E32\u0E23 \u0E41\u0E25\u0E49\u0E27\u0E04\u0E49\u0E19\u0E2B\u0E32\u0E14\u0E49\u0E27\u0E22\u0E40\u0E25\u0E02\u0E01\u0E25\u0E48\u0E2D\u0E07")), rows.map((row) => /* @__PURE__ */ React.createElement("div", { key: row, style: { marginBottom: 16 } }, /* @__PURE__ */ React.createElement("div", { style: { fontFamily: DISPLAY, fontWeight: 700, fontSize: 13, color: C.brine, marginBottom: 8 } }, "\u0E41\u0E16\u0E27 ", row), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(120px, 1fr))`, gap: 10 } }, Array.from({ length: perRowFor(row) }, (_, i) => i + 1).map((col) => {
    const code = makeBoxCode(row, col);
    const box = byCode[code];
    return /* @__PURE__ */ React.createElement(
      FloorPlanCell,
      {
        key: code,
        code,
        box,
        moltReminderDays: settings.moltReminderDays,
        onOpen: onOpenBox,
        onQuickHarvest,
        onAddAt
      }
    );
  })))), unmatched.length > 0 && /* @__PURE__ */ React.createElement("div", { style: { marginTop: 8 } }, /* @__PURE__ */ React.createElement("div", { style: { fontFamily: DISPLAY, fontWeight: 700, fontSize: 13, color: C.brine, marginBottom: 8 } }, "\u0E01\u0E25\u0E48\u0E2D\u0E07\u0E2D\u0E37\u0E48\u0E19\u0E46 (\u0E40\u0E1A\u0E2D\u0E23\u0E4C\u0E44\u0E21\u0E48\u0E15\u0E23\u0E07\u0E23\u0E39\u0E1B\u0E41\u0E1A\u0E1A\u0E41\u0E16\u0E27/\u0E0A\u0E48\u0E2D\u0E07\u0E17\u0E35\u0E48\u0E15\u0E31\u0E49\u0E07\u0E44\u0E27\u0E49 \u2014 \u0E40\u0E0A\u0E48\u0E19 \u0E40\u0E01\u0E34\u0E19\u0E08\u0E33\u0E19\u0E27\u0E19\u0E0A\u0E48\u0E2D\u0E07\u0E15\u0E48\u0E2D\u0E41\u0E16\u0E27 \u0E44\u0E1B\u0E1B\u0E23\u0E31\u0E1A\u0E17\u0E35\u0E48\u0E15\u0E31\u0E49\u0E07\u0E04\u0E48\u0E32 > \u0E1C\u0E31\u0E07\u0E04\u0E2D\u0E19\u0E42\u0E14)"), unmatched.length > 300 && /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12, color: C.muted, marginBottom: 8 } }, "\u0E41\u0E2A\u0E14\u0E07 300 \u0E08\u0E32\u0E01 ", unmatched.length.toLocaleString(), " \u0E01\u0E25\u0E48\u0E2D\u0E07 \u2014 \u0E44\u0E1B\u0E17\u0E35\u0E48 \u0E23\u0E32\u0E22\u0E01\u0E32\u0E23 \u0E40\u0E1E\u0E37\u0E48\u0E2D\u0E14\u0E39\u0E17\u0E31\u0E49\u0E07\u0E2B\u0E21\u0E14"), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(120px, 1fr))`, gap: 10 } }, unmatched.slice(0, 300).map((b) => /* @__PURE__ */ React.createElement(
    FloorPlanCell,
    {
      key: b.id,
      code: b.boxNumber,
      box: b,
      moltReminderDays: settings.moltReminderDays,
      onOpen: onOpenBox,
      onQuickHarvest,
      onAddAt
    }
  )))));
}
function MoltHistorySection({ f, settings, onAddMolt }) {
  const standardPercent = (settings && settings.moltStandardGrowthPercent) != null ? settings.moltStandardGrowthPercent : 10;
  const stats = useMemo(
    () => moltGrowthStats(f.moltHistory, f.initialWeight, standardPercent),
    [f.moltHistory, f.initialWeight, standardPercent]
  );
  const [draft, setDraft] = useState({ date: todayStr(), weight: "", complete: true, limbLoss: false, notes: "" });
  const setDraftField = (k, v) => setDraft((p) => ({ ...p, [k]: v }));
  const submitMolt = () => {
    if (draft.weight === "" || isNaN(draft.weight) || Number(draft.weight) <= 0) {
      alert("กรุณากรอกน้ำหนักหลังลอกคราบ (ตัวเลขมากกว่า 0)");
      return;
    }
    onAddMolt({
      date: draft.date || todayStr(),
      weight: Number(draft.weight),
      complete: !!draft.complete,
      limbLoss: !!draft.limbLoss,
      notes: draft.notes || ""
    });
    setDraft({ date: todayStr(), weight: "", complete: true, limbLoss: false, notes: "" });
  };
  const failing = stats.filter((s) => s.passedStandard === false);
  return (
    <div style={{ marginTop: 4, marginBottom: 14, gridColumn: "1 / -1" }}>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: C.brine, marginBottom: 6 }}>
        ประวัติการลอกคราบ &amp; น้ำหนัก
      </div>
      <div style={{ fontSize: 11.5, color: C.muted, marginBottom: 8 }}>
        น้ำหนักเริ่มต้น: <b style={{ fontFamily: MONO, color: C.text }}>{f.initialWeight ? num(f.initialWeight) : num(f.currentWeight)} g</b>
        {" "}&middot; มาตรฐานน้ำหนักเพิ่มขึ้นต่อครั้ง: <b style={{ fontFamily: MONO, color: C.text }}>{standardPercent}%</b>
      </div>
      {stats.length === 0 ? (
        <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 10 }}>ยังไม่มีบันทึกการลอกคราบ</div>
      ) : (
        <div style={{ overflowX: "auto", marginBottom: 10 }}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>วันที่</th>
                <th style={thStyle}>น้ำหนัก (g)</th>
                <th style={thStyle}>เพิ่มขึ้น</th>
                <th style={thStyle}>เทียบมาตรฐาน</th>
                <th style={thStyle}>ลอกคราบครบ</th>
                <th style={thStyle}>แขนขาขาด</th>
                <th style={thStyle}>หมายเหตุ</th>
              </tr>
            </thead>
            <tbody>
              {stats.map((s, i) => (
                <tr key={i}>
                  <td style={tdStyle}>{fmtDate(s.date)}</td>
                  <td style={{ ...tdStyle, fontFamily: MONO, fontWeight: 700 }}>{s.weight !== null ? num(s.weight) : "—"}</td>
                  <td style={{ ...tdStyle, fontFamily: MONO, color: s.gain === null ? C.muted : s.gain >= 0 ? C.seagrass : C.coral }}>
                    {s.gain === null ? "—" : `${s.gain >= 0 ? "+" : ""}${num(s.gain)} g (${s.gain >= 0 ? "+" : ""}${num(s.gainPercent, 1)}%)`}
                  </td>
                  <td style={tdStyle}>
                    {s.passedStandard === null ? (
                      <span style={{ color: C.muted, fontSize: 11.5 }}>—</span>
                    ) : (
                      <Pill tone={s.passedStandard ? "good" : "danger"}>{s.passedStandard ? "ผ่านมาตรฐาน" : "ต่ำกว่ามาตรฐาน"}</Pill>
                    )}
                  </td>
                  <td style={tdStyle}>
                    {s.complete === null ? "—" : <Pill tone={s.complete ? "good" : "warn"}>{s.complete ? "ครบ" : "ไม่ครบ"}</Pill>}
                  </td>
                  <td style={tdStyle}>
                    <Pill tone={s.limbLoss ? "warn" : "muted"}>{s.limbLoss ? "มี" : "ไม่มี"}</Pill>
                  </td>
                  <td style={{ ...tdStyle, fontSize: 12 }}>{s.notes || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {failing.length > 0 && (
        <div style={{ background: "rgba(226,96,58,0.08)", border: `1px solid rgba(226,96,58,0.3)`, borderRadius: 8, padding: "10px 12px", marginBottom: 10, fontSize: 12.5, lineHeight: 1.6 }}>
          <b style={{ color: C.coral }}>คำแนะนำ:</b> มีการลอกคราบ {failing.length} ครั้งที่น้ำหนักเพิ่มขึ้นต่ำกว่ามาตรฐาน ({standardPercent}%)
          ลองเพิ่มปริมาณอาหารต่อวัน และเสริมแคลเซียม/อัลคาไลนิตี้ในน้ำ (ดูได้ที่แท็บ "น้ำ/ปั๊ม") เพื่อช่วยให้สร้างเปลือกใหม่ได้แข็งแรงและโตเต็มที่ขึ้นในรอบถัดไป
        </div>
      )}
      <div style={{ background: "#F6F8F5", border: `1px solid ${C.line}`, borderRadius: 8, padding: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: C.brine, marginBottom: 8 }}>+ บันทึกลอกคราบใหม่</div>
        <div className="cf-grid-molt" style={{ display: "grid", gridTemplateColumns: "1fr", gap: 0 }}>
          <Field label="วันที่ลอกคราบ">
            <input type="date" className="cf-date-field" style={{ ...inputStyle, minWidth: 0 }} value={draft.date} onChange={(e) => setDraftField("date", e.target.value)} />
          </Field>
          <Field label="น้ำหนักหลังลอกคราบ (กรัม)">
            <input type="number" style={{ ...inputStyle, minWidth: 0 }} value={draft.weight} placeholder="เช่น 250" onChange={(e) => setDraftField("weight", e.target.value)} />
          </Field>
        </div>
        <div style={{ display: "flex", gap: 18, marginBottom: 10, flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, cursor: "pointer" }}>
            <input
              type="radio"
              name="moltStatus"
              checked={!draft.limbLoss}
              onChange={() => setDraft((p) => ({ ...p, complete: true, limbLoss: false }))}
            />
            ลอกคราบครบ
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, cursor: "pointer" }}>
            <input
              type="radio"
              name="moltStatus"
              checked={draft.limbLoss}
              onChange={() => setDraft((p) => ({ ...p, complete: false, limbLoss: true }))}
            />
            แขนขาขาด
          </label>
        </div>
        <Field label="หมายเหตุ (ถ้ามี)">
          <input style={inputStyle} value={draft.notes} placeholder="เช่น เปลือกนิ่มผิดปกติ" onChange={(e) => setDraftField("notes", e.target.value)} />
        </Field>
        <Btn size="sm" tone="seagrass" onClick={submitMolt}>+ บันทึกลอกคราบ</Btn>
      </div>
    </div>
  );
}
function BoxFormModal({ initial, onSave, onClose, onDelete, nextBatchFor, prefillBoxNumber, allBoxes, settings, onPrintSticker }) {
  const isNew = !initial;
  const [f, setF] = useState(
    initial ? { ...initial } : {
      id: uid(),
      boxNumber: prefillBoxNumber || "",
      batchNumber: 1,
      sex: "male",
      stockDate: todayStr(),
      moltHistory: [],
      currentWeight: "",
      initialWeight: "",
      targetWeight: "",
      goal: "",
      eggPercent: 0,
      unmated: false,
      feedPerDay: "",
      costPerCrab: "",
      sellPriceOverride: "",
      notes: "",
      status: "active",
      harvestDate: null
    }
  );
  const [boxNumberError, setBoxNumberError] = useState("");
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const restock = f.status === "empty";
  const submit = () => {
    if (!f.boxNumber) {
      setBoxNumberError("กรุณาระบุเบอร์กล่อง");
      alert("\u0E01\u0E23\u0E38\u0E13\u0E32\u0E23\u0E30\u0E1A\u0E38\u0E40\u0E1A\u0E2D\u0E23\u0E4C\u0E01\u0E25\u0E48\u0E2D\u0E07");
      return;
    }
    if (isNew || restock) {
      const dup = (allBoxes || []).some(
        (b) => b.id !== f.id && b.status === "active" && String(b.boxNumber).trim().toUpperCase() === String(f.boxNumber).trim().toUpperCase()
      );
      if (dup) {
        const msg = `เบอร์กล่อง "${f.boxNumber}" มีปูกำลังเลี้ยงอยู่แล้ว กรุณาตรวจสอบ หรือเก็บเกี่ยวกล่องเดิมก่อน`;
        setBoxNumberError(msg);
        alert(msg);
        return;
      }
    }
    setBoxNumberError("");
    // Snapshot the starting weight the first time (before any molt is
    // recorded) so molt growth % can always be compared against it.
    const baseInitialWeight = f.moltHistory && f.moltHistory.length ? f.initialWeight : f.currentWeight;
    const payload = restock
      ? { ...f, status: "active", batchNumber: nextBatchFor ? nextBatchFor(f.boxNumber) : (f.batchNumber || 1) + 1, stockDate: f.stockDate || todayStr(), moltHistory: [], initialWeight: f.currentWeight, harvestDate: null }
      : { ...f, status: "active", initialWeight: baseInitialWeight };
    onSave(payload);
  };
  const addMoltEntry = (entry) => {
    set("moltHistory", [...f.moltHistory || [], entry]);
    set("currentWeight", entry.weight);
  };
  return /* @__PURE__ */ React.createElement(Modal, { title: isNew ? "\u0E40\u0E1E\u0E34\u0E48\u0E21\u0E01\u0E25\u0E48\u0E2D\u0E07\u0E1B\u0E39\u0E43\u0E2B\u0E21\u0E48" : restock ? `\u0E25\u0E07\u0E1B\u0E39\u0E43\u0E2B\u0E21\u0E48 \u2014 \u0E01\u0E25\u0E48\u0E2D\u0E07 #${f.boxNumber}` : `\u0E01\u0E25\u0E48\u0E2D\u0E07 #${f.boxNumber} \xB7 \u0E23\u0E38\u0E48\u0E19\u0E17\u0E35\u0E48 ${f.batchNumber}`, onClose, wide: true }, /* @__PURE__ */ React.createElement("div", { className: "cf-grid-2col", style: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: "0 16px" } }, /* @__PURE__ */ React.createElement(Field, { label: "\u0E40\u0E1A\u0E2D\u0E23\u0E4C\u0E01\u0E25\u0E48\u0E2D\u0E07", hint: "\u0E23\u0E39\u0E1B\u0E41\u0E1A\u0E1A: \u0E15\u0E31\u0E27\u0E2D\u0E31\u0E01\u0E29\u0E23\u0E41\u0E16\u0E27 + \u0E40\u0E25\u0E02\u0E0A\u0E48\u0E2D\u0E07 \u0E40\u0E0A\u0E48\u0E19 A01, B03" }, /* @__PURE__ */ React.createElement("input", { className: "cf-boxnumber-field", style: { ...inputStyle, ...(boxNumberError ? { border: `1.5px solid ${C.coral}` } : {}) }, value: f.boxNumber, disabled: !isNew, onChange: (e) => { set("boxNumber", e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "")); setBoxNumberError(""); }, placeholder: "\u0E40\u0E0A\u0E48\u0E19 A01" }), boxNumberError && /* @__PURE__ */ React.createElement("div", { style: { fontSize: 11.5, color: C.coral, marginTop: 4, fontWeight: 600 } }, boxNumberError)), /* @__PURE__ */ React.createElement(Field, { label: "\u0E40\u0E1E\u0E28" }, /* @__PURE__ */ React.createElement("select", { style: inputStyle, value: f.sex, onChange: (e) => set("sex", e.target.value) }, /* @__PURE__ */ React.createElement("option", { value: "male" }, "\u0E15\u0E31\u0E27\u0E1C\u0E39\u0E49"), /* @__PURE__ */ React.createElement("option", { value: "female" }, "\u0E15\u0E31\u0E27\u0E40\u0E21\u0E35\u0E22"))), /* @__PURE__ */ React.createElement("div", { style: { gridColumn: "1 / -1" } }, /* @__PURE__ */ React.createElement(Field, { label: "\u0E27\u0E31\u0E19\u0E25\u0E07\u0E1B\u0E39" }, /* @__PURE__ */ React.createElement("input", { type: "date", className: "cf-date-field", style: inputStyle, value: f.stockDate || "", onChange: (e) => set("stockDate", e.target.value) }))), /* @__PURE__ */ React.createElement(Field, { label: "\u0E19\u0E49\u0E33\u0E2B\u0E19\u0E31\u0E01\u0E1B\u0E31\u0E08\u0E08\u0E38\u0E1A\u0E31\u0E19 (\u0E01\u0E23\u0E31\u0E21)" }, /* @__PURE__ */ React.createElement("input", { type: "number", style: inputStyle, value: f.currentWeight, onChange: (e) => set("currentWeight", e.target.value) })), /* @__PURE__ */ React.createElement(Field, { label: "\u0E19\u0E49\u0E33\u0E2B\u0E19\u0E31\u0E01\u0E40\u0E1B\u0E49\u0E32\u0E2B\u0E21\u0E32\u0E22 (\u0E01\u0E23\u0E31\u0E21)" }, /* @__PURE__ */ React.createElement("input", { type: "number", style: inputStyle, value: f.targetWeight, onChange: (e) => set("targetWeight", e.target.value) })), /* @__PURE__ */ React.createElement(Field, { label: "\u0E40\u0E1B\u0E49\u0E32\u0E2B\u0E21\u0E32\u0E22\u0E01\u0E25\u0E48\u0E2D\u0E07\u0E19\u0E35\u0E49" }, /* @__PURE__ */ React.createElement("select", { style: inputStyle, value: f.goal || "", onChange: (e) => set("goal", e.target.value) }, /* @__PURE__ */ React.createElement("option", { value: "" }, "\u0E44\u0E21\u0E48\u0E23\u0E30\u0E1A\u0E38"), /* @__PURE__ */ React.createElement("option", { value: "fatten" }, "\u0E02\u0E38\u0E19\u0E43\u0E2B\u0E49\u0E42\u0E15"), /* @__PURE__ */ React.createElement("option", { value: "eggs" }, "\u0E23\u0E2D\u0E44\u0E02\u0E48"), /* @__PURE__ */ React.createElement("option", { value: "molt" }, "\u0E23\u0E2D\u0E25\u0E2D\u0E01\u0E04\u0E23\u0E32\u0E1A"), /* @__PURE__ */ React.createElement("option", { value: "quick_sale" }, "\u0E02\u0E32\u0E22\u0E14\u0E48\u0E27\u0E19"), /* @__PURE__ */ React.createElement("option", { value: "broodstock" }, "\u0E1E\u0E48\u0E2D\u0E1E\u0E31\u0E19\u0E18\u0E38\u0E4C"))), f.sex === "female" && /* @__PURE__ */ React.createElement(Field, { label: "\u0E44\u0E02\u0E48 (%)" }, /* @__PURE__ */ React.createElement("input", { type: "number", min: "0", max: "100", style: inputStyle, disabled: !!f.unmated, value: f.eggPercent, onChange: (e) => set("eggPercent", e.target.value) })), f.sex === "female" && /* @__PURE__ */ React.createElement("div", { style: { gridColumn: "1 / -1", marginTop: -6, marginBottom: 8 } }, /* @__PURE__ */ React.createElement("label", { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: C.text, cursor: "pointer" } }, /* @__PURE__ */ React.createElement("input", { type: "checkbox", checked: !!f.unmated, onChange: (e) => set("unmated", e.target.checked) }), "\u0E15\u0E31\u0E27\u0E40\u0E21\u0E35\u0E22\u0E44\u0E21\u0E48\u0E21\u0E35\u0E44\u0E02\u0E48 / \u0E01\u0E30\u0E40\u0E17\u0E22 (\u0E23\u0E32\u0E04\u0E32\u0E43\u0E0A\u0E49\u0E40\u0E23\u0E15\u0E15\u0E31\u0E27\u0E40\u0E21\u0E35\u0E22\u0E40\u0E14\u0E34\u0E21)")), /* @__PURE__ */ React.createElement(Field, { label: "\u0E1B\u0E23\u0E34\u0E21\u0E32\u0E13\u0E2D\u0E32\u0E2B\u0E32\u0E23/\u0E27\u0E31\u0E19 (\u0E01\u0E23\u0E31\u0E21)" }, /* @__PURE__ */ React.createElement("input", { type: "number", style: inputStyle, value: f.feedPerDay, onChange: (e) => set("feedPerDay", e.target.value) })), /* @__PURE__ */ React.createElement(Field, { label: "\u0E15\u0E49\u0E19\u0E17\u0E38\u0E19\u0E17\u0E35\u0E48\u0E23\u0E31\u0E1A\u0E21\u0E32 (\u0E1A\u0E32\u0E17/\u0E15\u0E31\u0E27)" }, /* @__PURE__ */ React.createElement("input", { type: "number", style: inputStyle, value: f.costPerCrab, onChange: (e) => set("costPerCrab", e.target.value) }))), /* @__PURE__ */ React.createElement(Field, { label: "\u0E23\u0E32\u0E04\u0E32\u0E02\u0E32\u0E22\u0E40\u0E09\u0E1E\u0E32\u0E30\u0E01\u0E25\u0E48\u0E2D\u0E07\u0E19\u0E35\u0E49 (\u0E1A\u0E32\u0E17/\u0E01\u0E01.)", hint: "\u0E40\u0E27\u0E49\u0E19\u0E27\u0E48\u0E32\u0E07\u0E44\u0E27\u0E49 = \u0E43\u0E0A\u0E49\u0E23\u0E32\u0E04\u0E32\u0E01\u0E25\u0E32\u0E07\u0E08\u0E32\u0E01\u0E2B\u0E19\u0E49\u0E32\u0E15\u0E31\u0E49\u0E07\u0E04\u0E48\u0E32\u0E15\u0E32\u0E21\u0E1B\u0E23\u0E30\u0E40\u0E20\u0E17\u0E1B\u0E39" }, /* @__PURE__ */ React.createElement("input", { type: "number", style: inputStyle, value: f.sellPriceOverride, onChange: (e) => set("sellPriceOverride", e.target.value), placeholder: "\u2014" })), !restock && !isNew && /* @__PURE__ */ React.createElement(MoltHistorySection, { f, settings, onAddMolt: addMoltEntry }), /* @__PURE__ */ React.createElement(Field, { label: "\u0E2B\u0E21\u0E32\u0E22\u0E40\u0E2B\u0E15\u0E38" }, /* @__PURE__ */ React.createElement("textarea", { style: { ...inputStyle, minHeight: 60, resize: "vertical" }, value: f.notes, onChange: (e) => set("notes", e.target.value) })), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "space-between", marginTop: 18 } }, /* @__PURE__ */ React.createElement("div", null, !isNew && onDelete && /* @__PURE__ */ React.createElement(Btn, { tone: "danger", onClick: async () => {
    if (await askConfirm("\u0E25\u0E1A\u0E01\u0E25\u0E48\u0E2D\u0E07\u0E19\u0E35\u0E49\u0E2D\u0E2D\u0E01\u0E08\u0E32\u0E01\u0E23\u0E30\u0E1A\u0E1A?")) onDelete(f.id);
  } }, "\u0E25\u0E1A\u0E01\u0E25\u0E48\u0E2D\u0E07"), !isNew && onPrintSticker && /* @__PURE__ */ React.createElement(Btn, { tone: "ghost", onClick: () => onPrintSticker(f) }, "\u{1F5A8}\uFE0F \u0E1E\u0E34\u0E21\u0E1E\u0E4C\u0E2A\u0E15\u0E34\u0E01\u0E40\u0E01\u0E2D\u0E23\u0E4C")), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 8 } }, /* @__PURE__ */ React.createElement(Btn, { tone: "ghost", onClick: onClose }, "\u0E22\u0E01\u0E40\u0E25\u0E34\u0E01"), /* @__PURE__ */ React.createElement(Btn, { tone: "seagrass", onClick: submit }, restock ? "\u0E25\u0E07\u0E1B\u0E39\u0E43\u0E2B\u0E21\u0E48" : isNew ? "\u0E40\u0E1E\u0E34\u0E48\u0E21\u0E01\u0E25\u0E48\u0E2D\u0E07" : "\u0E1A\u0E31\u0E19\u0E17\u0E36\u0E01"))));
}
function HarvestModal({ box, onConfirm, onClose }) {
  const [d, setD] = useState({
    harvestDate: todayStr(),
    weight: box.currentWeight || "",
    eggPercent: box.eggPercent || 0,
    sellPricePerCrab: ""
  });
  const set = (k, v) => setD((p) => ({ ...p, [k]: v }));
  const profit = d.sellPricePerCrab !== "" && box.costPerCrab !== "" && !isNaN(d.sellPricePerCrab) && !isNaN(box.costPerCrab) ? Number(d.sellPricePerCrab) - Number(box.costPerCrab) : null;
  return /* @__PURE__ */ React.createElement(Modal, { title: `\u0E1A\u0E31\u0E19\u0E17\u0E36\u0E01\u0E08\u0E31\u0E1A\u0E1B\u0E39 \u2014 \u0E01\u0E25\u0E48\u0E2D\u0E07 #${box.boxNumber}`, onClose }, /* @__PURE__ */ React.createElement(Field, { label: "\u0E27\u0E31\u0E19\u0E08\u0E31\u0E1A" }, /* @__PURE__ */ React.createElement("input", { type: "date", style: inputStyle, value: d.harvestDate, onChange: (e) => set("harvestDate", e.target.value) })), /* @__PURE__ */ React.createElement(Field, { label: "\u0E19\u0E49\u0E33\u0E2B\u0E19\u0E31\u0E01\u0E15\u0E2D\u0E19\u0E08\u0E31\u0E1A (\u0E01\u0E23\u0E31\u0E21)" }, /* @__PURE__ */ React.createElement("input", { type: "number", style: inputStyle, value: d.weight, onChange: (e) => set("weight", e.target.value) })), box.sex === "female" && /* @__PURE__ */ React.createElement(Field, { label: "\u0E44\u0E02\u0E48\u0E15\u0E2D\u0E19\u0E08\u0E31\u0E1A (%)" }, /* @__PURE__ */ React.createElement("input", { type: "number", style: inputStyle, value: d.eggPercent, onChange: (e) => set("eggPercent", e.target.value) })), /* @__PURE__ */ React.createElement(Field, { label: "\u0E23\u0E32\u0E04\u0E32\u0E08\u0E33\u0E2B\u0E19\u0E48\u0E32\u0E22 (\u0E1A\u0E32\u0E17/\u0E15\u0E31\u0E27)" }, /* @__PURE__ */ React.createElement("input", { type: "number", style: inputStyle, value: d.sellPricePerCrab, onChange: (e) => set("sellPricePerCrab", e.target.value) })), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12.5, color: C.muted, marginBottom: 14 } }, "\u0E15\u0E49\u0E19\u0E17\u0E38\u0E19\u0E17\u0E35\u0E48\u0E23\u0E31\u0E1A\u0E21\u0E32: ", /* @__PURE__ */ React.createElement("b", { style: { fontFamily: MONO, color: C.text } }, money(box.costPerCrab), " \u0E1A\u0E32\u0E17/\u0E15\u0E31\u0E27"), profit !== null && /* @__PURE__ */ React.createElement("span", { style: { marginLeft: 10 } }, "\u0E01\u0E33\u0E44\u0E23\u0E42\u0E14\u0E22\u0E1B\u0E23\u0E30\u0E21\u0E32\u0E13: ", /* @__PURE__ */ React.createElement("b", { style: { fontFamily: MONO, color: profit >= 0 ? C.seagrass : C.coral } }, money(profit), " \u0E1A\u0E32\u0E17/\u0E15\u0E31\u0E27"))), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8 } }, /* @__PURE__ */ React.createElement(Btn, { tone: "ghost", onClick: onClose }, "\u0E22\u0E01\u0E40\u0E25\u0E34\u0E01"), /* @__PURE__ */ React.createElement(Btn, { tone: "coral", onClick: () => onConfirm(d) }, "\u0E22\u0E37\u0E19\u0E22\u0E31\u0E19\u0E01\u0E32\u0E23\u0E08\u0E31\u0E1A\u0E1B\u0E39")));
}
function DeathModal({ box, settings, onConfirm, onClose }) {
  const [d, setD] = useState({
    deathDate: todayStr(),
    weight: box.currentWeight || "",
    note: ""
  });
  const set = (k, v) => setD((p) => ({ ...p, [k]: v }));
  const fin = computeBoxFinance(box, settings);
  const lossAmount = fin.costBasis;
  return (
    <Modal title={`บันทึกปูตาย — กล่อง #${box.boxNumber}`} onClose={onClose}>
      <Field label="วันที่ตาย">
        <input type="date" style={inputStyle} value={d.deathDate} onChange={(e) => set("deathDate", e.target.value)} />
      </Field>
      <Field label="น้ำหนักตอนตาย (กรัม, ถ้ามี)">
        <input type="number" style={inputStyle} value={d.weight} onChange={(e) => set("weight", e.target.value)} placeholder="—" />
      </Field>
      <Field label="สาเหตุ / หมายเหตุ (ถ้ามี)">
        <textarea style={{ ...inputStyle, minHeight: 60, resize: "vertical" }} value={d.note} placeholder="เช่น น้ำเสีย, ลอกคราบไม่สำเร็จ, โรค" onChange={(e) => set("note", e.target.value)} />
      </Field>
      <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 14 }}>
        ต้นทุนที่จะบันทึกเป็นขาดทุน (ต้นทุนรับมา + ค่าอาหารสะสม):{" "}
        <b style={{ fontFamily: MONO, color: C.coral }}>{money(lossAmount)} บาท/ตัว</b>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <Btn tone="ghost" onClick={onClose}>ยกเลิก</Btn>
        <Btn tone="coral" onClick={() => onConfirm(d)}>💀 ยืนยันว่าปูตาย</Btn>
      </div>
    </Modal>
  );
}
function WaterTab({ waterLogs, settings, onAddLog, onUpdateSettings }) {
  const params = settings.parameters;
  const [readings, setReadings] = useState(() => Object.fromEntries(params.map((p) => [p.key, ""])));
  const [notes, setNotes] = useState("");
  const [when, setWhen] = useState(() => (/* @__PURE__ */ new Date()).toISOString().slice(0, 16));
  const latest = waterLogs.length ? waterLogs[waterLogs.length - 1] : null;
  const submit = () => {
    const clean = {};
    let any = false;
    params.forEach((p) => {
      if (readings[p.key] !== "" && !isNaN(readings[p.key])) {
        clean[p.key] = Number(readings[p.key]);
        any = true;
      }
    });
    if (!any) {
      alert("\u0E01\u0E23\u0E2D\u0E01\u0E04\u0E48\u0E32\u0E2D\u0E22\u0E48\u0E32\u0E07\u0E19\u0E49\u0E2D\u0E22 1 \u0E1E\u0E32\u0E23\u0E32\u0E21\u0E34\u0E40\u0E15\u0E2D\u0E23\u0E4C");
      return;
    }
    onAddLog({ id: uid(), datetime: when, readings: clean, notes });
    setReadings(Object.fromEntries(params.map((p) => [p.key, ""])));
    setNotes("");
  };
  const dosing = useMemo(() => {
    if (!latest) return [];
    return params.filter((p) => p.dosable && p.doseFactor > 0).map((p) => {
      const cur = latest.readings[p.key];
      if (cur === void 0) return null;
      const diff = p.target - cur;
      if (Math.abs(diff) < 1e-3) return null;
      const need = diff * settings.tankVolumeLiters * p.doseFactor;
      return { param: p, cur, diff, need };
    }).filter(Boolean);
  }, [latest, params, settings.tankVolumeLiters]);
  const trend = (key) => waterLogs.slice(-10).map((l) => l.readings[key]).filter((v) => v !== void 0);
  return /* @__PURE__ */ React.createElement("div", { className: "cf-grid-water", style: { display: "grid", gridTemplateColumns: "380px 1fr", gap: 20, alignItems: "start" } }, /* @__PURE__ */ React.createElement("div", { style: cardStyle }, /* @__PURE__ */ React.createElement(SectionTitle, null, "\u0E1A\u0E31\u0E19\u0E17\u0E36\u0E01\u0E04\u0E48\u0E32\u0E19\u0E49\u0E33\u0E27\u0E31\u0E19\u0E19\u0E35\u0E49"), /* @__PURE__ */ React.createElement(Field, { label: "\u0E27\u0E31\u0E19\u0E40\u0E27\u0E25\u0E32" }, /* @__PURE__ */ React.createElement("input", { type: "datetime-local", style: inputStyle, value: when, onChange: (e) => setWhen(e.target.value) })), params.map((p) => /* @__PURE__ */ React.createElement(Field, { key: p.key, label: `${p.label}${p.unit ? ` (${p.unit})` : ""}`, hint: `\u0E0A\u0E48\u0E27\u0E07\u0E1B\u0E01\u0E15\u0E34 ${p.min}\u2013${p.max}${p.unit}` }, /* @__PURE__ */ React.createElement("input", { type: "number", step: "any", style: inputStyle, value: readings[p.key], onChange: (e) => setReadings((r) => ({ ...r, [p.key]: e.target.value })) }))), /* @__PURE__ */ React.createElement(Field, { label: "\u0E2B\u0E21\u0E32\u0E22\u0E40\u0E2B\u0E15\u0E38" }, /* @__PURE__ */ React.createElement("textarea", { style: { ...inputStyle, minHeight: 50 }, value: notes, onChange: (e) => setNotes(e.target.value) })), /* @__PURE__ */ React.createElement(Btn, { tone: "seagrass", onClick: submit }, "\u0E1A\u0E31\u0E19\u0E17\u0E36\u0E01\u0E04\u0E48\u0E32\u0E19\u0E49\u0E33")), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 20 } }, /* @__PURE__ */ React.createElement("div", { style: cardStyle }, /* @__PURE__ */ React.createElement(SectionTitle, { sub: latest ? `\u0E2D\u0E31\u0E1B\u0E40\u0E14\u0E15\u0E25\u0E48\u0E32\u0E2A\u0E38\u0E14 ${fmtDate(latest.datetime)}` : "\u0E22\u0E31\u0E07\u0E44\u0E21\u0E48\u0E21\u0E35\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25" }, "\u0E2A\u0E16\u0E32\u0E19\u0E30\u0E04\u0E38\u0E13\u0E20\u0E32\u0E1E\u0E19\u0E49\u0E33"), !latest && /* @__PURE__ */ React.createElement("div", { style: { color: C.muted, fontSize: 13 } }, "\u0E1A\u0E31\u0E19\u0E17\u0E36\u0E01\u0E04\u0E48\u0E32\u0E19\u0E49\u0E33\u0E04\u0E23\u0E31\u0E49\u0E07\u0E41\u0E23\u0E01\u0E40\u0E1E\u0E37\u0E48\u0E2D\u0E40\u0E23\u0E34\u0E48\u0E21\u0E15\u0E34\u0E14\u0E15\u0E32\u0E21"), latest && /* @__PURE__ */ React.createElement("div", { className: "cf-grid-2col", style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 24px" } }, params.map((p) => {
    var _a;
    return /* @__PURE__ */ React.createElement(GaugeBar, { key: p.key, param: p, value: (_a = latest.readings[p.key]) != null ? _a : null });
  }))), /* @__PURE__ */ React.createElement(WeatherCard, { settings }), /* @__PURE__ */ React.createElement(PumpScheduleCard, { settings, onUpdateSettings }), /* @__PURE__ */ React.createElement("div", { style: cardStyle }, /* @__PURE__ */ React.createElement(SectionTitle, null, "\u0E04\u0E33\u0E19\u0E27\u0E13\u0E1B\u0E23\u0E34\u0E21\u0E32\u0E13\u0E2A\u0E32\u0E23\u0E17\u0E35\u0E48\u0E15\u0E49\u0E2D\u0E07\u0E40\u0E15\u0E34\u0E21 (\u0E42\u0E14\u0E22\u0E1B\u0E23\u0E30\u0E21\u0E32\u0E13)"), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12, color: C.muted, marginBottom: 10 } }, "\u0E04\u0E33\u0E19\u0E27\u0E13\u0E08\u0E32\u0E01\u0E1B\u0E23\u0E34\u0E21\u0E32\u0E15\u0E23\u0E19\u0E49\u0E33 ", num(settings.tankVolumeLiters), " \u0E25\u0E34\u0E15\u0E23 \u0E41\u0E25\u0E30\u0E04\u0E48\u0E32\u0E04\u0E39\u0E13\u0E42\u0E14\u0E2A\u0E17\u0E35\u0E48\u0E15\u0E31\u0E49\u0E07\u0E44\u0E27\u0E49 \u2014 \u0E04\u0E27\u0E23\u0E1B\u0E23\u0E31\u0E1A\u0E04\u0E48\u0E32\u0E04\u0E39\u0E13\u0E43\u0E2B\u0E49\u0E15\u0E23\u0E07\u0E01\u0E31\u0E1A\u0E1C\u0E25\u0E34\u0E15\u0E20\u0E31\u0E13\u0E11\u0E4C\u0E08\u0E23\u0E34\u0E07\u0E17\u0E35\u0E48\u0E43\u0E0A\u0E49\u0E43\u0E19\u0E2B\u0E19\u0E49\u0E32\u0E15\u0E31\u0E49\u0E07\u0E04\u0E48\u0E32"), dosing.length === 0 && /* @__PURE__ */ React.createElement("div", { style: { fontSize: 13, color: C.muted } }, "\u0E44\u0E21\u0E48\u0E21\u0E35\u0E04\u0E48\u0E32\u0E17\u0E35\u0E48\u0E15\u0E49\u0E2D\u0E07\u0E1B\u0E23\u0E31\u0E1A\u0E15\u0E2D\u0E19\u0E19\u0E35\u0E49 \u0E2B\u0E23\u0E37\u0E2D\u0E22\u0E31\u0E07\u0E44\u0E21\u0E48\u0E44\u0E14\u0E49\u0E1A\u0E31\u0E19\u0E17\u0E36\u0E01\u0E04\u0E48\u0E32\u0E19\u0E49\u0E33"), dosing.map(({ param, cur, diff, need }) => /* @__PURE__ */ React.createElement("div", { key: param.key, style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${C.line}` } }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { fontWeight: 700, fontSize: 13.5 } }, param.label), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 11.5, color: C.muted } }, "\u0E1B\u0E31\u0E08\u0E08\u0E38\u0E1A\u0E31\u0E19 ", cur, param.unit, " \u2192 \u0E40\u0E1B\u0E49\u0E32\u0E2B\u0E21\u0E32\u0E22 ", param.target, param.unit)), /* @__PURE__ */ React.createElement("div", { style: { textAlign: "right" } }, /* @__PURE__ */ React.createElement("div", { style: { fontFamily: MONO, fontWeight: 700, color: diff > 0 ? C.water : C.amber } }, diff > 0 ? "+" : "", num(need, 2)), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 10.5, color: C.muted } }, param.doseUnit))))), /* @__PURE__ */ React.createElement("div", { style: cardStyle }, /* @__PURE__ */ React.createElement(SectionTitle, null, "\u0E41\u0E19\u0E27\u0E42\u0E19\u0E49\u0E21 (10 \u0E04\u0E23\u0E31\u0E49\u0E07\u0E25\u0E48\u0E32\u0E2A\u0E38\u0E14)"), /* @__PURE__ */ React.createElement("div", { className: "cf-grid-2col", style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 } }, params.map((p) => /* @__PURE__ */ React.createElement("div", { key: p.key }, /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12, fontWeight: 700, marginBottom: 2 } }, p.label), /* @__PURE__ */ React.createElement(Sparkline, { values: trend(p.key), min: p.min, max: p.max, color: C.water }))))), /* @__PURE__ */ React.createElement("div", { style: cardStyle }, /* @__PURE__ */ React.createElement(SectionTitle, null, "\u0E1B\u0E23\u0E30\u0E27\u0E31\u0E15\u0E34\u0E04\u0E48\u0E32\u0E19\u0E49\u0E33"), /* @__PURE__ */ React.createElement("div", { style: { maxHeight: 260, overflow: "auto" } }, /* @__PURE__ */ React.createElement("table", { style: tableStyle }, /* @__PURE__ */ React.createElement("thead", null, /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E27\u0E31\u0E19\u0E40\u0E27\u0E25\u0E32"), params.map((p) => /* @__PURE__ */ React.createElement("th", { key: p.key, style: thStyle }, p.label)), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E2B\u0E21\u0E32\u0E22\u0E40\u0E2B\u0E15\u0E38"))), /* @__PURE__ */ React.createElement("tbody", null, [...waterLogs].reverse().map((l) => /* @__PURE__ */ React.createElement("tr", { key: l.id }, /* @__PURE__ */ React.createElement("td", { style: tdStyle }, fmtDate(l.datetime)), params.map((p) => {
    var _a;
    return /* @__PURE__ */ React.createElement("td", { key: p.key, style: { ...tdStyle, fontFamily: MONO } }, (_a = l.readings[p.key]) != null ? _a : "\u2014");
  }), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, l.notes || "\u2014"))), waterLogs.length === 0 && /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("td", { style: tdStyle, colSpan: params.length + 2 }, "\u0E22\u0E31\u0E07\u0E44\u0E21\u0E48\u0E21\u0E35\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25"))))))));
}
function SectionTitle({ children, sub }) {
  return /* @__PURE__ */ React.createElement("div", { style: { marginBottom: 14 } }, /* @__PURE__ */ React.createElement("div", { style: { fontFamily: DISPLAY, fontWeight: 700, fontSize: 16, color: C.ink } }, children), sub && /* @__PURE__ */ React.createElement("div", { style: { fontSize: 11.5, color: C.muted, marginTop: 1 } }, sub));
}
const cardStyle = { background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: 18 };
const tableStyle = { width: "100%", borderCollapse: "collapse", fontSize: 12.5 };
const thStyle = { textAlign: "left", padding: "6px 8px", color: "#fff", background: C.ink, fontWeight: 700, fontSize: 11, borderBottom: `1px solid ${C.line}`, whiteSpace: "nowrap", position: "sticky", top: 0 };
const tdStyle = { padding: "6px 8px", borderBottom: `1px solid ${C.line}`, whiteSpace: "nowrap" };
function pelletsFor(grams, pelletWeight) {
  const g = Number(grams) || 0;
  const pw = Number(pelletWeight) || 0;
  if (g <= 0 || pw <= 0) return 0;
  return Math.max(1, Math.round(g / pw));
}
function FeedTab({ boxes, settings, onUpdateBox, onUpdateSettings }) {
  const active = boxes.filter((b) => b.status === "active" && b.currentWeight);
  const totalBiomass = active.reduce((s, b) => s + Number(b.currentWeight || 0), 0);
  const [rate, setRate] = useState(settings.feedRatePercent);
  const [pelletWeight, setPelletWeight] = useState(settings.feedPelletWeightGrams || 0.1);
  const [intervalDays, setIntervalDays] = useState(settings.feedIntervalDays || 1);
  const [saveState, setSaveState] = useState("idle");
  const handleSaveDefaults = async () => {
    setSaveState("saving");
    let ok = false;
    try {
      ok = await onUpdateSettings({ ...settings, feedRatePercent: Number(rate), feedPelletWeightGrams: Number(pelletWeight), feedIntervalDays: Number(intervalDays) });
    } catch (e) {
      ok = false;
    }
    setSaveState(ok === false ? "error" : "saved");
    setTimeout(() => setSaveState("idle"), 2500);
  };
  const recommended = totalBiomass * rate / 100;
  const recommendedPellets = pelletsFor(recommended, pelletWeight);
  return /* @__PURE__ */ React.createElement("div", { className: "cf-grid-feed", style: { display: "grid", gridTemplateColumns: "320px 1fr", gap: 20, alignItems: "start" } }, /* @__PURE__ */ React.createElement("div", { style: cardStyle }, /* @__PURE__ */ React.createElement(SectionTitle, null, "\u0E04\u0E33\u0E19\u0E27\u0E13\u0E2D\u0E32\u0E2B\u0E32\u0E23\u0E23\u0E27\u0E21"), /* @__PURE__ */ React.createElement(Field, { label: "\u0E2D\u0E31\u0E15\u0E23\u0E32\u0E01\u0E32\u0E23\u0E43\u0E2B\u0E49\u0E2D\u0E32\u0E2B\u0E32\u0E23 (% \u0E02\u0E2D\u0E07\u0E19\u0E49\u0E33\u0E2B\u0E19\u0E31\u0E01\u0E15\u0E31\u0E27/\u0E27\u0E31\u0E19)", hint: "\u0E04\u0E48\u0E32\u0E17\u0E31\u0E48\u0E27\u0E44\u0E1B\u0E2A\u0E33\u0E2B\u0E23\u0E31\u0E1A\u0E1B\u0E39\u0E14\u0E33\u0E02\u0E38\u0E19\u0E2D\u0E22\u0E39\u0E48\u0E17\u0E35\u0E48\u0E1B\u0E23\u0E30\u0E21\u0E32\u0E13 3\u20135% \u0E1B\u0E23\u0E31\u0E1A\u0E15\u0E32\u0E21\u0E0A\u0E19\u0E34\u0E14\u0E2D\u0E32\u0E2B\u0E32\u0E23\u0E41\u0E25\u0E30\u0E2D\u0E38\u0E13\u0E2B\u0E20\u0E39\u0E21\u0E34\u0E19\u0E49\u0E33" }, /* @__PURE__ */ React.createElement("input", { type: "number", step: "0.1", style: inputStyle, value: rate, onChange: (e) => setRate(e.target.value) })), /* @__PURE__ */ React.createElement(Field, { label: "\u0E19\u0E49\u0E33\u0E2B\u0E19\u0E31\u0E01\u0E2D\u0E32\u0E2B\u0E32\u0E23\u0E15\u0E48\u0E2D\u0E40\u0E21\u0E47\u0E14 (\u0E01\u0E23\u0E31\u0E21)", hint: "\u0E40\u0E0A\u0E48\u0E19 0.1 = \u0E2D\u0E32\u0E2B\u0E32\u0E23\u0E40\u0E21\u0E47\u0E14\u0E25\u0E30 0.1 \u0E01\u0E23\u0E31\u0E21 \u0E43\u0E0A\u0E49\u0E41\u0E1B\u0E25\u0E07\u0E01\u0E23\u0E31\u0E21\u2192\u0E40\u0E21\u0E47\u0E14" }, /* @__PURE__ */ React.createElement("input", { type: "number", step: "0.01", min: "0", style: inputStyle, value: pelletWeight, onChange: (e) => setPelletWeight(e.target.value) })), /* @__PURE__ */ React.createElement(Field, { label: "\u0E43\u0E2B\u0E49\u0E2D\u0E32\u0E2B\u0E32\u0E23\u0E17\u0E38\u0E01\u0E01\u0E35\u0E48\u0E27\u0E31\u0E19 (\u0E04\u0E48\u0E32\u0E40\u0E23\u0E34\u0E48\u0E21\u0E15\u0E49\u0E19)", hint: "1 = \u0E17\u0E38\u0E01\u0E27\u0E31\u0E19, 2 = \u0E27\u0E31\u0E19\u0E40\u0E27\u0E49\u0E19\u0E27\u0E31\u0E19 \u0E1B\u0E23\u0E31\u0E1A\u0E23\u0E32\u0E22\u0E01\u0E25\u0E48\u0E2D\u0E07\u0E44\u0E14\u0E49\u0E43\u0E19\u0E15\u0E32\u0E23\u0E32\u0E07\u0E14\u0E49\u0E32\u0E19\u0E25\u0E48\u0E32\u0E07" }, /* @__PURE__ */ React.createElement("input", { type: "number", step: "1", min: "1", style: inputStyle, value: intervalDays, onChange: (e) => setIntervalDays(e.target.value) })), /* @__PURE__ */ React.createElement("div", { style: { marginTop: 4 } }, /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12, color: C.muted } }, "\u0E19\u0E49\u0E33\u0E2B\u0E19\u0E31\u0E01\u0E23\u0E27\u0E21\u0E1B\u0E39\u0E17\u0E35\u0E48\u0E21\u0E35\u0E0A\u0E35\u0E27\u0E34\u0E15\u0E17\u0E31\u0E49\u0E07\u0E2B\u0E21\u0E14"), /* @__PURE__ */ React.createElement("div", { style: { fontFamily: MONO, fontSize: 22, fontWeight: 700, color: C.ink } }, num(totalBiomass), " g")), /* @__PURE__ */ React.createElement("div", { style: { marginTop: 10 } }, /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12, color: C.muted } }, "\u0E1B\u0E23\u0E34\u0E21\u0E32\u0E13\u0E2D\u0E32\u0E2B\u0E32\u0E23\u0E41\u0E19\u0E30\u0E19\u0E33/\u0E27\u0E31\u0E19"), /* @__PURE__ */ React.createElement("div", { style: { fontFamily: MONO, fontSize: 26, fontWeight: 700, color: C.seagrass } }, num(recommended), " g", /* @__PURE__ */ React.createElement("span", { style: { fontSize: 14, color: C.muted, marginLeft: 8 } }, "\u2248 ", recommendedPellets.toLocaleString(), " \u0E40\u0E21\u0E47\u0E14/\u0E27\u0E31\u0E19"))), /* @__PURE__ */ React.createElement("div", { style: { marginTop: 14, display: "flex", alignItems: "center" } }, /* @__PURE__ */ React.createElement(Btn, { tone: "ghost", size: "sm", disabled: saveState === "saving", onClick: handleSaveDefaults }, saveState === "saving" ? "\u0E01\u0E33\u0E25\u0E31\u0E07\u0E1A\u0E31\u0E19\u0E17\u0E36\u0E01\u2026" : "\u0E1A\u0E31\u0E19\u0E17\u0E36\u0E01\u0E04\u0E48\u0E32\u0E19\u0E35\u0E49\u0E40\u0E1B\u0E47\u0E19\u0E04\u0E48\u0E32\u0E40\u0E23\u0E34\u0E48\u0E21\u0E15\u0E49\u0E19"), /* @__PURE__ */ React.createElement(SaveStatusText, { state: saveState }))), /* @__PURE__ */ React.createElement("div", { style: cardStyle }, /* @__PURE__ */ React.createElement(SectionTitle, { sub: `${active.length} \u0E01\u0E25\u0E48\u0E2D\u0E07\u0E17\u0E35\u0E48\u0E01\u0E33\u0E25\u0E31\u0E07\u0E40\u0E25\u0E35\u0E49\u0E22\u0E07\u0E2D\u0E22\u0E39\u0E48` }, "\u0E1B\u0E23\u0E34\u0E21\u0E32\u0E13\u0E2D\u0E32\u0E2B\u0E32\u0E23\u0E23\u0E32\u0E22\u0E01\u0E25\u0E48\u0E2D\u0E07"), /* @__PURE__ */ React.createElement("div", { style: { overflowX: "auto" } }, /* @__PURE__ */ React.createElement("table", { style: tableStyle }, /* @__PURE__ */ React.createElement("thead", null, /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E01\u0E25\u0E48\u0E2D\u0E07"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E19\u0E49\u0E33\u0E2B\u0E19\u0E31\u0E01 (g)"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E41\u0E19\u0E30\u0E19\u0E33 (g/\u0E27\u0E31\u0E19)"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E43\u0E2B\u0E49\u0E17\u0E38\u0E01\u0E01\u0E35\u0E48\u0E27\u0E31\u0E19"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E40\u0E21\u0E47\u0E14/\u0E04\u0E23\u0E31\u0E49\u0E07"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E15\u0E31\u0E49\u0E07\u0E44\u0E27\u0E49\u0E08\u0E23\u0E34\u0E07 (g/\u0E27\u0E31\u0E19)"), /* @__PURE__ */ React.createElement("th", { style: thStyle }))), /* @__PURE__ */ React.createElement("tbody", null, active.map((b) => {
    const suggested = Number(b.currentWeight || 0) * rate / 100;
    const boxInterval = b.feedIntervalDays !== void 0 && b.feedIntervalDays !== "" && Number(b.feedIntervalDays) > 0 ? Number(b.feedIntervalDays) : Number(intervalDays) || 1;
    const perFeedingGrams = suggested * boxInterval;
    const pellets = pelletsFor(perFeedingGrams, pelletWeight);
    return /* @__PURE__ */ React.createElement("tr", { key: b.id }, /* @__PURE__ */ React.createElement("td", { style: { ...tdStyle, fontFamily: MONO, fontWeight: 700 } }, "#", b.boxNumber), /* @__PURE__ */ React.createElement("td", { style: { ...tdStyle, fontFamily: MONO } }, num(b.currentWeight)), /* @__PURE__ */ React.createElement("td", { style: { ...tdStyle, fontFamily: MONO, color: C.water } }, num(suggested, 1)), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, /* @__PURE__ */ React.createElement("input", {
      type: "number",
      min: "1",
      step: "1",
      style: { ...inputStyle, width: 64, padding: "5px 8px" },
      value: b.feedIntervalDays !== void 0 && b.feedIntervalDays !== "" ? b.feedIntervalDays : "",
      placeholder: String(intervalDays || 1),
      onChange: (e) => onUpdateBox({ ...b, feedIntervalDays: e.target.value })
    }), /* @__PURE__ */ React.createElement("span", { style: { fontSize: 11, color: C.muted, marginLeft: 4 } }, "\u0E27\u0E31\u0E19")), /* @__PURE__ */ React.createElement("td", { style: { ...tdStyle, fontFamily: MONO, fontWeight: 700, color: C.seagrass } }, pellets > 0 ? pellets.toLocaleString() : "\u2014", " \u0E40\u0E21\u0E47\u0E14"), /* @__PURE__ */ React.createElement("td", { style: { ...tdStyle, fontFamily: MONO } }, b.feedPerDay || "\u2014"), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, /* @__PURE__ */ React.createElement(Btn, { size: "sm", tone: "ghost", onClick: () => onUpdateBox({ ...b, feedPerDay: suggested.toFixed(1), feedPellets: pellets, feedIntervalDays: boxInterval }) }, "\u0E43\u0E0A\u0E49\u0E04\u0E48\u0E32\u0E19\u0E35\u0E49")));
  }), active.length === 0 && /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("td", { style: tdStyle, colSpan: 7 }, "\u0E22\u0E31\u0E07\u0E44\u0E21\u0E48\u0E21\u0E35\u0E01\u0E25\u0E48\u0E2D\u0E07\u0E17\u0E35\u0E48\u0E01\u0E33\u0E25\u0E31\u0E07\u0E40\u0E25\u0E35\u0E49\u0E22\u0E07\u0E1B\u0E39"))))), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 11.5, color: C.muted, marginTop: 10 } }, "\u0E0A\u0E48\u0E2D\u0E07 \"\u0E43\u0E2B\u0E49\u0E17\u0E38\u0E01\u0E01\u0E35\u0E48\u0E27\u0E31\u0E19\" \u0E1B\u0E25\u0E48\u0E2D\u0E22\u0E27\u0E48\u0E32\u0E07\u0E44\u0E27\u0E49\u0E08\u0E30\u0E43\u0E0A\u0E49\u0E04\u0E48\u0E32\u0E40\u0E23\u0E34\u0E48\u0E21\u0E15\u0E49\u0E19\u0E14\u0E49\u0E32\u0E19\u0E0B\u0E49\u0E32\u0E22 \u2014 \u0E43\u0E2A\u0E48\u0E15\u0E31\u0E27\u0E40\u0E25\u0E02\u0E40\u0E09\u0E1E\u0E32\u0E30\u0E01\u0E25\u0E48\u0E2D\u0E07\u0E17\u0E35\u0E48\u0E15\u0E49\u0E2D\u0E07\u0E01\u0E32\u0E23\u0E04\u0E27\u0E32\u0E21\u0E16\u0E35\u0E48\u0E15\u0E48\u0E32\u0E07\u0E08\u0E32\u0E01\u0E1B\u0E01\u0E15\u0E34 \u0E40\u0E0A\u0E48\u0E19 \u0E1B\u0E39\u0E15\u0E31\u0E27\u0E43\u0E2B\u0E0D\u0E48/\u0E23\u0E2D\u0E25\u0E2D\u0E01\u0E04\u0E23\u0E32\u0E1A\u0E21\u0E31\u0E01\u0E01\u0E34\u0E19\u0E19\u0E49\u0E2D\u0E22\u0E25\u0E07 \u0E40\u0E25\u0E22\u0E43\u0E2B\u0E49\u0E27\u0E31\u0E19\u0E40\u0E27\u0E49\u0E19\u0E27\u0E31\u0E19\u0E44\u0E14\u0E49 \u0E42\u0E14\u0E22\u0E04\u0E2D\u0E25\u0E31\u0E21\u0E19\u0E35\u0E49\u0E08\u0E30\u0E04\u0E33\u0E19\u0E27\u0E13\u0E08\u0E33\u0E19\u0E27\u0E19\u0E40\u0E21\u0E47\u0E14\u0E43\u0E2B\u0E49\u0E40\u0E1E\u0E34\u0E48\u0E21\u0E02\u0E36\u0E49\u0E19\u0E15\u0E32\u0E21\u0E23\u0E2D\u0E1A\u0E01\u0E32\u0E23\u0E43\u0E2B\u0E49\u0E2D\u0E32\u0E2B\u0E32\u0E23\u0E43\u0E2B\u0E49\u0E42\u0E14\u0E22\u0E2D\u0E31\u0E15\u0E42\u0E19\u0E21\u0E31\u0E15\u0E34")));
}
function HistoryTab({ history }) {
  const [filter, setFilter] = useState("all");
  const boxNumbers = useMemo(() => [...new Set(history.map((h) => h.boxNumber))].sort(), [history]);
  const rows = filter === "all" ? history : history.filter((h) => h.boxNumber === filter);
  const sorted = [...rows].sort((a, b) => new Date(b.harvestDate) - new Date(a.harvestDate));
  const totals = rows.reduce(
    (acc, r) => {
      acc.cost += Number(r.costPerCrab || 0);
      acc.sell += Number(r.sellPricePerCrab || 0);
      acc.profit += Number(r.profit || 0);
      acc.count += 1;
      if (r.outcome === "dead") acc.dead += 1;
      return acc;
    },
    { cost: 0, sell: 0, profit: 0, count: 0, dead: 0 }
  );
  return /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 18 } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 14, flexWrap: "wrap" } }, /* @__PURE__ */ React.createElement(StatCard, { label: "\u0E08\u0E33\u0E19\u0E27\u0E19\u0E23\u0E38\u0E48\u0E19\u0E17\u0E35\u0E48\u0E08\u0E31\u0E1A\u0E41\u0E25\u0E49\u0E27", value: totals.count }), /* @__PURE__ */ React.createElement(StatCard, { label: "\u0E15\u0E49\u0E19\u0E17\u0E38\u0E19\u0E23\u0E27\u0E21", value: `${money(totals.cost)} \u0E1A.` }), /* @__PURE__ */ React.createElement(StatCard, { label: "\u0E22\u0E2D\u0E14\u0E02\u0E32\u0E22\u0E23\u0E27\u0E21", value: `${money(totals.sell)} \u0E1A.`, tone: "water" }), /* @__PURE__ */ React.createElement(StatCard, { label: "\u0E01\u0E33\u0E44\u0E23\u0E23\u0E27\u0E21", value: `${money(totals.profit)} \u0E1A.`, tone: totals.profit >= 0 ? "seagrass" : "coral" }), /* @__PURE__ */ React.createElement(StatCard, { label: "\u0E1B\u0E39\u0E15\u0E32\u0E22\u0E2A\u0E30\u0E2A\u0E21", value: totals.dead, tone: totals.dead ? "coral" : "ink" })), /* @__PURE__ */ React.createElement("div", { style: cardStyle }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 } }, /* @__PURE__ */ React.createElement(SectionTitle, null, "\u0E1B\u0E23\u0E30\u0E27\u0E31\u0E15\u0E34\u0E01\u0E32\u0E23\u0E08\u0E31\u0E1A\u0E1B\u0E39\u0E17\u0E31\u0E49\u0E07\u0E2B\u0E21\u0E14"), /* @__PURE__ */ React.createElement("select", { style: { ...inputStyle, width: 180 }, value: filter, onChange: (e) => setFilter(e.target.value) }, /* @__PURE__ */ React.createElement("option", { value: "all" }, "\u0E17\u0E38\u0E01\u0E01\u0E25\u0E48\u0E2D\u0E07"), boxNumbers.map((n) => /* @__PURE__ */ React.createElement("option", { key: n, value: n }, "\u0E01\u0E25\u0E48\u0E2D\u0E07 #", n)))), /* @__PURE__ */ React.createElement("div", { style: { overflowX: "auto" } }, /* @__PURE__ */ React.createElement("table", { style: tableStyle }, /* @__PURE__ */ React.createElement("thead", null, /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E01\u0E25\u0E48\u0E2D\u0E07"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E23\u0E38\u0E48\u0E19\u0E17\u0E35\u0E48"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E40\u0E1E\u0E28"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E27\u0E31\u0E19\u0E25\u0E07\u0E1B\u0E39"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E27\u0E31\u0E19\u0E08\u0E31\u0E1A"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E2A\u0E16\u0E32\u0E19\u0E30"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E08\u0E33\u0E19\u0E27\u0E19\u0E27\u0E31\u0E19"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E19\u0E49\u0E33\u0E2B\u0E19\u0E31\u0E01 (g)"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E44\u0E02\u0E48 %"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E15\u0E49\u0E19\u0E17\u0E38\u0E19/\u0E15\u0E31\u0E27"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E23\u0E32\u0E04\u0E32\u0E02\u0E32\u0E22/\u0E15\u0E31\u0E27"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E01\u0E33\u0E44\u0E23/\u0E15\u0E31\u0E27"))), /* @__PURE__ */ React.createElement("tbody", null, sorted.map((r) => {
    var _a;
    return /* @__PURE__ */ React.createElement("tr", { key: r.id }, /* @__PURE__ */ React.createElement("td", { style: { ...tdStyle, fontFamily: MONO, fontWeight: 700 } }, "#", r.boxNumber), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, r.batchNumber), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, r.sex === "female" ? "\u2640" : "\u2642"), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, fmtDate(r.stockDate)), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, fmtDate(r.harvestDate)), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, r.outcome === "dead" ? /* @__PURE__ */ React.createElement(Pill, { tone: "coral" }, "\u{1F480} \u0E1B\u0E39\u0E15\u0E32\u0E22") : /* @__PURE__ */ React.createElement(Pill, { tone: "seagrass" }, "\u0E08\u0E31\u0E1A\u0E1B\u0E39")), /* @__PURE__ */ React.createElement("td", { style: { ...tdStyle, fontFamily: MONO } }, (_a = r.daysGrown) != null ? _a : "\u2014"), /* @__PURE__ */ React.createElement("td", { style: { ...tdStyle, fontFamily: MONO } }, num(r.weight)), /* @__PURE__ */ React.createElement("td", { style: { ...tdStyle, fontFamily: MONO } }, r.sex === "female" ? r.unmated ? "\u0E01\u0E30\u0E40\u0E17\u0E22" : num(r.eggPercent) : "\u2014"), /* @__PURE__ */ React.createElement("td", { style: { ...tdStyle, fontFamily: MONO } }, money(r.costPerCrab)), /* @__PURE__ */ React.createElement("td", { style: { ...tdStyle, fontFamily: MONO } }, money(r.sellPricePerCrab)), /* @__PURE__ */ React.createElement("td", { style: { ...tdStyle, fontFamily: MONO, color: r.profit >= 0 ? C.seagrass : C.coral, fontWeight: 700 } }, money(r.profit)));
  }), sorted.length === 0 && /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("td", { style: tdStyle, colSpan: 12 }, "\u0E22\u0E31\u0E07\u0E44\u0E21\u0E48\u0E21\u0E35\u0E1B\u0E23\u0E30\u0E27\u0E31\u0E15\u0E34\u0E01\u0E32\u0E23\u0E08\u0E31\u0E1A\u0E1B\u0E39")))))));
}
function StatCard({ label, value, tone = "ink" }) {
  const colors = { ink: C.ink, water: C.water, seagrass: C.seagrass, coral: C.coral, amber: C.amber };
  return /* @__PURE__ */ React.createElement("div", { style: { ...cardStyle, flex: "1 1 160px", minWidth: 160, padding: 16 } }, /* @__PURE__ */ React.createElement("div", { style: { fontSize: 11.5, color: C.muted, fontWeight: 700, marginBottom: 6 } }, label), /* @__PURE__ */ React.createElement("div", { style: { fontFamily: MONO, fontSize: 24, fontWeight: 700, color: colors[tone] || C.ink } }, value));
}
function DataManagementCard({ onExport, onImport, onResetAll, counts }) {
  const fileRef = React.useRef(null);
  return /* @__PURE__ */ React.createElement("div", { style: cardStyle }, /* @__PURE__ */ React.createElement(SectionTitle, { sub: "\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E08\u0E30\u0E16\u0E39\u0E01\u0E40\u0E01\u0E47\u0E1A\u0E44\u0E27\u0E49\u0E43\u0E19\u0E40\u0E04\u0E23\u0E37\u0E48\u0E2D\u0E07/\u0E40\u0E1A\u0E23\u0E32\u0E27\u0E4C\u0E40\u0E0B\u0E2D\u0E23\u0E4C\u0E19\u0E35\u0E49\u0E40\u0E2A\u0E21\u0E2D \u0E08\u0E19\u0E01\u0E27\u0E48\u0E32\u0E04\u0E38\u0E13\u0E08\u0E30\u0E25\u0E1A\u0E40\u0E2D\u0E07 \u2014 \u0E2A\u0E33\u0E23\u0E2D\u0E07\u0E2B\u0E23\u0E37\u0E2D\u0E22\u0E49\u0E32\u0E22\u0E40\u0E04\u0E23\u0E37\u0E48\u0E2D\u0E07\u0E44\u0E14\u0E49\u0E14\u0E49\u0E27\u0E22\u0E44\u0E1F\u0E25\u0E4C\u0E2A\u0E33\u0E23\u0E2D\u0E07\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25" }, "\u0E2A\u0E33\u0E23\u0E2D\u0E07 / \u0E22\u0E49\u0E32\u0E22\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25"), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12.5, color: C.muted, marginBottom: 14 } }, "\u0E01\u0E25\u0E48\u0E2D\u0E07\u0E17\u0E31\u0E49\u0E07\u0E2B\u0E21\u0E14 ", counts.boxes, " \xB7 \u0E1B\u0E23\u0E30\u0E27\u0E31\u0E15\u0E34\u0E01\u0E32\u0E23\u0E08\u0E31\u0E1A ", counts.history, " \u0E23\u0E32\u0E22\u0E01\u0E32\u0E23 \xB7 \u0E1A\u0E31\u0E19\u0E17\u0E36\u0E01\u0E04\u0E48\u0E32\u0E19\u0E49\u0E33 ", counts.water, " \u0E04\u0E23\u0E31\u0E49\u0E07"), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 } }, /* @__PURE__ */ React.createElement(Btn, { tone: "seagrass", onClick: onExport }, "\u0E14\u0E32\u0E27\u0E19\u0E4C\u0E42\u0E2B\u0E25\u0E14\u0E44\u0E1F\u0E25\u0E4C\u0E2A\u0E33\u0E23\u0E2D\u0E07\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25 (.json)"), /* @__PURE__ */ React.createElement(Btn, { tone: "ghost", onClick: () => {
    var _a;
    return (_a = fileRef.current) == null ? void 0 : _a.click();
  } }, "\u0E19\u0E33\u0E40\u0E02\u0E49\u0E32\u0E44\u0E1F\u0E25\u0E4C\u0E2A\u0E33\u0E23\u0E2D\u0E07\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25"), /* @__PURE__ */ React.createElement(
    "input",
    {
      ref: fileRef,
      type: "file",
      accept: "application/json",
      style: { display: "none" },
      onChange: (e) => {
        var _a;
        const file = (_a = e.target.files) == null ? void 0 : _a[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const data = JSON.parse(reader.result);
            onImport(data);
          } catch {
            alert("\u0E44\u0E1F\u0E25\u0E4C\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07 \u0E44\u0E21\u0E48\u0E2A\u0E32\u0E21\u0E32\u0E23\u0E16\u0E19\u0E33\u0E40\u0E02\u0E49\u0E32\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E44\u0E14\u0E49");
          }
        };
        reader.readAsText(file);
        e.target.value = "";
      }
    }
  )), /* @__PURE__ */ React.createElement("div", { style: { borderTop: `1px solid ${C.line}`, paddingTop: 14 } }, /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12.5, fontWeight: 700, color: C.coral, marginBottom: 8 } }, "\u0E25\u0E49\u0E32\u0E07\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E17\u0E31\u0E49\u0E07\u0E2B\u0E21\u0E14"), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12, color: C.muted, marginBottom: 10 } }, "\u0E25\u0E1A\u0E01\u0E25\u0E48\u0E2D\u0E07 \u0E1B\u0E23\u0E30\u0E27\u0E31\u0E15\u0E34\u0E01\u0E32\u0E23\u0E08\u0E31\u0E1A \u0E04\u0E48\u0E32\u0E19\u0E49\u0E33 \u0E41\u0E25\u0E30\u0E01\u0E32\u0E23\u0E15\u0E31\u0E49\u0E07\u0E04\u0E48\u0E32\u0E17\u0E31\u0E49\u0E07\u0E2B\u0E21\u0E14\u0E2D\u0E2D\u0E01\u0E08\u0E32\u0E01\u0E40\u0E04\u0E23\u0E37\u0E48\u0E2D\u0E07\u0E19\u0E35\u0E49 \u0E44\u0E21\u0E48\u0E2A\u0E32\u0E21\u0E32\u0E23\u0E16\u0E01\u0E39\u0E49\u0E04\u0E37\u0E19\u0E44\u0E14\u0E49\u0E40\u0E27\u0E49\u0E19\u0E41\u0E15\u0E48\u0E21\u0E35\u0E44\u0E1F\u0E25\u0E4C\u0E2A\u0E33\u0E23\u0E2D\u0E07\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25"), /* @__PURE__ */ React.createElement(Btn, { tone: "danger", onClick: onResetAll }, "\u0E25\u0E1A\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E17\u0E31\u0E49\u0E07\u0E2B\u0E21\u0E14")));
}
function SaveStatusText({ state }) {
  if (state === "saving") return /* @__PURE__ */ React.createElement("span", { style: { fontSize: 12.5, color: C.muted, marginLeft: 10 } }, "\u0E01\u0E33\u0E25\u0E31\u0E07\u0E1A\u0E31\u0E19\u0E17\u0E36\u0E01\u2026");
  if (state === "saved") return /* @__PURE__ */ React.createElement("span", { style: { fontSize: 12.5, color: C.seagrass, marginLeft: 10, fontWeight: 700 } }, "\u2713 \u0E1A\u0E31\u0E19\u0E17\u0E36\u0E01\u0E41\u0E25\u0E49\u0E27");
  if (state === "error") return /* @__PURE__ */ React.createElement("span", { style: { fontSize: 12.5, color: C.coral, marginLeft: 10, fontWeight: 700 } }, "\u0E1A\u0E31\u0E19\u0E17\u0E36\u0E01\u0E44\u0E21\u0E48\u0E2A\u0E33\u0E40\u0E23\u0E47\u0E08 \u0E25\u0E2D\u0E07\u0E43\u0E2B\u0E21\u0E48");
  return null;
}
function SettingsTab({ settings, onSave, onExport, onImport, onResetAll, counts }) {
  const [s, setS] = useState(settings);
  const [rowsText, setRowsText] = useState((settings.layoutRows || []).join(","));
  const [saveState, setSaveState] = useState("idle");
  const isDirty = JSON.stringify(s) !== JSON.stringify(settings);
  const handleSave = async () => {
    setSaveState("saving");
    let ok = false;
    try {
      ok = await onSave(s);
    } catch (e) {
      ok = false;
    }
    setSaveState(ok === false ? "error" : "saved");
    setTimeout(() => setSaveState("idle"), 2500);
  };
  const setParam = (i, key, val) => {
    const params = [...s.parameters];
    params[i] = { ...params[i], [key]: val };
    setS({ ...s, parameters: params });
  };
  const setPricing = (cat, field, val) => {
    setS({ ...s, pricing: { ...s.pricing, [cat]: { ...s.pricing[cat], [field]: Number(val) } } });
  };
  const setSalesTarget = (cat, val) => {
    setS({ ...s, salesTargets: { ...s.salesTargets, [cat]: Number(val) } });
  };
  return /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 18, maxWidth: 760 } }, /* @__PURE__ */ React.createElement("div", { style: cardStyle }, /* @__PURE__ */ React.createElement(SectionTitle, { sub: "\u0E01\u0E33\u0E2B\u0E19\u0E14\u0E41\u0E16\u0E27\u0E41\u0E25\u0E30\u0E08\u0E33\u0E19\u0E27\u0E19\u0E0A\u0E48\u0E2D\u0E07\u0E15\u0E48\u0E2D\u0E41\u0E16\u0E27 \u0E43\u0E2B\u0E49\u0E15\u0E23\u0E07\u0E01\u0E31\u0E1A\u0E1C\u0E31\u0E07\u0E04\u0E2D\u0E19\u0E42\u0E14\u0E08\u0E23\u0E34\u0E07\u0E43\u0E19\u0E1F\u0E32\u0E23\u0E4C\u0E21 \u0E40\u0E1A\u0E2D\u0E23\u0E4C\u0E01\u0E25\u0E48\u0E2D\u0E07\u0E15\u0E49\u0E2D\u0E07\u0E2D\u0E22\u0E39\u0E48\u0E43\u0E19\u0E23\u0E39\u0E1B\u0E41\u0E1A\u0E1A \u0E15\u0E31\u0E27\u0E2D\u0E31\u0E01\u0E29\u0E23\u0E41\u0E16\u0E27 + \u0E40\u0E25\u0E02\u0E0A\u0E48\u0E2D\u0E07 \u0E40\u0E0A\u0E48\u0E19 A01, B03" }, "\u0E1C\u0E31\u0E07\u0E04\u0E2D\u0E19\u0E42\u0E14"), /* @__PURE__ */ React.createElement("div", { className: "cf-grid-2col", style: { display: "grid", gridTemplateColumns: "2fr 1fr", gap: "0 16px" } }, /* @__PURE__ */ React.createElement(Field, { label: "\u0E41\u0E16\u0E27 (\u0E04\u0E31\u0E48\u0E19\u0E14\u0E49\u0E27\u0E22\u0E08\u0E38\u0E25\u0E20\u0E32\u0E04)", hint: "\u0E40\u0E0A\u0E48\u0E19 A,B,C,D" }, /* @__PURE__ */ React.createElement(
    "input",
    {
      style: inputStyle,
      value: rowsText,
      onChange: (e) => {
        const val = e.target.value;
        setRowsText(val);
        setS({
          ...s,
          layoutRows: val.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean)
        });
      },
      onBlur: () => setRowsText((s.layoutRows || []).join(",")),
      placeholder: "A,B,C,D"
    }
  )), /* @__PURE__ */ React.createElement(Field, { label: "\u0E08\u0E33\u0E19\u0E27\u0E19\u0E0A\u0E48\u0E2D\u0E07\u0E15\u0E48\u0E2D\u0E41\u0E16\u0E27" }, /* @__PURE__ */ React.createElement("input", { type: "number", min: "1", style: inputStyle, value: s.layoutSlotsPerRow, onChange: (e) => setS({ ...s, layoutSlotsPerRow: Number(e.target.value) }) })))), /* @__PURE__ */ React.createElement("div", { style: cardStyle }, /* @__PURE__ */ React.createElement(SectionTitle, null, "\u0E04\u0E48\u0E32\u0E17\u0E31\u0E48\u0E27\u0E44\u0E1B\u0E02\u0E2D\u0E07\u0E23\u0E30\u0E1A\u0E1A"), /* @__PURE__ */ React.createElement("div", { className: "cf-grid-3col", style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0 16px" } }, /* @__PURE__ */ React.createElement(Field, { label: "\u0E1B\u0E23\u0E34\u0E21\u0E32\u0E15\u0E23\u0E19\u0E49\u0E33\u0E43\u0E19\u0E23\u0E30\u0E1A\u0E1A (\u0E25\u0E34\u0E15\u0E23)" }, /* @__PURE__ */ React.createElement("input", { type: "number", style: inputStyle, value: s.tankVolumeLiters, onChange: (e) => setS({ ...s, tankVolumeLiters: Number(e.target.value) }) })), /* @__PURE__ */ React.createElement(Field, { label: "\u0E2D\u0E31\u0E15\u0E23\u0E32\u0E01\u0E32\u0E23\u0E43\u0E2B\u0E49\u0E2D\u0E32\u0E2B\u0E32\u0E23\u0E40\u0E23\u0E34\u0E48\u0E21\u0E15\u0E49\u0E19 (%)" }, /* @__PURE__ */ React.createElement("input", { type: "number", style: inputStyle, value: s.feedRatePercent, onChange: (e) => setS({ ...s, feedRatePercent: Number(e.target.value) }) })), /* @__PURE__ */ React.createElement(Field, { label: "\u0E40\u0E15\u0E37\u0E2D\u0E19\u0E15\u0E23\u0E27\u0E08\u0E25\u0E2D\u0E01\u0E04\u0E23\u0E32\u0E1A\u0E2B\u0E32\u0E01\u0E40\u0E01\u0E34\u0E19 (\u0E27\u0E31\u0E19)" }, /* @__PURE__ */ React.createElement("input", { type: "number", style: inputStyle, value: s.moltReminderDays, onChange: (e) => setS({ ...s, moltReminderDays: Number(e.target.value) }) })), /* @__PURE__ */ React.createElement(Field, { label: "\u0E19\u0E49\u0E33\u0E2B\u0E19\u0E31\u0E01\u0E40\u0E1E\u0E34\u0E48\u0E21\u0E02\u0E31\u0E49\u0E19\u0E15\u0E48\u0E33/\u0E04\u0E23\u0E31\u0E49\u0E07\u0E25\u0E2D\u0E01\u0E04\u0E23\u0E32\u0E1A (%)", hint: "\u0E43\u0E0A\u0E49\u0E40\u0E17\u0E35\u0E22\u0E1A\u0E01\u0E31\u0E1A\u0E19\u0E49\u0E33\u0E2B\u0E19\u0E31\u0E01\u0E01\u0E48\u0E2D\u0E19\u0E25\u0E2D\u0E01\u0E04\u0E23\u0E32\u0E1A\u0E41\u0E15\u0E48\u0E25\u0E30\u0E04\u0E23\u0E31\u0E49\u0E07" }, /* @__PURE__ */ React.createElement("input", { type: "number", step: "0.5", min: "0", style: inputStyle, value: s.moltStandardGrowthPercent, onChange: (e) => setS({ ...s, moltStandardGrowthPercent: Number(e.target.value) }) })))), /* @__PURE__ */ React.createElement("div", { style: cardStyle }, /* @__PURE__ */ React.createElement(SectionTitle, { sub: "\u0E1B\u0E23\u0E31\u0E1A\u0E0A\u0E48\u0E27\u0E07\u0E04\u0E48\u0E32\u0E1B\u0E01\u0E15\u0E34\u0E41\u0E25\u0E30\u0E15\u0E31\u0E27\u0E04\u0E39\u0E13\u0E04\u0E33\u0E19\u0E27\u0E13\u0E42\u0E14\u0E2A\u0E43\u0E2B\u0E49\u0E15\u0E23\u0E07\u0E01\u0E31\u0E1A\u0E1C\u0E25\u0E34\u0E15\u0E20\u0E31\u0E13\u0E11\u0E4C\u0E08\u0E23\u0E34\u0E07\u0E17\u0E35\u0E48\u0E43\u0E0A\u0E49\u0E43\u0E19\u0E1F\u0E32\u0E23\u0E4C\u0E21" }, "\u0E1E\u0E32\u0E23\u0E32\u0E21\u0E34\u0E40\u0E15\u0E2D\u0E23\u0E4C\u0E04\u0E38\u0E13\u0E20\u0E32\u0E1E\u0E19\u0E49\u0E33"), /* @__PURE__ */ React.createElement("div", { style: { overflowX: "auto" } }, /* @__PURE__ */ React.createElement("table", { style: tableStyle }, /* @__PURE__ */ React.createElement("thead", null, /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E1E\u0E32\u0E23\u0E32\u0E21\u0E34\u0E40\u0E15\u0E2D\u0E23\u0E4C"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E2B\u0E19\u0E48\u0E27\u0E22"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E15\u0E48\u0E33\u0E2A\u0E38\u0E14"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E40\u0E1B\u0E49\u0E32\u0E2B\u0E21\u0E32\u0E22"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E2A\u0E39\u0E07\u0E2A\u0E38\u0E14"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E15\u0E31\u0E27\u0E04\u0E39\u0E13\u0E42\u0E14\u0E2A"))), /* @__PURE__ */ React.createElement("tbody", null, s.parameters.map((p, i) => /* @__PURE__ */ React.createElement("tr", { key: p.key }, /* @__PURE__ */ React.createElement("td", { style: tdStyle }, p.label), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, p.unit || "\u2014"), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, /* @__PURE__ */ React.createElement("input", { type: "number", style: { ...inputStyle, width: 70 }, value: p.min, onChange: (e) => setParam(i, "min", Number(e.target.value)) })), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, /* @__PURE__ */ React.createElement("input", { type: "number", style: { ...inputStyle, width: 70 }, value: p.target, onChange: (e) => setParam(i, "target", Number(e.target.value)) })), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, /* @__PURE__ */ React.createElement("input", { type: "number", style: { ...inputStyle, width: 70 }, value: p.max, onChange: (e) => setParam(i, "max", Number(e.target.value)) })), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, p.dosable ? /* @__PURE__ */ React.createElement("input", { type: "number", step: "0.001", style: { ...inputStyle, width: 80 }, value: p.doseFactor, onChange: (e) => setParam(i, "doseFactor", Number(e.target.value)) }) : "\u2014"))))))), /* @__PURE__ */ React.createElement("div", { style: cardStyle }, /* @__PURE__ */ React.createElement(SectionTitle, { sub: "\u0E43\u0E0A\u0E49\u0E14\u0E36\u0E07\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E2A\u0E20\u0E32\u0E1E\u0E2D\u0E32\u0E01\u0E32\u0E28\u0E43\u0E19\u0E41\u0E17\u0E47\u0E1A \u0E19\u0E49\u0E33 / \u0E1B\u0E31\u0E4A\u0E21" }, "\u0E15\u0E33\u0E41\u0E2B\u0E19\u0E48\u0E07\u0E1F\u0E32\u0E23\u0E4C\u0E21"), /* @__PURE__ */ React.createElement("div", { className: "cf-grid-3col", style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0 16px" } }, /* @__PURE__ */ React.createElement(Field, { label: "\u0E0A\u0E37\u0E48\u0E2D\u0E2A\u0E16\u0E32\u0E19\u0E17\u0E35\u0E48/\u0E08\u0E31\u0E07\u0E2B\u0E27\u0E31\u0E14" }, /* @__PURE__ */ React.createElement("input", { style: inputStyle, value: s.farmLocationName || "", onChange: (e) => setS({ ...s, farmLocationName: e.target.value }) })), /* @__PURE__ */ React.createElement(Field, { label: "\u0E25\u0E30\u0E15\u0E34\u0E08\u0E39\u0E14 (lat)" }, /* @__PURE__ */ React.createElement("input", { type: "number", step: "any", style: inputStyle, value: s.farmLat, onChange: (e) => setS({ ...s, farmLat: Number(e.target.value) }) })), /* @__PURE__ */ React.createElement(Field, { label: "\u0E25\u0E2D\u0E07\u0E08\u0E34\u0E08\u0E39\u0E14 (lon)" }, /* @__PURE__ */ React.createElement("input", { type: "number", step: "any", style: inputStyle, value: s.farmLon, onChange: (e) => setS({ ...s, farmLon: Number(e.target.value) }) }))), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 11.5, color: C.muted, marginTop: 8 } }, "\u0E40\u0E01\u0E47\u0E1A\u0E1E\u0E34\u0E01\u0E31\u0E14 lat/lon \u0E44\u0E14\u0E49\u0E08\u0E32\u0E01 Google Maps \u2014 \u0E01\u0E14\u0E04\u0E49\u0E32\u0E07\u0E1A\u0E19\u0E41\u0E1C\u0E19\u0E17\u0E35\u0E48\u0E15\u0E33\u0E41\u0E2B\u0E19\u0E48\u0E07\u0E1F\u0E32\u0E23\u0E4C\u0E21 \u0E15\u0E31\u0E27\u0E40\u0E25\u0E02\u0E17\u0E35\u0E48\u0E02\u0E36\u0E49\u0E19\u0E15\u0E49\u0E19 URL \u0E04\u0E37\u0E2D\u0E1E\u0E34\u0E01\u0E31\u0E14")), /* @__PURE__ */ React.createElement("div", { style: cardStyle }, /* @__PURE__ */ React.createElement(SectionTitle, { sub: "\u0E43\u0E0A\u0E49\u0E04\u0E33\u0E19\u0E27\u0E13\u0E15\u0E49\u0E19\u0E17\u0E38\u0E19\u0E2B\u0E31\u0E27\u0E2D\u0E32\u0E2B\u0E32\u0E23\u0E2A\u0E30\u0E2A\u0E21\u0E41\u0E25\u0E30\u0E01\u0E33\u0E44\u0E23\u0E15\u0E48\u0E2D\u0E19\u0E49\u0E33\u0E2B\u0E19\u0E31\u0E01\u0E1B\u0E31\u0E08\u0E08\u0E38\u0E1A\u0E31\u0E19\u0E43\u0E19\u0E41\u0E14\u0E0A\u0E1A\u0E2D\u0E23\u0E4C\u0E14" }, "\u0E15\u0E49\u0E19\u0E17\u0E38\u0E19\u0E2D\u0E32\u0E2B\u0E32\u0E23 & \u0E23\u0E32\u0E04\u0E32\u0E02\u0E32\u0E22"), /* @__PURE__ */ React.createElement(Field, { label: "\u0E15\u0E49\u0E19\u0E17\u0E38\u0E19\u0E2D\u0E32\u0E2B\u0E32\u0E23\u0E15\u0E48\u0E2D\u0E01\u0E34\u0E42\u0E25\u0E01\u0E23\u0E31\u0E21 (\u0E1A\u0E32\u0E17/\u0E01\u0E01. \u0E2D\u0E32\u0E2B\u0E32\u0E23)" }, /* @__PURE__ */ React.createElement("input", { type: "number", style: { ...inputStyle, maxWidth: 220 }, value: s.feedCostPerKg, onChange: (e) => setS({ ...s, feedCostPerKg: Number(e.target.value) }) })), /* @__PURE__ */ React.createElement("div", { style: { overflowX: "auto", marginTop: 10 } }, /* @__PURE__ */ React.createElement("table", { style: tableStyle }, /* @__PURE__ */ React.createElement("thead", null, /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E1B\u0E23\u0E30\u0E40\u0E20\u0E17\u0E1B\u0E39"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E23\u0E32\u0E04\u0E32\u0E1B\u0E31\u0E08\u0E08\u0E38\u0E1A\u0E31\u0E19 (\u0E1A\u0E32\u0E17/\u0E01\u0E01.)"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E23\u0E32\u0E04\u0E32\u0E04\u0E32\u0E14\u0E01\u0E32\u0E23\u0E13\u0E4C (\u0E1A\u0E32\u0E17/\u0E01\u0E01.)"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E40\u0E1B\u0E49\u0E32\u0E2B\u0E21\u0E32\u0E22\u0E02\u0E32\u0E22 (\u0E01\u0E01.)"))), /* @__PURE__ */ React.createElement("tbody", null, /* @__PURE__ */ React.createElement("tr", { key: "male" }, /* @__PURE__ */ React.createElement("td", { style: tdStyle }, "\u0E15\u0E31\u0E27\u0E1C\u0E39\u0E49"), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, /* @__PURE__ */ React.createElement("input", { type: "number", style: { ...inputStyle, width: 90 }, value: s.pricing.male.current, onChange: (e) => setPricing("male", "current", e.target.value) })), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, /* @__PURE__ */ React.createElement("input", { type: "number", style: { ...inputStyle, width: 90 }, value: s.pricing.male.forecast, onChange: (e) => setPricing("male", "forecast", e.target.value) })), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, /* @__PURE__ */ React.createElement("input", { type: "number", style: { ...inputStyle, width: 90 }, value: s.salesTargets.male, onChange: (e) => setSalesTarget("male", e.target.value) }))), /* @__PURE__ */ React.createElement("tr", { key: "female" }, /* @__PURE__ */ React.createElement("td", { style: tdStyle }, "\u0E15\u0E31\u0E27\u0E40\u0E21\u0E35\u0E22"), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, /* @__PURE__ */ React.createElement("input", { type: "number", style: { ...inputStyle, width: 90 }, value: s.pricing.female.current, onChange: (e) => setPricing("female", "current", e.target.value) })), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, /* @__PURE__ */ React.createElement("input", { type: "number", style: { ...inputStyle, width: 90 }, value: s.pricing.female.forecast, onChange: (e) => setPricing("female", "forecast", e.target.value) })), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, /* @__PURE__ */ React.createElement("input", { type: "number", style: { ...inputStyle, width: 90 }, value: s.salesTargets.female, onChange: (e) => setSalesTarget("female", e.target.value) }))), /* @__PURE__ */ React.createElement("tr", { key: "eggs" }, /* @__PURE__ */ React.createElement("td", { style: tdStyle }, "\u0E1B\u0E39\u0E44\u0E02\u0E48"), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, /* @__PURE__ */ React.createElement("input", { type: "number", style: { ...inputStyle, width: 90 }, value: s.pricing.eggs.current, onChange: (e) => setPricing("eggs", "current", e.target.value) })), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, /* @__PURE__ */ React.createElement("input", { type: "number", style: { ...inputStyle, width: 90 }, value: s.pricing.eggs.forecast, onChange: (e) => setPricing("eggs", "forecast", e.target.value) })), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, /* @__PURE__ */ React.createElement("input", { type: "number", style: { ...inputStyle, width: 90 }, value: s.salesTargets.eggs, onChange: (e) => setSalesTarget("eggs", e.target.value) })))))), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 11.5, color: C.muted, marginTop: 8 } }, "\"\u0E23\u0E32\u0E04\u0E32\u0E1B\u0E31\u0E08\u0E08\u0E38\u0E1A\u0E31\u0E19\" \u0E04\u0E37\u0E2D\u0E23\u0E32\u0E04\u0E32\u0E15\u0E25\u0E32\u0E14\u0E27\u0E31\u0E19\u0E19\u0E35\u0E49 \u0E43\u0E0A\u0E49\u0E04\u0E33\u0E19\u0E27\u0E13\u0E01\u0E33\u0E44\u0E23\u0E08\u0E23\u0E34\u0E07 \u0E2A\u0E48\u0E27\u0E19 \"\u0E23\u0E32\u0E04\u0E32\u0E04\u0E32\u0E14\u0E01\u0E32\u0E23\u0E13\u0E4C\" \u0E43\u0E0A\u0E49\u0E1B\u0E23\u0E30\u0E21\u0E32\u0E13\u0E01\u0E33\u0E44\u0E23\u0E25\u0E48\u0E27\u0E07\u0E2B\u0E19\u0E49\u0E32 \u2014 \u0E1B\u0E23\u0E31\u0E1A\u0E17\u0E31\u0E49\u0E07\u0E2A\u0E2D\u0E07\u0E04\u0E48\u0E32\u0E44\u0E14\u0E49\u0E40\u0E2D\u0E07\u0E15\u0E32\u0E21\u0E23\u0E32\u0E04\u0E32\u0E15\u0E25\u0E32\u0E14\u0E08\u0E23\u0E34\u0E07\u0E17\u0E35\u0E48\u0E40\u0E0A\u0E47\u0E04\u0E21\u0E32 (\u0E40\u0E0A\u0E48\u0E19 \u0E1B\u0E39\u0E44\u0E02\u0E48 1,000 \u0E01\u0E01. \u0E17\u0E35\u0E48 600 \u0E1A\u0E32\u0E17/\u0E01\u0E01.)"), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 11.5, color: C.muted, marginTop: 4 } }, "\u0E15\u0E31\u0E49\u0E07\u0E23\u0E32\u0E04\u0E32\u0E01\u0E25\u0E32\u0E07\u0E44\u0E27\u0E49\u0E17\u0E35\u0E48\u0E19\u0E35\u0E48\u0E01\u0E48\u0E2D\u0E19 \u0E41\u0E25\u0E49\u0E27\u0E44\u0E1B\u0E41\u0E01\u0E49\u0E44\u0E02\u0E23\u0E32\u0E04\u0E32\u0E02\u0E32\u0E22\u0E40\u0E09\u0E1E\u0E32\u0E30\u0E01\u0E25\u0E48\u0E2D\u0E07\u0E44\u0E14\u0E49\u0E43\u0E19\u0E2B\u0E19\u0E49\u0E32\u0E41\u0E01\u0E49\u0E44\u0E02\u0E01\u0E25\u0E48\u0E2D\u0E07\u0E1B\u0E39\u0E41\u0E15\u0E48\u0E25\u0E30\u0E01\u0E25\u0E48\u0E2D\u0E07 (\u0E23\u0E32\u0E04\u0E32\u0E40\u0E09\u0E1E\u0E32\u0E30\u0E01\u0E25\u0E48\u0E2D\u0E07\u0E08\u0E30\u0E2A\u0E33\u0E04\u0E31\u0E0D\u0E01\u0E27\u0E48\u0E32\u0E23\u0E32\u0E04\u0E32\u0E01\u0E25\u0E32\u0E07)")), isDirty && /* @__PURE__ */ React.createElement("div", { style: { background: "rgba(201,138,46,0.12)", border: `1px solid ${C.amber}`, borderRadius: 8, padding: "10px 14px", fontSize: 12.5, color: C.text, fontWeight: 600 } }, "\u26A0\uFE0F \u0E21\u0E35\u0E01\u0E32\u0E23\u0E41\u0E01\u0E49\u0E44\u0E02\u0E17\u0E35\u0E48\u0E22\u0E31\u0E07\u0E44\u0E21\u0E48\u0E44\u0E14\u0E49\u0E1A\u0E31\u0E19\u0E17\u0E36\u0E01 \u2014 \u0E15\u0E49\u0E2D\u0E07\u0E01\u0E14\u0E1B\u0E38\u0E48\u0E21 \"\u0E1A\u0E31\u0E19\u0E17\u0E36\u0E01\u0E01\u0E32\u0E23\u0E15\u0E31\u0E49\u0E07\u0E04\u0E48\u0E32\" \u0E14\u0E49\u0E32\u0E19\u0E25\u0E48\u0E32\u0E07\u0E01\u0E48\u0E2D\u0E19 \u0E44\u0E21\u0E48\u0E07\u0E31\u0E49\u0E19\u0E15\u0E31\u0E27\u0E40\u0E25\u0E02\u0E08\u0E30\u0E44\u0E21\u0E48\u0E2D\u0E31\u0E1B\u0E40\u0E14\u0E15\u0E17\u0E35\u0E48\u0E41\u0E14\u0E0A\u0E1A\u0E2D\u0E23\u0E4C\u0E14"), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center" } }, /* @__PURE__ */ React.createElement(Btn, { tone: "seagrass", disabled: saveState === "saving", onClick: handleSave }, saveState === "saving" ? "\u0E01\u0E33\u0E25\u0E31\u0E07\u0E1A\u0E31\u0E19\u0E17\u0E36\u0E01\u2026" : "\u0E1A\u0E31\u0E19\u0E17\u0E36\u0E01\u0E01\u0E32\u0E23\u0E15\u0E31\u0E49\u0E07\u0E04\u0E48\u0E32"), /* @__PURE__ */ React.createElement(SaveStatusText, { state: saveState })), /* @__PURE__ */ React.createElement(DataManagementCard, { onExport, onImport, onResetAll, counts }), /* @__PURE__ */ React.createElement(ChangePasswordCard, null));
}
const TABS = [
  { id: "dashboard", label: "\u0E41\u0E14\u0E0A\u0E1A\u0E2D\u0E23\u0E4C\u0E14" },
  { id: "boxes", label: "\u0E01\u0E25\u0E48\u0E2D\u0E07 / \u0E04\u0E2D\u0E19\u0E42\u0E14" },
  { id: "alerts", label: "\u0E41\u0E08\u0E49\u0E07\u0E40\u0E15\u0E37\u0E2D\u0E19" },
  { id: "water", label: "\u0E19\u0E49\u0E33 / \u0E1B\u0E31\u0E4A\u0E21" },
  { id: "feed", label: "\u0E04\u0E33\u0E19\u0E27\u0E13\u0E2D\u0E32\u0E2B\u0E32\u0E23" },
  { id: "history", label: "\u0E1B\u0E23\u0E30\u0E27\u0E31\u0E15\u0E34 / \u0E23\u0E32\u0E22\u0E07\u0E32\u0E19" },
  { id: "settings", label: "\u0E15\u0E31\u0E49\u0E07\u0E04\u0E48\u0E32" }
];
function LoginGate({ onSuccess }) {
  const [username, setUsername] = useState("");
  const [pw, setPw] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const submit = async () => {
    setChecking(true);
    setError("");
    const real = await storeGetCredentials();
    setChecking(false);
    if (username === real.username && pw === real.password) {
      onSuccess();
    } else {
      setError("\u0E22\u0E39\u0E2A\u0E40\u0E19\u0E21/\u0E23\u0E2B\u0E31\u0E2A\u0E1C\u0E48\u0E32\u0E19\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07 \u0E25\u0E2D\u0E07\u0E2D\u0E35\u0E01\u0E04\u0E23\u0E31\u0E49\u0E07");
    }
  };
  return /* @__PURE__ */ React.createElement("div", { style: { fontFamily: BODY, background: C.paper, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 } }, /* @__PURE__ */ React.createElement("link", { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" }), /* @__PURE__ */ React.createElement(
    "div",
    {
      style: {
        background: C.card,
        borderRadius: 16,
        padding: 32,
        width: 360,
        maxWidth: "94vw",
        boxShadow: "0 20px 60px rgba(11,35,51,0.25)",
        textAlign: "center"
      }
    },
    /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "center", marginBottom: 14 } }, /* @__PURE__ */ React.createElement(LogoMark, { size: 56 })),
    /* @__PURE__ */ React.createElement("div", { style: { fontFamily: DISPLAY, fontWeight: 700, fontSize: 19, color: C.ink, marginBottom: 4 } }, "\u0E2D\u0E31\u0E19\u0E14\u0E32\u0E21\u0E31\u0E19\u0E1F\u0E32\u0E23\u0E4C\u0E21"),
    /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12.5, color: C.muted, marginBottom: 20 } }, "\u0E01\u0E23\u0E2D\u0E01\u0E22\u0E39\u0E2A\u0E40\u0E19\u0E21\u0E41\u0E25\u0E30\u0E23\u0E2B\u0E31\u0E2A\u0E1C\u0E48\u0E32\u0E19\u0E40\u0E1E\u0E37\u0E48\u0E2D\u0E40\u0E02\u0E49\u0E32\u0E43\u0E0A\u0E49\u0E07\u0E32\u0E19"),
    /* @__PURE__ */ React.createElement("input", {
      type: "text",
      autoFocus: true,
      style: { ...inputStyle, textAlign: "center", fontSize: 16, marginBottom: 10 },
      value: username,
      placeholder: "Username",
      autoCapitalize: "off",
      autoCorrect: "off",
      onChange: (e) => setUsername(e.target.value),
      onKeyDown: (e) => {
        if (e.key === "Enter") submit();
      }
    }),
    /* @__PURE__ */ React.createElement("input", {
      type: "password",
      style: { ...inputStyle, textAlign: "center", fontSize: 16, marginBottom: 10 },
      value: pw,
      placeholder: "Password",
      onChange: (e) => setPw(e.target.value),
      onKeyDown: (e) => {
        if (e.key === "Enter") submit();
      }
    }),
    error && /* @__PURE__ */ React.createElement("div", { style: { color: C.coral, fontSize: 12.5, marginBottom: 10 } }, error),
    /* @__PURE__ */ React.createElement(Btn, { tone: "coral", disabled: checking || !pw || !username, onClick: submit }, checking ? "\u0E01\u0E33\u0E25\u0E31\u0E07\u0E15\u0E23\u0E27\u0E08\u0E2A\u0E2D\u0E1A\u2026" : "\u0E40\u0E02\u0E49\u0E32\u0E43\u0E0A\u0E49\u0E07\u0E32\u0E19")
  ));
}
function ChangePasswordCard() {
  const [currentPw, setCurrentPw] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [next, setNext] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    storeGetCredentials().then((c) => setNewUsername(c.username));
  }, []);
  const submit = async () => {
    if (!newUsername.trim()) {
      alert("\u0E01\u0E23\u0E38\u0E13\u0E32\u0E01\u0E23\u0E2D\u0E01 Username");
      return;
    }
    if (next && next.length < 4) {
      alert("Password \u0E43\u0E2B\u0E21\u0E48\u0E15\u0E49\u0E2D\u0E07\u0E22\u0E32\u0E27\u0E2D\u0E22\u0E48\u0E32\u0E07\u0E19\u0E49\u0E2D\u0E22 4 \u0E15\u0E31\u0E27\u0E2D\u0E31\u0E01\u0E29\u0E23");
      return;
    }
    if (next && next !== confirmPw) {
      alert("Password \u0E43\u0E2B\u0E21\u0E48\u0E17\u0E31\u0E49\u0E07\u0E2A\u0E2D\u0E07\u0E0A\u0E48\u0E2D\u0E07\u0E44\u0E21\u0E48\u0E15\u0E23\u0E07\u0E01\u0E31\u0E19");
      return;
    }
    setBusy(true);
    const real = await storeGetCredentials();
    if (currentPw !== real.password) {
      setBusy(false);
      alert("Password \u0E1B\u0E31\u0E08\u0E08\u0E38\u0E1A\u0E31\u0E19\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07");
      return;
    }
    await storeSetCredentials(newUsername.trim(), next ? next : real.password);
    setBusy(false);
    setCurrentPw("");
    setNext("");
    setConfirmPw("");
    alert("\u0E1A\u0E31\u0E19\u0E17\u0E36\u0E01\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E40\u0E02\u0E49\u0E32\u0E43\u0E0A\u0E49\u0E07\u0E32\u0E19\u0E2A\u0E33\u0E40\u0E23\u0E47\u0E08");
  };
  return /* @__PURE__ */ React.createElement("div", { style: cardStyle }, /* @__PURE__ */ React.createElement(SectionTitle, { sub: "\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E19\u0E35\u0E49\u0E43\u0E0A\u0E49\u0E23\u0E48\u0E27\u0E21\u0E01\u0E31\u0E19\u0E17\u0E31\u0E49\u0E07\u0E17\u0E35\u0E21 \u0E40\u0E1B\u0E25\u0E35\u0E48\u0E22\u0E19\u0E41\u0E25\u0E49\u0E27\u0E17\u0E38\u0E01\u0E04\u0E19\u0E15\u0E49\u0E2D\u0E07\u0E43\u0E0A\u0E49\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E43\u0E2B\u0E21\u0E48" }, "\u0E40\u0E1B\u0E25\u0E35\u0E48\u0E22\u0E19 Username / Password"), /* @__PURE__ */ React.createElement(Field, { label: "Password \u0E1B\u0E31\u0E08\u0E08\u0E38\u0E1A\u0E31\u0E19 (\u0E22\u0E37\u0E19\u0E22\u0E31\u0E19\u0E15\u0E31\u0E27\u0E15\u0E19)" }, /* @__PURE__ */ React.createElement("input", { type: "password", style: inputStyle, value: currentPw, onChange: (e) => setCurrentPw(e.target.value) })), /* @__PURE__ */ React.createElement(Field, { label: "Username \u0E43\u0E2B\u0E21\u0E48" }, /* @__PURE__ */ React.createElement("input", { type: "text", style: inputStyle, value: newUsername, autoCapitalize: "off", autoCorrect: "off", onChange: (e) => setNewUsername(e.target.value) })), /* @__PURE__ */ React.createElement(Field, { label: "Password \u0E43\u0E2B\u0E21\u0E48 (\u0E40\u0E27\u0E49\u0E19\u0E27\u0E48\u0E32\u0E07\u0E16\u0E49\u0E32\u0E44\u0E21\u0E48\u0E15\u0E49\u0E2D\u0E07\u0E01\u0E32\u0E23\u0E40\u0E1B\u0E25\u0E35\u0E48\u0E22\u0E19)" }, /* @__PURE__ */ React.createElement("input", { type: "password", style: inputStyle, value: next, onChange: (e) => setNext(e.target.value) })), /* @__PURE__ */ React.createElement(Field, { label: "\u0E22\u0E37\u0E19\u0E22\u0E31\u0E19 Password \u0E43\u0E2B\u0E21\u0E48" }, /* @__PURE__ */ React.createElement("input", { type: "password", style: inputStyle, value: confirmPw, onChange: (e) => setConfirmPw(e.target.value) })), /* @__PURE__ */ React.createElement(Btn, { tone: "seagrass", disabled: busy, onClick: submit }, busy ? "\u0E01\u0E33\u0E25\u0E31\u0E07\u0E1A\u0E31\u0E19\u0E17\u0E36\u0E01\u2026" : "\u0E1A\u0E31\u0E19\u0E17\u0E36\u0E01"));
}
function AlertsTab({ boxAlerts, overviewAlerts, boxes, onOpenBox }) {
  const findBox = (boxNumber) => boxes.find((b) => b.boxNumber === boxNumber);
  return /* @__PURE__ */ React.createElement("div", { className: "cf-grid-2col", style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, alignItems: "start" } }, /* @__PURE__ */ React.createElement("div", { style: cardStyle }, /* @__PURE__ */ React.createElement(SectionTitle, { sub: "\u0E41\u0E08\u0E49\u0E07\u0E40\u0E15\u0E37\u0E2D\u0E19\u0E17\u0E35\u0E48\u0E1C\u0E39\u0E01\u0E01\u0E31\u0E1A\u0E01\u0E25\u0E48\u0E2D\u0E07\u0E43\u0E14\u0E01\u0E25\u0E48\u0E2D\u0E07\u0E2B\u0E19\u0E36\u0E48\u0E07\u0E42\u0E14\u0E22\u0E15\u0E23\u0E07" }, "\u0E41\u0E08\u0E49\u0E07\u0E40\u0E15\u0E37\u0E2D\u0E19\u0E23\u0E32\u0E22\u0E01\u0E25\u0E48\u0E2D\u0E07"), boxAlerts.length === 0 && /* @__PURE__ */ React.createElement("div", { style: { fontSize: 13, color: C.muted } }, "\u0E44\u0E21\u0E48\u0E21\u0E35\u0E01\u0E25\u0E48\u0E2D\u0E07\u0E44\u0E2B\u0E19\u0E15\u0E49\u0E2D\u0E07\u0E14\u0E39\u0E41\u0E25\u0E40\u0E1B\u0E47\u0E19\u0E1E\u0E34\u0E40\u0E28\u0E29\u0E15\u0E2D\u0E19\u0E19\u0E35\u0E49 \u{1F389}"), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8 } }, boxAlerts.map((a) => /* @__PURE__ */ React.createElement("div", { key: a.id, onClick: () => {
    const b = findBox(a.boxNumber);
    if (b) onOpenBox(b);
  }, style: { display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", background: a.tone === "danger" ? "rgba(226,96,58,0.08)" : "rgba(201,138,46,0.08)", borderRadius: 8, cursor: "pointer" } }, /* @__PURE__ */ React.createElement(Pill, { tone: a.tone }, a.tone === "danger" ? "\u0E1E\u0E23\u0E49\u0E2D\u0E21\u0E08\u0E31\u0E1A" : "\u0E40\u0E15\u0E37\u0E2D\u0E19"), /* @__PURE__ */ React.createElement("span", { style: { fontSize: 13 } }, a.text)))), /* @__PURE__ */ React.createElement("div", { style: cardStyle }, /* @__PURE__ */ React.createElement(SectionTitle, { sub: "\u0E41\u0E08\u0E49\u0E07\u0E40\u0E15\u0E37\u0E2D\u0E19\u0E23\u0E30\u0E14\u0E31\u0E1A\u0E1F\u0E32\u0E23\u0E4C\u0E21 \u0E40\u0E0A\u0E48\u0E19 \u0E04\u0E38\u0E13\u0E20\u0E32\u0E1E\u0E19\u0E49\u0E33\u0E23\u0E27\u0E21" }, "\u0E41\u0E08\u0E49\u0E07\u0E40\u0E15\u0E37\u0E2D\u0E19\u0E20\u0E32\u0E1E\u0E23\u0E27\u0E21"), overviewAlerts.length === 0 && /* @__PURE__ */ React.createElement("div", { style: { fontSize: 13, color: C.muted } }, "\u0E44\u0E21\u0E48\u0E21\u0E35\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23 \u{1F389}"), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8 } }, overviewAlerts.map((a) => /* @__PURE__ */ React.createElement("div", { key: a.id, style: { display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", background: a.tone === "danger" ? "rgba(226,96,58,0.08)" : "rgba(201,138,46,0.08)", borderRadius: 8 } }, /* @__PURE__ */ React.createElement(Pill, { tone: a.tone }, a.tone === "danger" ? "\u0E1E\u0E23\u0E49\u0E2D\u0E21\u0E08\u0E31\u0E1A" : "\u0E40\u0E15\u0E37\u0E2D\u0E19"), /* @__PURE__ */ React.createElement("span", { style: { fontSize: 13 } }, a.text)))))));
}
function WeatherCard({ settings }) {
  const [weather, setWeather] = useState(null);
  const [status, setStatus] = useState("loading");
  useEffect(() => {
    let cancelled = false;
    const lat = settings.farmLat != null ? settings.farmLat : 9.4744;
    const lon = settings.farmLon != null ? settings.farmLon : 98.3785;
    fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&timezone=auto`).then((r) => r.json()).then((data) => {
      if (cancelled) return;
      if (data && data.current) {
        setWeather(data.current);
        setStatus("ok");
      } else {
        setStatus("error");
      }
    }).catch(() => {
      if (!cancelled) setStatus("error");
    });
    return () => {
      cancelled = true;
    };
  }, [settings.farmLat, settings.farmLon]);
  const codeToText = (code) => {
    if (code === 0) return "\u0E17\u0E49\u0E2D\u0E07\u0E1F\u0E49\u0E32\u0E41\u0E08\u0E48\u0E21\u0E43\u0E2A";
    if (code <= 3) return "\u0E21\u0E35\u0E40\u0E21\u0E10\u0E1A\u0E32\u0E07\u0E2A\u0E48\u0E27\u0E19";
    if (code <= 48) return "\u0E2B\u0E21\u0E2D\u0E01/\u0E2B\u0E21\u0E2D\u0E01\u0E04\u0E27\u0E31\u0E19";
    if (code <= 67) return "\u0E1D\u0E19\u0E15\u0E01";
    if (code <= 82) return "\u0E1D\u0E19\u0E1F\u0E49\u0E32\u0E04\u0E30\u0E19\u0E2D\u0E07";
    if (code <= 99) return "\u0E1E\u0E32\u0E22\u0E38\u0E1D\u0E19\u0E2F\u0E1F\u0E49\u0E32\u0E04\u0E30\u0E19\u0E2D\u0E07";
    return "\u2014";
  };
  const assessTemp = (t) => {
    if (t == null) return null;
    if (t < 24) return { text: "\u0E2D\u0E32\u0E01\u0E32\u0E28\u0E40\u0E22\u0E47\u0E19\u0E01\u0E27\u0E48\u0E32\u0E1B\u0E01\u0E15\u0E34 \u0E2D\u0E32\u0E08\u0E17\u0E33\u0E43\u0E2B\u0E49\u0E1B\u0E39\u0E01\u0E34\u0E19\u0E2D\u0E32\u0E2B\u0E32\u0E23\u0E19\u0E49\u0E2D\u0E22\u0E25\u0E07 \u0E04\u0E27\u0E23\u0E40\u0E1D\u0E49\u0E32\u0E23\u0E30\u0E27\u0E31\u0E07", tone: "warn" };
    if (t > 33) return { text: "\u0E2D\u0E32\u0E01\u0E32\u0E28\u0E23\u0E49\u0E2D\u0E19\u0E01\u0E27\u0E48\u0E32\u0E1B\u0E01\u0E15\u0E34 \u0E40\u0E2A\u0E35\u0E48\u0E22\u0E07\u0E2D\u0E2D\u0E01\u0E0B\u0E34\u0E40\u0E08\u0E19\u0E43\u0E19\u0E19\u0E49\u0E33\u0E15\u0E48\u0E33 \u0E04\u0E27\u0E23\u0E40\u0E1E\u0E34\u0E48\u0E21\u0E2D\u0E32\u0E01\u0E32\u0E28/\u0E19\u0E49\u0E33", tone: "danger" };
    return { text: "\u0E2D\u0E38\u0E13\u0E2B\u0E20\u0E39\u0E21\u0E34\u0E2D\u0E22\u0E39\u0E48\u0E43\u0E19\u0E40\u0E01\u0E13\u0E11\u0E4C\u0E17\u0E35\u0E48\u0E40\u0E2B\u0E21\u0E32\u0E30\u0E01\u0E31\u0E1A\u0E1B\u0E39\u0E14\u0E33", tone: "good" };
  };
  const assessment = weather ? assessTemp(weather.temperature_2m) : null;
  return /* @__PURE__ */ React.createElement("div", { style: cardStyle }, /* @__PURE__ */ React.createElement(SectionTitle, { sub: settings.farmLocationName || "\u0E15\u0E33\u0E41\u0E2B\u0E19\u0E48\u0E07\u0E1F\u0E32\u0E23\u0E4C\u0E21 (\u0E15\u0E31\u0E49\u0E07\u0E04\u0E48\u0E32\u0E44\u0E14\u0E49\u0E43\u0E19\u0E2B\u0E19\u0E49\u0E32\u0E15\u0E31\u0E49\u0E07\u0E04\u0E48\u0E32)" }, "\u0E2A\u0E20\u0E32\u0E1E\u0E2D\u0E32\u0E01\u0E32\u0E28"), status === "loading" && /* @__PURE__ */ React.createElement("div", { style: { fontSize: 13, color: C.muted } }, "\u0E01\u0E33\u0E25\u0E31\u0E07\u0E14\u0E36\u0E07\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u2026"), status === "error" && /* @__PURE__ */ React.createElement("div", { style: { fontSize: 13, color: C.muted } }, "\u0E14\u0E36\u0E07\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E2D\u0E32\u0E01\u0E32\u0E28\u0E44\u0E21\u0E48\u0E44\u0E14\u0E49 \u0E25\u0E2D\u0E07\u0E43\u0E2B\u0E21\u0E48\u0E2D\u0E35\u0E01\u0E04\u0E23\u0E31\u0E49\u0E07"), status === "ok" && weather && /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "baseline", gap: 10, marginBottom: 8 } }, /* @__PURE__ */ React.createElement("div", { style: { fontFamily: DISPLAY, fontWeight: 700, fontSize: 34, color: C.ink } }, num(weather.temperature_2m, 1), "\xB0C"), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 13, color: C.muted } }, codeToText(weather.weather_code))), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12.5, color: C.muted, marginBottom: 10 } }, "\u0E04\u0E27\u0E32\u0E21\u0E0A\u0E37\u0E49\u0E19 ", num(weather.relative_humidity_2m), "% \xB7 \u0E25\u0E21 ", num(weather.wind_speed_10m, 1), " \u0E01\u0E21./\u0E0A\u0E21."), assessment && /* @__PURE__ */ React.createElement(Pill, { tone: assessment.tone }, assessment.text)));
}
function nextPumpLetter(lines) {
  const used = new Set(lines.map((l) => String(l.id).toUpperCase()));
  for (let i = 0; i < 26; i++) {
    const letter = String.fromCharCode(65 + i);
    if (!used.has(letter)) return letter;
  }
  return uid().toUpperCase();
}
function PumpScheduleCard({ settings, onUpdateSettings }) {
  const lines = settings.pumpLines && settings.pumpLines.length ? settings.pumpLines : DEFAULT_PUMP_LINES;
  const updateLine = (id, patch) => {
    const next = lines.map((l) => l.id === id ? { ...l, ...patch } : l);
    onUpdateSettings({ ...settings, pumpLines: next });
  };
  const addLine = () => {
    const letter = nextPumpLetter(lines);
    const newLine = { id: letter, label: `\u0E2A\u0E32\u0E22 ${letter}`, enabled: false, onTime: "06:00", offTime: "06:30" };
    onUpdateSettings({ ...settings, pumpLines: [...lines, newLine] });
  };
  const removeLine = async (id) => {
    if (lines.length <= 1) {
      alert("\u0E15\u0E49\u0E2D\u0E07\u0E21\u0E35\u0E2D\u0E22\u0E48\u0E32\u0E07\u0E19\u0E49\u0E2D\u0E22 1 \u0E2A\u0E32\u0E22");
      return;
    }
    if (!await askConfirm("\u0E25\u0E1A\u0E2A\u0E32\u0E22\u0E1B\u0E31\u0E4A\u0E21\u0E19\u0E35\u0E49?")) return;
    onUpdateSettings({ ...settings, pumpLines: lines.filter((l) => l.id !== id) });
  };
  return /* @__PURE__ */ React.createElement(
    "div",
    { style: cardStyle },
    /* @__PURE__ */ React.createElement(
      SectionTitle,
      { sub: "\u0E15\u0E31\u0E49\u0E07\u0E40\u0E27\u0E25\u0E32\u0E40\u0E1B\u0E34\u0E14/\u0E1B\u0E34\u0E14\u0E1B\u0E31\u0E4A\u0E21\u0E41\u0E15\u0E48\u0E25\u0E30\u0E2A\u0E32\u0E22 \u2014 \u0E41\u0E1C\u0E19\u0E19\u0E35\u0E49\u0E43\u0E0A\u0E49\u0E27\u0E32\u0E07\u0E41\u0E1C\u0E19/\u0E1A\u0E31\u0E19\u0E17\u0E36\u0E01\u0E44\u0E27\u0E49\u0E40\u0E17\u0E48\u0E32\u0E19\u0E31\u0E49\u0E19 \u0E44\u0E21\u0E48\u0E44\u0E14\u0E49\u0E2A\u0E31\u0E48\u0E07\u0E07\u0E32\u0E19\u0E1B\u0E31\u0E4A\u0E21\u0E08\u0E23\u0E34\u0E07" },
      "\u0E15\u0E32\u0E23\u0E32\u0E07\u0E1B\u0E31\u0E4A\u0E21\u0E19\u0E49\u0E33 (\u0E2A\u0E32\u0E22 A / B / C)"
    ),
    /* @__PURE__ */ React.createElement(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: 12 } },
      lines.map((l) => /* @__PURE__ */ React.createElement(
        "div",
        { key: l.id, style: { display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: l.enabled ? "rgba(46,125,88,0.06)" : "#F5F7F4", borderRadius: 8, flexWrap: "wrap" } },
        /* @__PURE__ */ React.createElement("input", { type: "checkbox", checked: !!l.enabled, onChange: (e) => updateLine(l.id, { enabled: e.target.checked }) }),
        /* @__PURE__ */ React.createElement("input", { style: { ...inputStyle, width: 100, padding: "5px 8px", fontWeight: 700, fontSize: 13 }, value: l.label, onChange: (e) => updateLine(l.id, { label: e.target.value }) }),
        /* @__PURE__ */ React.createElement(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: C.muted } },
          "\u0E40\u0E1B\u0E34\u0E14 ",
          /* @__PURE__ */ React.createElement("input", { type: "time", style: { ...inputStyle, width: 110, padding: "5px 8px" }, value: l.onTime, onChange: (e) => updateLine(l.id, { onTime: e.target.value }) }),
          "\u0E1B\u0E34\u0E14 ",
          /* @__PURE__ */ React.createElement("input", { type: "time", style: { ...inputStyle, width: 110, padding: "5px 8px" }, value: l.offTime, onChange: (e) => updateLine(l.id, { offTime: e.target.value }) })
        ),
        /* @__PURE__ */ React.createElement(Btn, { size: "sm", tone: "danger", onClick: () => removeLine(l.id) }, "\u0E25\u0E1A")
      )),
      /* @__PURE__ */ React.createElement(Btn, { size: "sm", tone: "ghost", onClick: addLine }, "+ \u0E40\u0E1E\u0E34\u0E48\u0E21\u0E2A\u0E32\u0E22\u0E1B\u0E31\u0E4A\u0E21")
    ),
    /* @__PURE__ */ React.createElement(
      "div",
      { style: { fontSize: 11.5, color: C.muted, marginTop: 10 } },
      "\u26A0\uFE0F \u0E41\u0E1C\u0E19\u0E19\u0E35\u0E49\u0E43\u0E0A\u0E49\u0E27\u0E32\u0E07\u0E15\u0E32\u0E23\u0E32\u0E07\u0E40\u0E27\u0E25\u0E32\u0E40\u0E17\u0E48\u0E32\u0E19\u0E31\u0E49\u0E19 \u0E41\u0E2D\u0E1B\u0E1E\u0E4C\u0E19\u0E35\u0E49\u0E44\u0E21\u0E48\u0E2A\u0E32\u0E21\u0E32\u0E23\u0E16\u0E2A\u0E31\u0E48\u0E07\u0E40\u0E1B\u0E34\u0E14/\u0E1B\u0E34\u0E14\u0E1B\u0E31\u0E4A\u0E21\u0E08\u0E23\u0E34\u0E07\u0E44\u0E14\u0E49 \u0E15\u0E49\u0E2D\u0E07\u0E43\u0E0A\u0E49\u0E23\u0E48\u0E27\u0E21\u0E01\u0E31\u0E1A\u0E15\u0E31\u0E27\u0E15\u0E31\u0E49\u0E07\u0E40\u0E27\u0E25\u0E32 (timer) \u0E2B\u0E23\u0E37\u0E2D\u0E2A\u0E27\u0E34\u0E15\u0E0A\u0E4C IoT \u0E17\u0E35\u0E48\u0E1A\u0E49\u0E32\u0E19\u0E41\u0E22\u0E01\u0E15\u0E48\u0E32\u0E07\u0E2B\u0E32\u0E01"
    )
  );
}
function App() {
  var _a;
  const [loaded, setLoaded] = useState(false);
  const [authOk, setAuthOk] = useState(false);
  const [boxes, setBoxes] = useState([]);
  const [history, setHistory] = useState([]);
  const [waterLogs, setWaterLogs] = useState([]);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [tab, setTab] = useState("dashboard");
  const [openBox, setOpenBox] = useState(null);
  const [showNewBox, setShowNewBox] = useState(false);
  const [harvestTarget, setHarvestTarget] = useState(null);
  const [deathTarget, setDeathTarget] = useState(null);
  const [showAlerts, setShowAlerts] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [printPicker, setPrintPicker] = useState(null);
  const [printJob, setPrintJob] = useState(null);
  const [boxFilter, setBoxFilter] = useState({ status: "all", sex: "all", q: "" });
  const [boxViewMode, setBoxViewMode] = useState("plan");
  const [listPage, setListPage] = useState(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => typeof window !== "undefined" && window.innerWidth <= 860);
  const LIST_PAGE_SIZE = 60;
  const [confirmDialog, setConfirmDialog] = useState(null);
  ConfirmBus.request = (message, resolve) => setConfirmDialog({ message, resolve });
  useEffect(() => () => {
    ConfirmBus.request = null;
  }, []);
  useEffect(() => {
    setListPage(0);
  }, [boxFilter, boxViewMode]);
  const [prefillBoxNumber, setPrefillBoxNumber] = useState("");
  useEffect(() => {
    let cancelled = false;
    const timeoutId = setTimeout(() => {
      if (!cancelled) {
        console.error("crabfarm: load timed out, showing app with empty/partial data");
        setLoaded(true);
      }
    }, 12e3);
    (async () => {
      try {
        const [b, h, w, s] = await Promise.all([
          storeGetCollection(COL_BOXES),
          storeGetCollection(COL_HISTORY),
          storeGetCollection(COL_WATER),
          storeGetSettings()
        ]);
        if (cancelled) return;
        setBoxes(b);
        setHistory(h);
        setWaterLogs(w);
        setSettings(mergeSettings(s));
      } catch (e) {
        console.error("crabfarm: load failed", e);
      } finally {
        if (!cancelled) {
          clearTimeout(timeoutId);
          setLoaded(true);
        }
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, []);
  const [lastSynced, setLastSynced] = useState(null);
  const editingOpenRef = useRef(false);
  useEffect(() => {
    editingOpenRef.current = !!(openBox || showNewBox || harvestTarget || deathTarget);
  }, [openBox, showNewBox, harvestTarget, deathTarget]);
  // Auto-refresh: every few seconds, quietly pull the latest data from the
  // shared backend so every device stays in sync without anyone having to
  // close/reopen the app or hit refresh. Skipped while a form is open so it
  // never overwrites something someone is actively typing.
  useEffect(() => {
    if (!loaded) return;
    let stopped = false;
    const poll = async () => {
      if (editingOpenRef.current) return;
      try {
        const [b, h, w, s] = await Promise.all([
          storeGetCollection(COL_BOXES),
          storeGetCollection(COL_HISTORY),
          storeGetCollection(COL_WATER),
          storeGetSettings()
        ]);
        if (stopped) return;
        setBoxes((prev) => JSON.stringify(prev) === JSON.stringify(b) ? prev : b);
        setHistory((prev) => JSON.stringify(prev) === JSON.stringify(h) ? prev : h);
        setWaterLogs((prev) => JSON.stringify(prev) === JSON.stringify(w) ? prev : w);
        setSettings((prev) => {
          const next = mergeSettings(s);
          return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
        });
        setLastSynced(/* @__PURE__ */ new Date());
      } catch (e) {
        console.error("crabfarm: background sync failed", e);
      }
    };
    const interval = setInterval(poll, 15e3);
    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }, [loaded]);
  const persistBoxes = useCallback((next, changedIds) => {
    setBoxes(next);
    storeSetCollection(COL_BOXES, next, changedIds);
  }, []);
  const persistHistory = useCallback((next, changedIds) => {
    setHistory(next);
    storeSetCollection(COL_HISTORY, next, changedIds);
  }, []);
  const persistWater = useCallback((next, changedIds) => {
    setWaterLogs(next);
    storeSetCollection(COL_WATER, next, changedIds);
  }, []);
  const persistSettings = useCallback(async (next) => {
    setSettings(next);
    return await storeSetSettings(next);
  }, []);
  const exportData = useCallback(() => {
    const payload = {
      app: "andaman-farm",
      exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
      boxes,
      history,
      waterLogs,
      settings
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `andaman-farm-backup-${todayStr()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [boxes, history, waterLogs, settings]);
  const importData = useCallback(async (data) => {
    if (!data || typeof data !== "object") {
      alert("\u0E44\u0E1F\u0E25\u0E4C\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07");
      return;
    }
    const ok = await askConfirm("\u0E01\u0E32\u0E23\u0E19\u0E33\u0E40\u0E02\u0E49\u0E32\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E08\u0E30\u0E41\u0E17\u0E19\u0E17\u0E35\u0E48\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E17\u0E31\u0E49\u0E07\u0E2B\u0E21\u0E14\u0E43\u0E19\u0E40\u0E04\u0E23\u0E37\u0E48\u0E2D\u0E07\u0E19\u0E35\u0E49 \u0E15\u0E49\u0E2D\u0E07\u0E01\u0E32\u0E23\u0E14\u0E33\u0E40\u0E19\u0E34\u0E19\u0E01\u0E32\u0E23\u0E15\u0E48\u0E2D\u0E2B\u0E23\u0E37\u0E2D\u0E44\u0E21\u0E48?");
    if (!ok) return;
    const nb = Array.isArray(data.boxes) ? data.boxes : [];
    const nh = Array.isArray(data.history) ? data.history : [];
    const nw = Array.isArray(data.waterLogs) ? data.waterLogs : [];
    const ns = data.settings && data.settings.parameters ? data.settings : DEFAULT_SETTINGS;
    persistBoxes(nb);
    persistHistory(nh);
    persistWater(nw);
    persistSettings(ns);
    alert("\u0E19\u0E33\u0E40\u0E02\u0E49\u0E32\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E2A\u0E33\u0E40\u0E23\u0E47\u0E08");
  }, [persistBoxes, persistHistory, persistWater, persistSettings]);
  const resetAll = useCallback(async () => {
    const ok = await askConfirm("\u0E22\u0E37\u0E19\u0E22\u0E31\u0E19\u0E25\u0E1A\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E17\u0E31\u0E49\u0E07\u0E2B\u0E21\u0E14\u0E43\u0E19\u0E40\u0E04\u0E23\u0E37\u0E48\u0E2D\u0E07\u0E19\u0E35\u0E49? \u0E01\u0E32\u0E23\u0E01\u0E23\u0E30\u0E17\u0E33\u0E19\u0E35\u0E49\u0E44\u0E21\u0E48\u0E2A\u0E32\u0E21\u0E32\u0E23\u0E16\u0E22\u0E49\u0E2D\u0E19\u0E01\u0E25\u0E31\u0E1A\u0E44\u0E14\u0E49");
    if (!ok) return;
    const ok2 = await askConfirm("\u0E22\u0E37\u0E19\u0E22\u0E31\u0E19\u0E2D\u0E35\u0E01\u0E04\u0E23\u0E31\u0E49\u0E07 \u2014 \u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E01\u0E25\u0E48\u0E2D\u0E07 \u0E1B\u0E23\u0E30\u0E27\u0E31\u0E15\u0E34 \u0E41\u0E25\u0E30\u0E04\u0E48\u0E32\u0E19\u0E49\u0E33\u0E17\u0E31\u0E49\u0E07\u0E2B\u0E21\u0E14\u0E08\u0E30\u0E16\u0E39\u0E01\u0E25\u0E1A\u0E16\u0E32\u0E27\u0E23");
    if (!ok2) return;
    storeClearCollection(COL_BOXES);
    storeClearCollection(COL_HISTORY);
    storeClearCollection(COL_WATER);
    storeClearSettings();
    setBoxes([]);
    setHistory([]);
    setWaterLogs([]);
    setSettings(DEFAULT_SETTINGS);
  }, []);
  const saveBox = (box) => {
    const exists = boxes.some((b) => b.id === box.id);
    const next = exists ? boxes.map((b) => b.id === box.id ? box : b) : [...boxes, box];
    persistBoxes(next, [box.id]);
    setOpenBox(null);
    setShowNewBox(false);
    setPrefillBoxNumber("");
  };
  const deleteBox = (id) => {
    persistBoxes(boxes.filter((b) => b.id !== id), [id]);
    setOpenBox(null);
  };
  const confirmHarvest = (data) => {
    const box = harvestTarget;
    const record = {
      id: uid(),
      boxNumber: box.boxNumber,
      batchNumber: box.batchNumber,
      sex: box.sex,
      stockDate: box.stockDate,
      harvestDate: data.harvestDate,
      daysGrown: daysBetween(box.stockDate, data.harvestDate),
      weight: data.weight,
      eggPercent: data.eggPercent,
      costPerCrab: box.costPerCrab,
      sellPricePerCrab: data.sellPricePerCrab,
      unmated: !!box.unmated,
      outcome: "harvest",
      profit: data.sellPricePerCrab !== "" && box.costPerCrab !== "" ? Number(data.sellPricePerCrab) - Number(box.costPerCrab) : null
    };
    persistHistory([...history, record], [record.id]);
    persistBoxes(boxes.map((b) => b.id === box.id ? { ...b, status: "empty", harvestDate: data.harvestDate } : b), [box.id]);
    setHarvestTarget(null);
  };
  const confirmDeath = (data) => {
    const box = deathTarget;
    const fin = computeBoxFinance(box, settings);
    const lossAmount = fin.costBasis;
    const record = {
      id: uid(),
      boxNumber: box.boxNumber,
      batchNumber: box.batchNumber,
      sex: box.sex,
      stockDate: box.stockDate,
      harvestDate: data.deathDate,
      daysGrown: daysBetween(box.stockDate, data.deathDate),
      weight: data.weight || box.currentWeight,
      eggPercent: box.eggPercent,
      costPerCrab: box.costPerCrab,
      sellPricePerCrab: 0,
      unmated: !!box.unmated,
      outcome: "dead",
      deathNote: data.note || "",
      profit: -lossAmount
    };
    persistHistory([...history, record], [record.id]);
    persistBoxes(boxes.map((b) => b.id === box.id ? { ...b, status: "empty", harvestDate: data.deathDate } : b), [box.id]);
    setDeathTarget(null);
  };
  const nextBatchFor = (boxNumber) => {
    const past = history.filter((h) => h.boxNumber === boxNumber).length;
    const current = boxes.find((b) => b.boxNumber === boxNumber);
    return Math.max(past + 1, ((current == null ? void 0 : current.batchNumber) || 0) + 1);
  };
  const updateBox = (box) => persistBoxes(boxes.map((b) => b.id === box.id ? box : b), [box.id]);
  const alerts = useMemo(() => {
    const list = [];
    boxes.forEach((b) => {
      if (b.status !== "active") return;
      if (b.sex === "female" && Number(b.eggPercent) >= 100) {
        list.push({ id: `egg-${b.id}`, tone: "danger", scope: "box", boxNumber: b.boxNumber, text: `\u0E01\u0E25\u0E48\u0E2D\u0E07 #${b.boxNumber} \u2014 \u0E44\u0E02\u0E48\u0E40\u0E15\u0E47\u0E21 100% \u0E1E\u0E23\u0E49\u0E2D\u0E21\u0E08\u0E31\u0E1A` });
      }
      if (b.targetWeight && Number(b.currentWeight) >= Number(b.targetWeight)) {
        list.push({ id: `wt-${b.id}`, tone: "danger", scope: "box", boxNumber: b.boxNumber, text: `\u0E01\u0E25\u0E48\u0E2D\u0E07 #${b.boxNumber} \u2014 \u0E19\u0E49\u0E33\u0E2B\u0E19\u0E31\u0E01\u0E16\u0E36\u0E07\u0E40\u0E1B\u0E49\u0E32\u0E2B\u0E21\u0E32\u0E22\u0E41\u0E25\u0E49\u0E27 (${num(b.currentWeight)}g)` });
      }
      const lastMoltEntry = b.moltHistory && b.moltHistory.length ? b.moltHistory[b.moltHistory.length - 1] : null;
      const lastMolt = lastMoltEntry ? moltEntryDate(lastMoltEntry) : null;
      if (lastMolt) {
        const d = daysBetween(lastMolt, todayStr());
        if (d >= settings.moltReminderDays) {
          list.push({ id: `molt-${b.id}`, tone: "warn", scope: "box", boxNumber: b.boxNumber, text: `\u0E01\u0E25\u0E48\u0E2D\u0E07 #${b.boxNumber} \u2014 \u0E44\u0E21\u0E48\u0E21\u0E35\u0E01\u0E32\u0E23\u0E25\u0E2D\u0E01\u0E04\u0E23\u0E32\u0E1A\u0E21\u0E32 ${d} \u0E27\u0E31\u0E19 \u0E04\u0E27\u0E23\u0E15\u0E23\u0E27\u0E08\u0E2A\u0E2D\u0E1A` });
        }
      }
    });
    if (waterLogs.length) {
      const latest = waterLogs[waterLogs.length - 1];
      settings.parameters.forEach((p) => {
        const v = latest.readings[p.key];
        if (v !== void 0 && (v < p.min || v > p.max)) {
          list.push({ id: `water-${p.key}`, tone: "warn", scope: "overview", text: `\u0E19\u0E49\u0E33: ${p.label} \u0E2D\u0E22\u0E39\u0E48\u0E19\u0E2D\u0E01\u0E0A\u0E48\u0E27\u0E07\u0E1B\u0E01\u0E15\u0E34 (${v}${p.unit}, \u0E1B\u0E01\u0E15\u0E34 ${p.min}\u2013${p.max}${p.unit})` });
        }
      });
    }
    return list;
  }, [boxes, waterLogs, settings]);
  const boxAlerts = alerts.filter((a) => a.scope === "box");
  const overviewAlerts = alerts.filter((a) => a.scope !== "box");
  const activeBoxes = boxes.filter((b) => b.status === "active");
  const emptyBoxes = boxes.filter((b) => b.status === "empty");
  const filteredBoxes = boxes.filter((b) => {
    if (boxFilter.status !== "all" && b.status !== boxFilter.status) return false;
    if (boxFilter.sex !== "all" && b.status === "active" && b.sex !== boxFilter.sex) return false;
    if (boxFilter.q && !String(b.boxNumber).toLowerCase().includes(boxFilter.q.toLowerCase())) return false;
    return true;
  });
  const listTotalPages = Math.max(1, Math.ceil(filteredBoxes.length / LIST_PAGE_SIZE));
  const listPageClamped = Math.min(listPage, listTotalPages - 1);
  const pagedBoxes = filteredBoxes.slice(listPageClamped * LIST_PAGE_SIZE, (listPageClamped + 1) * LIST_PAGE_SIZE);
  const totalBiomass = activeBoxes.reduce((s, b) => s + Number(b.currentWeight || 0), 0);
  const totalProfit = history.reduce((s, r) => s + Number(r.profit || 0), 0);
  const financeByCategory = useMemo(() => {
    const base = () => ({ weightKg: 0, feedCostAccrued: 0, feedPerDayTotal: 0, costBasis: 0, revenueNow: 0, revenueForecast: 0, profitNow: 0, profitForecast: 0, count: 0 });
    const acc = { male: base(), female: base(), eggs: base() };
    activeBoxes.forEach((b) => {
      const fin = computeBoxFinance(b, settings);
      const bucket = acc[fin.category];
      bucket.weightKg += fin.weightKg;
      bucket.feedCostAccrued += fin.feedCostAccrued;
      bucket.feedPerDayTotal += fin.feedPerDayGrams;
      bucket.costBasis += fin.costBasis;
      bucket.revenueNow += fin.revenueNow;
      bucket.revenueForecast += fin.revenueForecast;
      bucket.profitNow += fin.profitNow;
      bucket.profitForecast += fin.profitForecast;
      bucket.count += 1;
    });
    return acc;
  }, [activeBoxes, settings]);
  const financeTotal = useMemo(() => {
    return Object.values(financeByCategory).reduce((s, b) => ({
      weightKg: s.weightKg + b.weightKg,
      feedCostAccrued: s.feedCostAccrued + b.feedCostAccrued,
      costBasis: s.costBasis + b.costBasis,
      revenueNow: s.revenueNow + b.revenueNow,
      revenueForecast: s.revenueForecast + b.revenueForecast,
      profitNow: s.profitNow + b.profitNow,
      profitForecast: s.profitForecast + b.profitForecast
    }), { weightKg: 0, feedCostAccrued: 0, costBasis: 0, revenueNow: 0, revenueForecast: 0, profitNow: 0, profitForecast: 0 });
  }, [financeByCategory]);
  const estProfitPerKgNow = financeTotal.weightKg > 0 ? financeTotal.profitNow / financeTotal.weightKg : 0;
  const handleLogout = async () => {
    const ok = await askConfirm("\u0E15\u0E49\u0E2D\u0E07\u0E01\u0E32\u0E23\u0E2D\u0E2D\u0E01\u0E08\u0E32\u0E01\u0E23\u0E30\u0E1A\u0E1A\u0E43\u0E0A\u0E48\u0E2B\u0E23\u0E37\u0E2D\u0E44\u0E21\u0E48?");
    if (!ok) return;
    setAuthOk(false);
    setShowAlerts(false);
    setOpenBox(null);
    setShowNewBox(false);
    setHarvestTarget(null);
  };
  if (!authOk) {
    return /* @__PURE__ */ React.createElement(LoginGate, { onSuccess: () => setAuthOk(true) });
  }
  if (!loaded) {
    return /* @__PURE__ */ React.createElement("div", { style: { padding: 40, fontFamily: BODY, color: C.muted } }, "\u0E01\u0E33\u0E25\u0E31\u0E07\u0E42\u0E2B\u0E25\u0E14\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E1F\u0E32\u0E23\u0E4C\u0E21\u2026");
  }
  return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { id: "crabfarm-app-shell", className: "cf-shell", style: { fontFamily: BODY, background: C.paper, minHeight: "100vh", color: C.text, display: "flex" } }, /* @__PURE__ */ React.createElement("link", { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600;700&display=swap" }), /* @__PURE__ */ React.createElement("style", null, `
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 8px; height: 8px; }
        ::-webkit-scrollbar-thumb { background: #C7D2C6; border-radius: 6px; }
        button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid ${C.water}; outline-offset: 1px; }
      
        html, body, #root { max-width: 100%; overflow-x: hidden; }
        img, svg { max-width: 100%; }
        table { max-width: 100%; }
        .cf-sidebar-backdrop { display: none; }
        .cf-topbar-actions { flex-wrap: wrap; justify-content: flex-end; row-gap: 8px; }
        .cf-field-flex { flex: 1 1 160px; }
        .cf-boxnumber-field, .cf-date-field { color: ${C.coral} !important; font-weight: 700; }
        .cf-boxnumber-field:focus, .cf-date-field:focus { color: ${C.text} !important; font-weight: 500; }
        .cf-boxnumber-field:disabled { color: ${C.coral} !important; -webkit-text-fill-color: ${C.coral}; opacity: 1; }
        input[type="date"] { min-width: 0; }
        .cf-grid-2col > *, .cf-grid-3col > *, .cf-grid-molt > *, .cf-grid-water > *, .cf-grid-feed > * { min-width: 0; }

        @media (max-width: 860px) {
          .cf-sidebar {
            position: fixed !important;
            top: 0; left: 0;
            height: 100vh !important;
            min-height: 100vh !important;
            z-index: 260;
            box-shadow: 8px 0 30px rgba(11,35,51,0.35);
            animation: cf-slide-in 0.16s ease-out;
          }
          .cf-sidebar-backdrop {
            display: block;
            position: fixed;
            inset: 0;
            background: rgba(11,35,51,0.45);
            z-index: 250;
          }
          .cf-topbar { padding: 10px 14px !important; flex-wrap: wrap; row-gap: 8px; }
          .cf-topbar-actions { gap: 8px !important; width: 100%; justify-content: space-between; }
          .cf-sync-text { display: none !important; }
          .cf-content { padding: 14px !important; }
          .cf-grid-water, .cf-grid-feed, .cf-grid-2col, .cf-grid-3col, .cf-grid-molt {
            grid-template-columns: 1fr !important;
          }
          .cf-toolbar-row { justify-content: flex-start !important; }
          .cf-field-flex { width: 100% !important; flex: 1 1 100% !important; }
          table { font-size: 11.5px !important; }
          .cf-modal-overlay { padding: 0 !important; align-items: flex-end !important; }
          .cf-modal-box {
            width: 100% !important;
            max-width: 100% !important;
            max-height: 92vh !important;
            border-radius: 16px 16px 0 0 !important;
            padding: 16px !important;
          }
        }

        @keyframes cf-slide-in {
          from { transform: translateX(-14px); opacity: 0.5; }
          to { transform: translateX(0); opacity: 1; }
        }

        @media (min-width: 861px) and (max-width: 1100px) {
          .cf-grid-water { grid-template-columns: 280px 1fr !important; }
          .cf-grid-feed { grid-template-columns: 240px 1fr !important; }
        }
      `), !sidebarCollapsed && /* @__PURE__ */ React.createElement("div", { className: "cf-sidebar-backdrop", onClick: () => setSidebarCollapsed(true) }), !sidebarCollapsed && /* @__PURE__ */ React.createElement("div", { className: "cf-sidebar", style: { width: 210, background: C.ink, color: "#fff", flexShrink: 0, padding: "22px 14px", display: "flex", flexDirection: "column", minHeight: "100vh" } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 10, marginBottom: 26 } }, /* @__PURE__ */ React.createElement(LogoMark, { size: 48 }), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { fontFamily: DISPLAY, fontWeight: 700, fontSize: 16.5, letterSpacing: 0.2, lineHeight: 1.2 } }, "\u0E2D\u0E31\u0E19\u0E14\u0E32\u0E21\u0E31\u0E19\u0E1F\u0E32\u0E23\u0E4C\u0E21"), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 10.5, color: "rgba(255,255,255,0.55)" } }, "\u0E1F\u0E32\u0E23\u0E4C\u0E21\u0E1B\u0E39\u0E14\u0E33\u0E04\u0E2D\u0E19\u0E42\u0E14 \xB7 \u0E19\u0E49\u0E33\u0E17\u0E30\u0E40\u0E25\u0E40\u0E17\u0E35\u0E22\u0E21"))), TABS.map((t) => /* @__PURE__ */ React.createElement(
    "button",
    {
      key: t.id,
      onClick: () => { setTab(t.id); if (typeof window !== "undefined" && window.innerWidth <= 860) setSidebarCollapsed(true); },
      style: {
        textAlign: "left",
        padding: "10px 12px",
        borderRadius: 8,
        border: "none",
        background: tab === t.id ? "rgba(255,255,255,0.12)" : "transparent",
        color: tab === t.id ? "#fff" : "rgba(255,255,255,0.7)",
        fontWeight: tab === t.id ? 700 : 500,
        fontSize: 13.5,
        cursor: "pointer",
        marginBottom: 4,
        fontFamily: BODY
      }
    },
    t.label
  )), /* @__PURE__ */ React.createElement("div", { style: { flex: 1 } }), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 10.5, color: "rgba(255,255,255,0.4)", lineHeight: 1.6 } }, activeBoxes.length, " \u0E01\u0E25\u0E48\u0E2D\u0E07\u0E01\u0E33\u0E25\u0E31\u0E07\u0E40\u0E25\u0E35\u0E49\u0E22\u0E07 \xB7 ", emptyBoxes.length, " \u0E01\u0E25\u0E48\u0E2D\u0E07\u0E27\u0E48\u0E32\u0E07")), /* @__PURE__ */ React.createElement("div", { style: { flex: 1, minWidth: 0 } }, /* @__PURE__ */ React.createElement("div", { className: "cf-topbar", style: { position: "sticky", top: 0, zIndex: 20, background: "rgba(238,242,237,0.92)", backdropFilter: "blur(6px)", padding: "16px 26px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: `1px solid ${C.line}` } }, /* @__PURE__ */ React.createElement("div", { className: "cf-topbar-left", style: { display: "flex", alignItems: "center", gap: 12, minWidth: 0 } }, /* @__PURE__ */ React.createElement("button", { onClick: () => setSidebarCollapsed((v) => !v), title: sidebarCollapsed ? "\u0E41\u0E2A\u0E14\u0E07\u0E41\u0E16\u0E1A\u0E40\u0E21\u0E19\u0E39" : "\u0E0B\u0E48\u0E2D\u0E19\u0E41\u0E16\u0E1A\u0E40\u0E21\u0E19\u0E39", style: { background: C.card, border: `1px solid ${C.line}`, borderRadius: 8, width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: C.ink, flexShrink: 0 } }, /* @__PURE__ */ React.createElement(IconMenu, null)), /* @__PURE__ */ React.createElement("div", { style: { fontFamily: DISPLAY, fontWeight: 700, fontSize: 21, color: C.ink } }, (_a = TABS.find((t) => t.id === tab)) == null ? void 0 : _a.label)), /* @__PURE__ */ React.createElement("div", { className: "cf-topbar-actions", style: { display: "flex", alignItems: "center", gap: 14 } }, /* @__PURE__ */ React.createElement("div", { className: "cf-sync-text", style: { fontSize: 12.5, color: C.muted, fontFamily: MONO, display: "flex", alignItems: "center", gap: 6 } }, /* @__PURE__ */ React.createElement("span", { style: { width: 7, height: 7, borderRadius: "50%", background: C.seagrass, display: "inline-block" }, title: "\u0E0B\u0E34\u0E07\u0E01\u0E4C\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E2D\u0E31\u0E15\u0E42\u0E19\u0E21\u0E31\u0E15\u0E34\u0E17\u0E38\u0E01 15 \u0E27\u0E34\u0E19\u0E32\u0E17\u0E35" }), lastSynced ? `\u0E2D\u0E31\u0E1B\u0E40\u0E14\u0E15\u0E25\u0E48\u0E32\u0E2A\u0E38\u0E14 ${lastSynced.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : (/* @__PURE__ */ new Date()).toLocaleDateString("th-TH", { weekday: "short", day: "numeric", month: "short", year: "numeric" })), /* @__PURE__ */ React.createElement("button", { onClick: () => { setTab("boxes"); setBoxViewMode("list"); setTimeout(() => { const el = document.getElementById("crabfarm-search-input"); if (el) el.focus(); }, 50); }, title: "\u0E04\u0E49\u0E19\u0E2B\u0E32\u0E01\u0E25\u0E48\u0E2D\u0E07\u0E1B\u0E39", style: { background: C.card, border: `1px solid ${C.line}`, borderRadius: 8, width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: C.ink } }, /* @__PURE__ */ React.createElement(IconSearch, null)), /* @__PURE__ */ React.createElement("button", { onClick: () => setShowScanner(true), title: "สแกน QR เพื่อเช็คกล่อง", style: { background: C.card, border: `1px solid ${C.line}`, borderRadius: 8, width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: C.ink } }, /* @__PURE__ */ React.createElement(IconQr, null)), /* @__PURE__ */ React.createElement("div", { style: { position: "relative" } }, /* @__PURE__ */ React.createElement("button", { onClick: () => setShowAlerts((v) => !v), style: { position: "relative", background: C.card, border: `1px solid ${C.line}`, borderRadius: 8, width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: C.ink } }, /* @__PURE__ */ React.createElement(IconBell, null), alerts.length > 0 && /* @__PURE__ */ React.createElement("span", { style: { position: "absolute", top: -4, right: -4, background: C.coral, color: "#fff", fontSize: 10, fontWeight: 700, borderRadius: 10, minWidth: 16, height: 16, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 3px" } }, alerts.length)), showAlerts && /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", right: 0, top: 42, width: 320, background: C.card, border: `1px solid ${C.line}`, borderRadius: 10, boxShadow: "0 12px 30px rgba(11,35,51,0.18)", padding: 10, zIndex: 30, maxHeight: 340, overflowY: "auto" } }, alerts.length === 0 && /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12.5, color: C.muted, padding: 8 } }, "\u0E44\u0E21\u0E48\u0E21\u0E35\u0E01\u0E32\u0E23\u0E41\u0E08\u0E49\u0E07\u0E40\u0E15\u0E37\u0E2D\u0E19"), alerts.map((a) => /* @__PURE__ */ React.createElement("div", { key: a.id, style: { padding: "8px 6px", borderBottom: `1px solid ${C.line}`, fontSize: 12.5 } }, /* @__PURE__ */ React.createElement(Pill, { tone: a.tone }, a.tone === "danger" ? "\u0E1E\u0E23\u0E49\u0E2D\u0E21\u0E08\u0E31\u0E1A" : "\u0E41\u0E08\u0E49\u0E07\u0E40\u0E15\u0E37\u0E2D\u0E19"), /* @__PURE__ */ React.createElement("div", { style: { marginTop: 5 } }, a.text))))), /* @__PURE__ */ React.createElement(Btn, { tone: "ghost", size: "sm", onClick: handleLogout }, /* @__PURE__ */ React.createElement("span", { style: { display: "flex", alignItems: "center", gap: 6 } }, /* @__PURE__ */ React.createElement(IconLogout, { size: 14 }), "\u0E2D\u0E2D\u0E01\u0E08\u0E32\u0E01\u0E23\u0E30\u0E1A\u0E1A")), tab === "boxes" && /* @__PURE__ */ React.createElement(Btn, { tone: "coral", size: "sm", onClick: () => setShowNewBox(true) }, "+ \u0E40\u0E1E\u0E34\u0E48\u0E21\u0E01\u0E25\u0E48\u0E2D\u0E07"))), /* @__PURE__ */ React.createElement("div", { className: "cf-content", style: { padding: 26 } }, tab === "dashboard" && /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 20 } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 14, flexWrap: "wrap" } }, /* @__PURE__ */ React.createElement(StatCard, { label: "\u0E01\u0E25\u0E48\u0E2D\u0E07\u0E17\u0E31\u0E49\u0E07\u0E2B\u0E21\u0E14", value: boxes.length }), /* @__PURE__ */ React.createElement(StatCard, { label: "\u0E01\u0E33\u0E25\u0E31\u0E07\u0E40\u0E25\u0E35\u0E49\u0E22\u0E07\u0E2D\u0E22\u0E39\u0E48", value: activeBoxes.length, tone: "seagrass" }), /* @__PURE__ */ React.createElement(StatCard, { label: "\u0E01\u0E25\u0E48\u0E2D\u0E07\u0E27\u0E48\u0E32\u0E07", value: emptyBoxes.length }), /* @__PURE__ */ React.createElement(StatCard, { label: "\u0E19\u0E49\u0E33\u0E2B\u0E19\u0E31\u0E01\u0E23\u0E27\u0E21 (biomass)", value: `${num(totalBiomass)} g`, tone: "water" }), /* @__PURE__ */ React.createElement(StatCard, { label: "\u0E01\u0E33\u0E44\u0E23\u0E2A\u0E30\u0E2A\u0E21\u0E17\u0E31\u0E49\u0E07\u0E2B\u0E21\u0E14", value: `${money(totalProfit)} \u0E1A.`, tone: totalProfit >= 0 ? "seagrass" : "coral" }), /* @__PURE__ */ React.createElement(StatCard, { label: "\u0E15\u0E49\u0E19\u0E17\u0E38\u0E19\u0E2D\u0E32\u0E2B\u0E32\u0E23\u0E2A\u0E30\u0E2A\u0E21 (\u0E1B\u0E23\u0E30\u0E40\u0E21\u0E34\u0E19)", value: `${money(financeTotal.feedCostAccrued)} \u0E1A.`, tone: "water" }), /* @__PURE__ */ React.createElement(StatCard, { label: "\u0E01\u0E33\u0E44\u0E23\u0E1B\u0E23\u0E30\u0E40\u0E21\u0E34\u0E19\u0E23\u0E27\u0E21 (\u0E1B\u0E31\u0E08\u0E08\u0E38\u0E1A\u0E31\u0E19)", value: `${money(financeTotal.profitNow)} \u0E1A.`, tone: financeTotal.profitNow >= 0 ? "seagrass" : "coral" }), /* @__PURE__ */ React.createElement(StatCard, { label: "\u0E01\u0E33\u0E44\u0E23\u0E1B\u0E23\u0E30\u0E40\u0E21\u0E34\u0E19/\u0E01\u0E01. (\u0E1B\u0E31\u0E08\u0E08\u0E38\u0E1A\u0E31\u0E19)", value: `${money(estProfitPerKgNow)} \u0E1A.`, tone: estProfitPerKgNow >= 0 ? "seagrass" : "coral" }), /* @__PURE__ */ React.createElement(StatCard, { label: "\u0E41\u0E08\u0E49\u0E07\u0E40\u0E15\u0E37\u0E2D\u0E19\u0E17\u0E35\u0E48\u0E15\u0E49\u0E2D\u0E07\u0E14\u0E33\u0E40\u0E19\u0E34\u0E19\u0E01\u0E32\u0E23", value: alerts.length, tone: alerts.length ? "coral" : "ink" })), /* @__PURE__ */ React.createElement("div", { style: cardStyle }, /* @__PURE__ */ React.createElement(SectionTitle, null, "\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23\u0E41\u0E08\u0E49\u0E07\u0E40\u0E15\u0E37\u0E2D\u0E19"), alerts.length === 0 && /* @__PURE__ */ React.createElement("div", { style: { fontSize: 13, color: C.muted } }, "\u0E44\u0E21\u0E48\u0E21\u0E35\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23\u0E17\u0E35\u0E48\u0E15\u0E49\u0E2D\u0E07\u0E14\u0E33\u0E40\u0E19\u0E34\u0E19\u0E01\u0E32\u0E23\u0E15\u0E2D\u0E19\u0E19\u0E35\u0E49 \u{1F389}"), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8 } }, alerts.map((a) => /* @__PURE__ */ React.createElement("div", { key: a.id, style: { display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", background: a.tone === "danger" ? "rgba(226,96,58,0.08)" : "rgba(201,138,46,0.08)", borderRadius: 8 } }, /* @__PURE__ */ React.createElement(Pill, { tone: a.tone }, a.tone === "danger" ? "\u0E1E\u0E23\u0E49\u0E2D\u0E21\u0E08\u0E31\u0E1A" : "\u0E40\u0E15\u0E37\u0E2D\u0E19"), /* @__PURE__ */ React.createElement("span", { style: { fontSize: 13 } }, a.text))))), /* @__PURE__ */ React.createElement("div", { style: cardStyle }, /* @__PURE__ */ React.createElement(SectionTitle, { sub: "\u0E2D\u0E49\u0E32\u0E07\u0E2D\u0E34\u0E07\u0E23\u0E32\u0E04\u0E32\u0E1B\u0E31\u0E08\u0E08\u0E38\u0E1A\u0E31\u0E19\u0E41\u0E25\u0E30\u0E23\u0E32\u0E04\u0E32\u0E04\u0E32\u0E14\u0E01\u0E32\u0E23\u0E13\u0E4C\u0E08\u0E32\u0E01\u0E2B\u0E19\u0E49\u0E32\u0E15\u0E31\u0E49\u0E07\u0E04\u0E48\u0E32 \u0E40\u0E17\u0E35\u0E22\u0E1A\u0E01\u0E31\u0E1A\u0E40\u0E1B\u0E49\u0E32\u0E2B\u0E21\u0E32\u0E22\u0E19\u0E49\u0E33\u0E2B\u0E19\u0E31\u0E01\u0E02\u0E32\u0E22\u0E17\u0E35\u0E48\u0E15\u0E31\u0E49\u0E07\u0E44\u0E27\u0E49 \u0E1E\u0E23\u0E49\u0E2D\u0E21\u0E41\u0E2A\u0E14\u0E07\u0E1B\u0E23\u0E34\u0E21\u0E32\u0E13\u0E2D\u0E32\u0E2B\u0E32\u0E23\u0E17\u0E35\u0E48\u0E15\u0E49\u0E2D\u0E07\u0E43\u0E0A\u0E49\u0E15\u0E48\u0E2D\u0E27\u0E31\u0E19\u0E02\u0E2D\u0E07\u0E1B\u0E39\u0E41\u0E15\u0E48\u0E25\u0E30\u0E1B\u0E23\u0E30\u0E40\u0E20\u0E17" }, "\u0E15\u0E49\u0E19\u0E17\u0E38\u0E19\u0E2D\u0E32\u0E2B\u0E32\u0E23 & \u0E01\u0E33\u0E44\u0E23\u0E1B\u0E23\u0E30\u0E40\u0E21\u0E34\u0E19 (\u0E08\u0E32\u0E01\u0E1B\u0E39\u0E17\u0E35\u0E48\u0E40\u0E25\u0E35\u0E49\u0E22\u0E07\u0E2D\u0E22\u0E39\u0E48)"), /* @__PURE__ */ React.createElement("div", { style: { overflowX: "auto" } }, /* @__PURE__ */ React.createElement("table", { style: tableStyle }, /* @__PURE__ */ React.createElement("thead", null, /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E1B\u0E23\u0E30\u0E40\u0E20\u0E17\u0E1B\u0E39"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E08\u0E33\u0E19\u0E27\u0E19\u0E01\u0E25\u0E48\u0E2D\u0E07"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E19\u0E49\u0E33\u0E2B\u0E19\u0E31\u0E01\u0E23\u0E27\u0E21 (\u0E01\u0E01.)"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E40\u0E1B\u0E49\u0E32\u0E2B\u0E21\u0E32\u0E22 (\u0E01\u0E01.)"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E2D\u0E32\u0E2B\u0E32\u0E23/\u0E27\u0E31\u0E19 (\u0E01\u0E01.)"), /* @__PURE__ */ React.createElement("th", { style: { ...thStyle, borderLeft: `2px solid ${C.line}` } }, "\u0E15\u0E49\u0E19\u0E17\u0E38\u0E19\u0E2D\u0E32\u0E2B\u0E32\u0E23\u0E2A\u0E30\u0E2A\u0E21 (\u0E1A\u0E32\u0E17)"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E01\u0E33\u0E44\u0E23\u0E1B\u0E23\u0E30\u0E40\u0E21\u0E34\u0E19 (\u0E1A\u0E32\u0E17, \u0E23\u0E32\u0E04\u0E32\u0E1B\u0E31\u0E08\u0E08\u0E38\u0E1A\u0E31\u0E19)"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E01\u0E33\u0E44\u0E23\u0E04\u0E32\u0E14\u0E01\u0E32\u0E23\u0E13\u0E4C (\u0E1A\u0E32\u0E17, \u0E23\u0E32\u0E04\u0E32\u0E04\u0E32\u0E14\u0E01\u0E32\u0E23\u0E13\u0E4C)"))), /* @__PURE__ */ React.createElement("tbody", null, (["male","female","eggs"]).map((catKey) => { const b = financeByCategory[catKey]; const label = catKey === "male" ? "\u0E15\u0E31\u0E27\u0E1C\u0E39\u0E49" : catKey === "female" ? "\u0E15\u0E31\u0E27\u0E40\u0E21\u0E35\u0E22" : "\u0E1B\u0E39\u0E44\u0E02\u0E48"; const target = settings.salesTargets[catKey] || 0; const pct = target > 0 ? Math.min(100, b.weightKg / target * 100) : 0; const dailyFeedKg = b.feedPerDayTotal / 1e3; return /* @__PURE__ */ React.createElement("tr", { key: catKey }, /* @__PURE__ */ React.createElement("td", { style: tdStyle }, label), /* @__PURE__ */ React.createElement("td", { style: { ...tdStyle, fontFamily: MONO } }, b.count), /* @__PURE__ */ React.createElement("td", { style: { ...tdStyle, fontFamily: MONO } }, num(b.weightKg, 1)), /* @__PURE__ */ React.createElement("td", { style: { ...tdStyle, fontFamily: MONO } }, target ? `${num(target)} \u0E01\u0E01. (${num(pct,0)}%)` : "\u2014"), /* @__PURE__ */ React.createElement("td", { style: { ...tdStyle, fontFamily: MONO } }, `${num(dailyFeedKg, 2)} \u0E01\u0E01./\u0E27\u0E31\u0E19`), /* @__PURE__ */ React.createElement("td", { style: { ...tdStyle, fontFamily: MONO, borderLeft: `2px solid ${C.line}` } }, money(b.feedCostAccrued)), /* @__PURE__ */ React.createElement("td", { style: { ...tdStyle, fontFamily: MONO, color: b.profitNow >= 0 ? C.seagrass : C.coral, fontWeight: 700 } }, money(b.profitNow)), /* @__PURE__ */ React.createElement("td", { style: { ...tdStyle, fontFamily: MONO, color: b.profitForecast >= 0 ? C.seagrass : C.coral } }, money(b.profitForecast))); })))), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 11.5, color: C.muted, marginTop: 8 } }, "\u0E15\u0E49\u0E19\u0E17\u0E38\u0E19\u0E2D\u0E32\u0E2B\u0E32\u0E23\u0E04\u0E33\u0E19\u0E27\u0E13\u0E08\u0E32\u0E01 \"\u0E15\u0E49\u0E19\u0E17\u0E38\u0E19\u0E2D\u0E32\u0E2B\u0E32\u0E23\u0E15\u0E48\u0E2D\u0E01\u0E34\u0E42\u0E25\u0E01\u0E23\u0E31\u0E21\" x \u0E1B\u0E23\u0E34\u0E21\u0E32\u0E13\u0E2D\u0E32\u0E2B\u0E32\u0E23/\u0E27\u0E31\u0E19 x \u0E08\u0E33\u0E19\u0E27\u0E19\u0E27\u0E31\u0E19\u0E17\u0E35\u0E48\u0E40\u0E25\u0E35\u0E49\u0E22\u0E07\u0E21\u0E32 (\u0E41\u0E1A\u0E1A\u0E1B\u0E23\u0E30\u0E40\u0E21\u0E34\u0E19) \u2014 \u0E41\u0E01\u0E49\u0E44\u0E02\u0E23\u0E32\u0E04\u0E32\u0E41\u0E25\u0E30\u0E40\u0E1B\u0E49\u0E32\u0E2B\u0E21\u0E32\u0E22\u0E44\u0E14\u0E49\u0E17\u0E35\u0E48\u0E2B\u0E19\u0E49\u0E32\u0E15\u0E31\u0E49\u0E07\u0E04\u0E48\u0E32")), /* @__PURE__ */ React.createElement("div", { style: cardStyle }, /* @__PURE__ */ React.createElement(SectionTitle, { sub: "\u0E20\u0E32\u0E1E\u0E23\u0E27\u0E21\u0E0A\u0E48\u0E27\u0E07\u0E04\u0E48\u0E32\u0E19\u0E49\u0E33\u0E25\u0E48\u0E32\u0E2A\u0E38\u0E14" }, "\u0E04\u0E38\u0E13\u0E20\u0E32\u0E1E\u0E19\u0E49\u0E33"), waterLogs.length === 0 ? /* @__PURE__ */ React.createElement("div", { style: { fontSize: 13, color: C.muted } }, '\u0E22\u0E31\u0E07\u0E44\u0E21\u0E48\u0E21\u0E35\u0E01\u0E32\u0E23\u0E1A\u0E31\u0E19\u0E17\u0E36\u0E01\u0E04\u0E48\u0E32\u0E19\u0E49\u0E33 \u2014 \u0E44\u0E1B\u0E17\u0E35\u0E48\u0E41\u0E17\u0E47\u0E1A "\u0E04\u0E38\u0E13\u0E20\u0E32\u0E1E\u0E19\u0E49\u0E33" \u0E40\u0E1E\u0E37\u0E48\u0E2D\u0E40\u0E23\u0E34\u0E48\u0E21\u0E1A\u0E31\u0E19\u0E17\u0E36\u0E01') : /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "0 24px" } }, settings.parameters.map((p) => {
    var _a2;
    return /* @__PURE__ */ React.createElement(GaugeBar, { key: p.key, param: p, value: (_a2 = waterLogs[waterLogs.length - 1].readings[p.key]) != null ? _a2 : null });
  })))), tab === "boxes" && /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "cf-toolbar-row", style: { display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 6, background: "#E4E9E2", borderRadius: 10, padding: 3 } }, /* @__PURE__ */ React.createElement(
    "button",
    {
      onClick: () => setBoxViewMode("plan"),
      style: {
        padding: "7px 14px",
        borderRadius: 8,
        border: "none",
        cursor: "pointer",
        background: boxViewMode === "plan" ? C.card : "transparent",
        fontWeight: 700,
        fontSize: 12.5,
        color: boxViewMode === "plan" ? C.ink : C.muted,
        boxShadow: boxViewMode === "plan" ? "0 1px 3px rgba(0,0,0,0.12)" : "none"
      }
    },
    "\u0E1C\u0E31\u0E07\u0E04\u0E2D\u0E19\u0E42\u0E14"
  ), /* @__PURE__ */ React.createElement(
    "button",
    {
      onClick: () => setBoxViewMode("list"),
      style: {
        padding: "7px 14px",
        borderRadius: 8,
        border: "none",
        cursor: "pointer",
        background: boxViewMode === "list" ? C.card : "transparent",
        fontWeight: 700,
        fontSize: 12.5,
        color: boxViewMode === "list" ? C.ink : C.muted,
        boxShadow: boxViewMode === "list" ? "0 1px 3px rgba(0,0,0,0.12)" : "none"
      }
    },
    "\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23"
  ))), boxViewMode === "plan" ? /* @__PURE__ */ React.createElement(
    FloorPlanView,
    {
      boxes,
      settings,
      onOpenBox: setOpenBox,
      onQuickHarvest: setHarvestTarget,
      onAddAt: (code) => {
        setPrefillBoxNumber(code);
        setShowNewBox(true);
      }
    }
  ) : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" } }, /* @__PURE__ */ React.createElement("input", { id: "crabfarm-search-input", className: "cf-field-flex", style: { ...inputStyle, width: 200 }, placeholder: "\u0E04\u0E49\u0E19\u0E2B\u0E32\u0E40\u0E1A\u0E2D\u0E23\u0E4C\u0E01\u0E25\u0E48\u0E2D\u0E07\u2026", value: boxFilter.q, onChange: (e) => setBoxFilter((f) => ({ ...f, q: e.target.value })) }), /* @__PURE__ */ React.createElement("select", { className: "cf-field-flex", style: { ...inputStyle, width: 150 }, value: boxFilter.status, onChange: (e) => setBoxFilter((f) => ({ ...f, status: e.target.value })) }, /* @__PURE__ */ React.createElement("option", { value: "all" }, "\u0E17\u0E38\u0E01\u0E2A\u0E16\u0E32\u0E19\u0E30"), /* @__PURE__ */ React.createElement("option", { value: "active" }, "\u0E01\u0E33\u0E25\u0E31\u0E07\u0E40\u0E25\u0E35\u0E49\u0E22\u0E07"), /* @__PURE__ */ React.createElement("option", { value: "empty" }, "\u0E27\u0E48\u0E32\u0E07")), /* @__PURE__ */ React.createElement("select", { className: "cf-field-flex", style: { ...inputStyle, width: 150 }, value: boxFilter.sex, onChange: (e) => setBoxFilter((f) => ({ ...f, sex: e.target.value })) }, /* @__PURE__ */ React.createElement("option", { value: "all" }, "\u0E17\u0E38\u0E01\u0E40\u0E1E\u0E28"), /* @__PURE__ */ React.createElement("option", { value: "male" }, "\u0E15\u0E31\u0E27\u0E1C\u0E39\u0E49"), /* @__PURE__ */ React.createElement("option", { value: "female" }, "\u0E15\u0E31\u0E27\u0E40\u0E21\u0E35\u0E22"))), /* @__PURE__ */ React.createElement(Btn, { tone: "ghost", size: "sm", onClick: () => setPrintPicker(filteredBoxes.length ? filteredBoxes : boxes) }, "\u{1F5A8}\uFE0F \u0E1E\u0E34\u0E21\u0E1E\u0E4C\u0E2A\u0E15\u0E34\u0E01\u0E40\u0E01\u0E2D\u0E23\u0E4C QR"), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12, color: C.muted, marginBottom: 10 } }, "\u0E1E\u0E1A ", filteredBoxes.length.toLocaleString(), " \u0E01\u0E25\u0E48\u0E2D\u0E07"), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 14 } }, pagedBoxes.map((b) => /* @__PURE__ */ React.createElement(BoxCard, { key: b.id, box: b, onOpen: setOpenBox, onQuickHarvest: setHarvestTarget, onQuickDeath: setDeathTarget, moltReminderDays: settings.moltReminderDays })), filteredBoxes.length === 0 && /* @__PURE__ */ React.createElement("div", { style: { color: C.muted, fontSize: 13 } }, "\u0E44\u0E21\u0E48\u0E1E\u0E1A\u0E01\u0E25\u0E48\u0E2D\u0E07\u0E15\u0E32\u0E21\u0E40\u0E07\u0E37\u0E48\u0E2D\u0E19\u0E44\u0E02")), listTotalPages > 1 && /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "center", gap: 14, marginTop: 20 } }, /* @__PURE__ */ React.createElement(Btn, { tone: "ghost", size: "sm", disabled: listPageClamped === 0, onClick: () => setListPage(Math.max(0, listPageClamped - 1)) }, "\u2190 \u0E01\u0E48\u0E2D\u0E19\u0E2B\u0E19\u0E49\u0E32"), /* @__PURE__ */ React.createElement("span", { style: { fontSize: 12.5, color: C.muted, fontFamily: MONO } }, "\u0E2B\u0E19\u0E49\u0E32 ", listPageClamped + 1, " / ", listTotalPages), /* @__PURE__ */ React.createElement(Btn, { tone: "ghost", size: "sm", disabled: listPageClamped >= listTotalPages - 1, onClick: () => setListPage(Math.min(listTotalPages - 1, listPageClamped + 1)) }, "\u0E16\u0E31\u0E14\u0E44\u0E1B \u2192")))), tab === "alerts" && /* @__PURE__ */ React.createElement(AlertsTab, { boxAlerts, overviewAlerts, boxes, onOpenBox: setOpenBox }), tab === "water" && /* @__PURE__ */ React.createElement(WaterTab, { waterLogs, settings, onAddLog: (l) => persistWater([...waterLogs, l], [l.id]), onUpdateSettings: persistSettings }), tab === "feed" && /* @__PURE__ */ React.createElement(FeedTab, { boxes, settings, onUpdateBox: updateBox, onUpdateSettings: persistSettings }), tab === "history" && /* @__PURE__ */ React.createElement(HistoryTab, { history }), tab === "settings" && /* @__PURE__ */ React.createElement(
    SettingsTab,
    {
      settings,
      onSave: persistSettings,
      onExport: exportData,
      onImport: importData,
      onResetAll: resetAll,
      counts: { boxes: boxes.length, history: history.length, water: waterLogs.length }
    }
  ))), showNewBox && /* @__PURE__ */ React.createElement(BoxFormModal, { onSave: saveBox, onClose: () => {
    setShowNewBox(false);
    setPrefillBoxNumber("");
  }, prefillBoxNumber, allBoxes: boxes, settings }), openBox && /* @__PURE__ */ React.createElement(BoxFormModal, { initial: openBox, onSave: saveBox, onClose: () => setOpenBox(null), onDelete: deleteBox, nextBatchFor, allBoxes: boxes, settings, onPrintSticker: (box) => setPrintPicker([box]) }), harvestTarget && /* @__PURE__ */ React.createElement(HarvestModal, { box: harvestTarget, onConfirm: confirmHarvest, onClose: () => setHarvestTarget(null) }), deathTarget && /* @__PURE__ */ React.createElement(DeathModal, { box: deathTarget, settings, onConfirm: confirmDeath, onClose: () => setDeathTarget(null) }), confirmDialog && /* @__PURE__ */ React.createElement(ConfirmModal, { message: confirmDialog.message, onYes: () => {
    confirmDialog.resolve(true);
    setConfirmDialog(null);
  }, onNo: () => {
    confirmDialog.resolve(false);
    setConfirmDialog(null);
  } }), showScanner && /* @__PURE__ */ React.createElement(QRScanModal, { boxes, onFound: (box) => { setOpenBox(box); setShowScanner(false); }, onClose: () => setShowScanner(false) }), printPicker && /* @__PURE__ */ React.createElement(StickerPrintModal, { boxes: printPicker, onClose: () => setPrintPicker(null), onPrint: (job) => { setPrintPicker(null); setPrintJob(job); } })), printJob && /* @__PURE__ */ React.createElement(PrintStickersArea, { job: printJob, onDone: () => setPrintJob(null) }));
}

export default App;
