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
const COL_MARKET = "market";
const COL_CUSTOMERS = "customers";
const COL_ORDERS = "orders";
const CHUNKS = { boxes: 24, history: 10, water: 10, market: 4, customers: 4, orders: 6 }; // 24 chunks * ~1200 boxes each supports 30,000+ boxes safely under the size limit per key
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
  { key: "waterLevel", label: "\u0E23\u0E30\u0E14\u0E31\u0E1A\u0E19\u0E49\u0E33", unit: "%", min: 30, target: 80, max: 100, doseFactor: 0, doseUnit: "", dosable: false, lowerIsBetter: false },
  { key: "hardness", label: "\u0E04\u0E27\u0E32\u0E21\u0E01\u0E23\u0E30\u0E14\u0E49\u0E32\u0E07 (Hardness)", unit: "mg/L", min: 0, target: 150, max: 1000, doseFactor: 0, doseUnit: "", dosable: false, lowerIsBetter: false },
  { key: "freeChlorine", label: "\u0E04\u0E25\u0E2D\u0E23\u0E35\u0E19\u0E2D\u0E34\u0E2A\u0E23\u0E30 (Free Chlorine)", unit: "mg/L", min: 0, target: 0, max: 0.1, doseFactor: 0, doseUnit: "", dosable: false, lowerIsBetter: true },
  { key: "totalChlorine", label: "\u0E04\u0E25\u0E2D\u0E23\u0E35\u0E19\u0E23\u0E27\u0E21 (Total Chlorine)", unit: "mg/L", min: 0, target: 0, max: 0.1, doseFactor: 0, doseUnit: "", dosable: false, lowerIsBetter: true },
  { key: "copper", label: "\u0E17\u0E2D\u0E07\u0E41\u0E14\u0E07 (Copper)", unit: "mg/L", min: 0, target: 0, max: 0.05, doseFactor: 0, doseUnit: "", dosable: false, lowerIsBetter: true },
  { key: "iron", label: "\u0E40\u0E2B\u0E25\u0E47\u0E01 (Iron)", unit: "mg/L", min: 0, target: 0, max: 1, doseFactor: 0, doseUnit: "", dosable: false, lowerIsBetter: true },
  { key: "lead", label: "\u0E15\u0E30\u0E01\u0E31\u0E48\u0E27 (Lead)", unit: "mg/L", min: 0, target: 0, max: 0.01, doseFactor: 0, doseUnit: "", dosable: false, lowerIsBetter: true },
  { key: "nitrate", label: "\u0E44\u0E19\u0E40\u0E15\u0E23\u0E17\u0E4C (Nitrate)", unit: "mg/L", min: 0, target: 0, max: 50, doseFactor: 0, doseUnit: "", dosable: false, lowerIsBetter: true },
  { key: "bromine", label: "\u0E42\u0E1A\u0E23\u0E21\u0E35\u0E19 (Bromine)", unit: "mg/L", min: 0, target: 0, max: 2, doseFactor: 0, doseUnit: "", dosable: false, lowerIsBetter: true },
  { key: "chromium", label: "\u0E42\u0E04\u0E23\u0E40\u0E21\u0E35\u0E22\u0E21 (Cr)", unit: "mg/L", min: 0, target: 0, max: 0.05, doseFactor: 0, doseUnit: "", dosable: false, lowerIsBetter: true },
  { key: "peroxide", label: "\u0E44\u0E2E\u0E42\u0E14\u0E23\u0E40\u0E08\u0E19\u0E1B\u0E2D\u0E23\u0E4C\u0E2D\u0E2D\u0E01\u0E44\u0E0B\u0E14\u0E4C (Peroxide)", unit: "mg/L", min: 0, target: 0, max: 1, doseFactor: 0, doseUnit: "", dosable: false, lowerIsBetter: true },
  { key: "carbonate", label: "\u0E04\u0E32\u0E23\u0E4C\u0E1A\u0E2D\u0E19\u0E40\u0E19\u0E15 (Carbonate)", unit: "mg/L", min: 0, target: 120, max: 240, doseFactor: 0, doseUnit: "", dosable: false, lowerIsBetter: false },
  { key: "cyanuricAcid", label: "\u0E44\u0E0B\u0E22\u0E32\u0E19\u0E39\u0E23\u0E34\u0E01\u0E41\u0E2D\u0E0B\u0E34\u0E14 (Cyanuric Acid)", unit: "mg/L", min: 0, target: 0, max: 50, doseFactor: 0, doseUnit: "", dosable: false, lowerIsBetter: true },
  { key: "qac", label: "QAC (\u0E2A\u0E32\u0E23\u0E10\u0E32\u0E19\u0E41\u0E2D\u0E21\u0E42\u0E21\u0E40\u0E19\u0E35\u0E22\u0E21\u0E04\u0E27\u0E2D\u0E15\u0E4C)", unit: "mg/L", min: 0, target: 0, max: 10, doseFactor: 0, doseUnit: "", dosable: false, lowerIsBetter: true },
  { key: "orp", label: "ORP", unit: "mV", min: 50, target: 150, max: 300, doseFactor: 0, doseUnit: "", dosable: false, lowerIsBetter: false },
  { key: "tds", label: "TDS (\u0E04\u0E27\u0E32\u0E21\u0E40\u0E04\u0E47\u0E21\u0E08\u0E32\u0E01 TDS)", unit: "ppt", min: 0, target: 25, max: 35, doseFactor: 0, doseUnit: "", dosable: false, lowerIsBetter: false },
  { key: "conductivity", label: "\u0E01\u0E32\u0E23\u0E19\u0E33\u0E44\u0E1F\u0E1F\u0E49\u0E32", unit: "mS/cm", min: 0, target: 45, max: 60, doseFactor: 0, doseUnit: "", dosable: false, lowerIsBetter: false },
  { key: "specificGravity", label: "Specific Gravity", unit: "", min: 1.005, target: 1.02, max: 1.025, doseFactor: 0, doseUnit: "", dosable: false, lowerIsBetter: false },
  { key: "salinityPercent", label: "\u0E04\u0E27\u0E32\u0E21\u0E40\u0E04\u0E47\u0E21 (%)", unit: "%", min: 2.5, target: 3.2, max: 3.5, doseFactor: 0, doseUnit: "", dosable: false, lowerIsBetter: false }
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
const DEFAULT_CRAB_SIZE_PRESETS = [
  "2-3 \u0E15\u0E31\u0E27/\u0E01\u0E01.",
  "3-4 \u0E15\u0E31\u0E27/\u0E01\u0E01.",
  "4-5 \u0E15\u0E31\u0E27/\u0E01\u0E01.",
  "5-6 \u0E15\u0E31\u0E27/\u0E01\u0E01.",
  "6 \u0E15\u0E31\u0E27\u0E02\u0E36\u0E49\u0E19\u0E44\u0E1B/\u0E01\u0E01."
];
const ORDER_JOB_TYPES = [
  { key: "live", label: "\u0E1B\u0E39\u0E2A\u0E14 (\u0E17\u0E31\u0E49\u0E07\u0E15\u0E31\u0E27)" },
  { key: "sized", label: "\u0E17\u0E33\u0E44\u0E0B\u0E2A\u0E4C (\u0E04\u0E31\u0E14\u0E44\u0E0B\u0E2A\u0E4C\u0E41\u0E25\u0E49\u0E27)" },
  { key: "roe", label: "\u0E17\u0E33\u0E44\u0E02\u0E48 (\u0E1B\u0E39\u0E44\u0E02\u0E48\u0E1E\u0E23\u0E49\u0E2D\u0E21\u0E02\u0E32\u0E22)" }
];
const ORDER_STATUS_LABELS = { pending: "\u0E23\u0E2D\u0E14\u0E33\u0E40\u0E19\u0E34\u0E19\u0E01\u0E32\u0E23", fulfilled: "\u0E2A\u0E48\u0E07\u0E21\u0E2D\u0E1A\u0E41\u0E25\u0E49\u0E27", cancelled: "\u0E22\u0E01\u0E40\u0E25\u0E34\u0E01" };
const CUSTOMER_TYPE_LABELS = { regular: "\u0E25\u0E39\u0E01\u0E04\u0E49\u0E32\u0E1B\u0E23\u0E30\u0E08\u0E33", agent: "\u0E25\u0E39\u0E01\u0E04\u0E49\u0E32\u0E1B\u0E35\u0E01 (\u0E15\u0E31\u0E27\u0E41\u0E17\u0E19/\u0E1E\u0E48\u0E2D\u0E04\u0E49\u0E32\u0E04\u0E19\u0E01\u0E25\u0E32\u0E07)" };
const DEFAULT_MINERALS = [
  { key: "sodiumBicarbonate", name: "\u0E42\u0E0B\u0E40\u0E14\u0E35\u0E22\u0E21\u0E44\u0E1A\u0E04\u0E32\u0E23\u0E4C\u0E1A\u0E2D\u0E40\u0E19\u0E15 (Sodium Bicarbonate)", note: "Food Grade \u2014 \u0E40\u0E1E\u0E34\u0E48\u0E21\u0E14\u0E48\u0E32\u0E07/\u0E1A\u0E31\u0E1F\u0E40\u0E1F\u0E2D\u0E23\u0E4C pH \u0E41\u0E25\u0E30 KH" },
  { key: "potassiumChloride", name: "\u0E42\u0E1E\u0E41\u0E17\u0E2A\u0E40\u0E0B\u0E35\u0E22\u0E21\u0E04\u0E25\u0E2D\u0E44\u0E23\u0E14\u0E4C (Potassium Chloride)", note: "\u0E16\u0E38\u0E07 1kg \u2014 \u0E40\u0E1E\u0E34\u0E48\u0E21\u0E42\u0E1E\u0E41\u0E17\u0E2A\u0E40\u0E0B\u0E35\u0E22\u0E21 (K+) \u0E0A\u0E48\u0E27\u0E22\u0E40\u0E23\u0E37\u0E48\u0E2D\u0E07\u0E25\u0E2D\u0E01\u0E04\u0E23\u0E32\u0E1A" },
  { key: "magnesiumChloride", name: "\u0E41\u0E21\u0E01\u0E19\u0E35\u0E40\u0E0B\u0E35\u0E22\u0E21\u0E04\u0E25\u0E2D\u0E44\u0E23\u0E14\u0E4C (Magnesium Chloride)", note: "~47% MgCl\u2082, \u0E01\u0E23\u0E30\u0E2A\u0E2D\u0E1B 25kg \u2014 \u0E40\u0E1E\u0E34\u0E48\u0E21\u0E41\u0E21\u0E01\u0E19\u0E35\u0E40\u0E0B\u0E35\u0E22\u0E21 (Mg2+)" },
  { key: "calciumChloride", name: "\u0E41\u0E04\u0E25\u0E40\u0E0B\u0E35\u0E22\u0E21\u0E04\u0E25\u0E2D\u0E44\u0E23\u0E14\u0E4C\u0E40\u0E01\u0E25\u0E47\u0E14 (Calcium Chloride Flake)", note: "CaCl\u2082 \u2265 74%, \u0E01\u0E23\u0E30\u0E2A\u0E2D\u0E1B 25kg \u2014 \u0E40\u0E1E\u0E34\u0E48\u0E21\u0E41\u0E04\u0E25\u0E40\u0E0B\u0E35\u0E22\u0E21 (Ca2+) \u0E0A\u0E48\u0E27\u0E22\u0E40\u0E23\u0E37\u0E48\u0E2D\u0E07\u0E25\u0E2D\u0E01\u0E04\u0E23\u0E32\u0E1A/\u0E40\u0E1B\u0E25\u0E37\u0E2D\u0E01\u0E41\u0E02\u0E47\u0E07" },
  { key: "seaSalt", name: "\u0E40\u0E01\u0E25\u0E37\u0E2D\u0E2A\u0E21\u0E38\u0E17\u0E23 / \u0E40\u0E01\u0E25\u0E37\u0E2D\u0E2A\u0E33\u0E2B\u0E23\u0E31\u0E1A\u0E17\u0E33\u0E19\u0E49\u0E33\u0E17\u0E30\u0E40\u0E25\u0E40\u0E17\u0E35\u0E22\u0E21 (Sea Salt)", note: "\u0E1B\u0E23\u0E31\u0E1A\u0E04\u0E27\u0E32\u0E21\u0E40\u0E04\u0E47\u0E21\u0E1E\u0E37\u0E49\u0E19\u0E10\u0E32\u0E19 (\u0E42\u0E0B\u0E40\u0E14\u0E35\u0E22\u0E21/\u0E04\u0E25\u0E2D\u0E44\u0E23\u0E14\u0E4C)" }
];
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
  salesTargets: DEFAULT_SALES_TARGETS,
  minerals: DEFAULT_MINERALS,
  crabSizePresets: DEFAULT_CRAB_SIZE_PRESETS
};
function mergeSettings(s) {
  if (!s || !s.parameters) return DEFAULT_SETTINGS;
  const existingKeys = new Set(s.parameters.map((p) => p.key));
  const mergedParams = [...s.parameters, ...DEFAULT_PARAMS.filter((dp) => !existingKeys.has(dp.key))];
  const existingMineralKeys = new Set((s.minerals || []).map((m) => m.key));
  const mergedMinerals = [...(s.minerals || []), ...DEFAULT_MINERALS.filter((dm) => !existingMineralKeys.has(dm.key))];
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    parameters: mergedParams,
    minerals: mergedMinerals,
    pricing: {
      male: { ...DEFAULT_PRICING.male, ...(s.pricing && s.pricing.male) },
      female: { ...DEFAULT_PRICING.female, ...(s.pricing && s.pricing.female) },
      eggs: { ...DEFAULT_PRICING.eggs, ...(s.pricing && s.pricing.eggs) }
    },
    salesTargets: { ...DEFAULT_SALES_TARGETS, ...s.salesTargets },
    crabSizePresets: s.crabSizePresets && s.crabSizePresets.length ? s.crabSizePresets : DEFAULT_CRAB_SIZE_PRESETS
  };
}
const CORE_PARAM_KEYS = ["salinity", "ph", "temp", "ammonia", "nitrite", "alkalinity", "calcium", "do", "waterLevel"];
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
function resizeImageToBase64(file, maxDimension = 1600, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        let { width, height } = img;
        if (width > maxDimension || height > maxDimension) {
          if (width > height) {
            height = Math.round(height * (maxDimension / width));
            width = maxDimension;
          } else {
            width = Math.round(width * (maxDimension / height));
            height = maxDimension;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        URL.revokeObjectURL(objectUrl);
        resolve({ base64Data: dataUrl.split(",")[1], mediaType: "image/jpeg" });
      } catch (err) {
        URL.revokeObjectURL(objectUrl);
        reject(err);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("\u0E44\u0E21\u0E48\u0E2A\u0E32\u0E21\u0E32\u0E23\u0E16\u0E40\u0E1B\u0E34\u0E14\u0E44\u0E1F\u0E25\u0E4C\u0E23\u0E39\u0E1B\u0E19\u0E35\u0E49\u0E44\u0E14\u0E49"));
    };
    img.src = objectUrl;
  });
}
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
function crabCategoryLabel(cat) {
  return cat === "male" ? "\u0E15\u0E31\u0E27\u0E1C\u0E39\u0E49" : cat === "female" ? "\u0E15\u0E31\u0E27\u0E40\u0E21\u0E35\u0E22" : "\u0E1B\u0E39\u0E44\u0E02\u0E48";
}
// Live stock available to sell for a category, in kg — used so the order/reservation
// form can warn before promising more crab than is actually in the boxes right now.
function categoryStockKg(boxes, category) {
  return boxes.filter((b) => b.status === "active" && crabCategory(b) === category).reduce((s, b) => s + Number(b.currentWeight || 0), 0) / 1000;
}
function orderReservedKg(orders, category, excludeId) {
  return (orders || []).filter((o) => o.category === category && o.status === "pending" && o.id !== excludeId).reduce((s, o) => s + Number(o.quantityKg || 0), 0);
}
function monthKeyOf(dateStr) {
  if (!dateStr) return null;
  return String(dateStr).slice(0, 7);
}
const TH_MONTH_SHORT = ["\u0E21.\u0E04.", "\u0E01.\u0E1E.", "\u0E21\u0E35.\u0E04.", "\u0E40\u0E21.\u0E22.", "\u0E1E.\u0E04.", "\u0E21\u0E34.\u0E22.", "\u0E01.\u0E04.", "\u0E2A.\u0E04.", "\u0E01.\u0E22.", "\u0E15.\u0E04.", "\u0E1E.\u0E22.", "\u0E18.\u0E04."];
function monthLabelOf(key) {
  if (!key) return "\u2014";
  const [y, m] = key.split("-");
  return `${TH_MONTH_SHORT[Number(m) - 1] || m} ${Number(y) + 543}`;
}
// Realized profit per calendar month, built from harvest history (dead-outcome
// records excluded since they carry no sale). Sorted oldest -> newest.
function computeMonthlyProfit(history) {
  const map = /* @__PURE__ */ new Map();
  (history || []).forEach((r) => {
    if (r.outcome === "dead") return;
    const k = monthKeyOf(r.harvestDate);
    if (!k) return;
    map.set(k, (map.get(k) || 0) + Number(r.profit || 0));
  });
  return Array.from(map.entries()).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0).map(([key, profit]) => ({ key, label: monthLabelOf(key), profit }));
}
function monthlyProfitLevel(months) {
  if (!months.length) return { level: "none", label: "\u2014\u0E22\u0E31\u0E07\u0E44\u0E21\u0E48\u0E21\u0E35\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u2014", tone: "muted" };
  const latest = months[months.length - 1].profit;
  const prior = months.slice(0, -1);
  const avg = prior.length ? prior.reduce((s, m) => s + m.profit, 0) / prior.length : null;
  if (avg === null) return { level: "flat", label: latest >= 0 ? "\u0E40\u0E14\u0E37\u0E2D\u0E19\u0E41\u0E23\u0E01" : "\u0E02\u0E32\u0E14\u0E17\u0E38\u0E19", tone: latest >= 0 ? "info" : "danger" };
  if (latest >= avg * 1.1) return { level: "good", label: "\u0E14\u0E35\u0E02\u0E36\u0E49\u0E19\u0E08\u0E32\u0E01\u0E40\u0E14\u0E37\u0E2D\u0E19\u0E01\u0E48\u0E2D\u0E19", tone: "good" };
  if (latest <= avg * 0.9) return { level: "low", label: "\u0E15\u0E48\u0E33\u0E01\u0E27\u0E48\u0E32\u0E40\u0E14\u0E37\u0E2D\u0E19\u0E01\u0E48\u0E2D\u0E19", tone: "danger" };
  return { level: "fair", label: "\u0E43\u0E01\u0E25\u0E49\u0E40\u0E04\u0E35\u0E22\u0E07\u0E40\u0E14\u0E37\u0E2D\u0E19\u0E01\u0E48\u0E2D\u0E19", tone: "warn" };
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
function LineChartSVG({ series, height = 190, yFormat }) {
  const width = 640;
  const points = (series || []).flatMap((s) => s.points || []);
  if (points.length < 2) {
    return /* @__PURE__ */ React.createElement("div", { style: { fontSize: 13, color: C.muted, padding: "20px 0" } }, "\u0E22\u0E31\u0E07\u0E44\u0E21\u0E48\u0E21\u0E35\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E1E\u0E2D\u0E2A\u0E33\u0E2B\u0E23\u0E31\u0E1A\u0E01\u0E23\u0E32\u0E1F (\u0E15\u0E49\u0E2D\u0E07\u0E21\u0E35\u0E2D\u0E22\u0E48\u0E32\u0E07\u0E19\u0E49\u0E2D\u0E22 2 \u0E08\u0E38\u0E14)");
  }
  const padL = 46, padR = 14, padT = 14, padB = 26;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minYraw = Math.min(0, ...ys), maxYraw = Math.max(...ys);
  const yPad = (maxYraw - minYraw) * 0.12 || Math.abs(maxYraw) * 0.15 || 1;
  const minY = minYraw - yPad, maxY = maxYraw + yPad;
  const xr = maxX - minX || 1, yr = maxY - minY || 1;
  const sx = (x) => padL + (x - minX) / xr * (width - padL - padR);
  const sy = (y) => height - padB - (y - minY) / yr * (height - padT - padB);
  const gridLines = 4;
  const fmt = yFormat || ((v) => num(v, Math.abs(v) < 10 ? 1 : 0));
  return /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("svg", { width: "100%", height, viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "xMidYMid meet" }, Array.from({ length: gridLines + 1 }).map((_, i) => {
    const y = padT + i / gridLines * (height - padT - padB);
    const val = maxY - i / gridLines * yr;
    return /* @__PURE__ */ React.createElement("g", { key: i }, /* @__PURE__ */ React.createElement("line", { x1: padL, y1: y, x2: width - padR, y2: y, stroke: C.line, strokeWidth: "1" }), /* @__PURE__ */ React.createElement("text", { x: padL - 6, y: y + 3, fontSize: "9.5", fill: C.muted, textAnchor: "end", fontFamily: MONO }, fmt(val)));
  }), (series || []).map((s, si) => /* @__PURE__ */ React.createElement("polyline", { key: `l${si}`, points: (s.points || []).map((p) => `${sx(p.x)},${sy(p.y)}`).join(" "), fill: "none", stroke: s.color || C.water, strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round" })), (series || []).map((s, si) => (s.points || []).map((p, i) => /* @__PURE__ */ React.createElement("circle", { key: `p${si}-${i}`, cx: sx(p.x), cy: sy(p.y), r: "2.8", fill: s.color || C.water })))), (series || []).length > 1 && /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 14, flexWrap: "wrap", fontSize: 11.5, marginTop: 6 } }, series.map((s, si) => /* @__PURE__ */ React.createElement("div", { key: si, style: { display: "flex", alignItems: "center", gap: 5 } }, /* @__PURE__ */ React.createElement("span", { style: { width: 10, height: 10, borderRadius: 3, background: s.color || C.water, display: "inline-block" } }), /* @__PURE__ */ React.createElement("span", { style: { color: C.muted } }, s.name)))));
}
function BarChartSVG({ data, height = 170, color }) {
  if (!data || !data.length || !data.some((d) => d.value > 0)) {
    return /* @__PURE__ */ React.createElement("div", { style: { fontSize: 13, color: C.muted, padding: "20px 0" } }, "\u0E22\u0E31\u0E07\u0E44\u0E21\u0E48\u0E21\u0E35\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25");
  }
  const max = Math.max(1, ...data.map((d) => d.value));
  return /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "flex-end", gap: 18, height, padding: "0 6px" } }, data.map((d, i) => /* @__PURE__ */ React.createElement("div", { key: i, style: { display: "flex", flexDirection: "column", alignItems: "center", flex: 1, minWidth: 0 } }, /* @__PURE__ */ React.createElement("div", { style: { fontSize: 11.5, fontFamily: MONO, color: C.text, marginBottom: 4, fontWeight: 700 } }, num(d.value, d.value < 10 ? 1 : 0)), /* @__PURE__ */ React.createElement("div", { style: { width: "60%", maxWidth: 54, height: Math.max(4, d.value / max * (height - 40)), background: d.color || color || C.water, borderRadius: "6px 6px 0 0", transition: "height 0.2s" } }), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 11, color: C.muted, marginTop: 6, textAlign: "center" } }, d.label))));
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
function normalizeBoxNumber(n) {
  return String(n || "").trim().toUpperCase();
}
function compareBoxNumbers(aNum, bNum) {
  const pa = parseBoxCode(aNum);
  const pb = parseBoxCode(bNum);
  if (pa && pb) {
    if (pa.row !== pb.row) return pa.row < pb.row ? -1 : 1;
    return pa.col - pb.col;
  }
  if (pa && !pb) return -1;
  if (!pa && pb) return 1;
  return normalizeBoxNumber(aNum).localeCompare(normalizeBoxNumber(bNum));
}
// Merge boxes that share the same box number (can happen if a new box was
// ever created on top of an existing/empty one with the same code) so the
// floor plan and the list always agree on a single row per box number.
function dedupeBoxes(list) {
  const groups = /* @__PURE__ */ new Map();
  (list || []).forEach((b) => {
    const key = normalizeBoxNumber(b.boxNumber);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  });
  let changed = false;
  const result = [];
  groups.forEach((group) => {
    if (group.length === 1) {
      result.push(group[0]);
      return;
    }
    changed = true;
    const actives = group.filter((b) => b.status === "active");
    let keep;
    if (actives.length) {
      keep = actives.reduce((a, b) => String(b.stockDate || "") > String(a.stockDate || "") ? b : a);
    } else {
      keep = group.reduce((a, b) => {
        const da = String(a.harvestDate || a.stockDate || "");
        const db = String(b.harvestDate || b.stockDate || "");
        return db > da ? b : a;
      });
    }
    result.push(keep);
  });
  return { list: result, changed };
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
  if (!box || box.status === "empty") {
    return /* @__PURE__ */ React.createElement(
      "button",
      {
        // If a box row already exists for this code (just currently empty,
        // e.g. after recording a death/harvest), reopen that SAME row so
        // restocking updates it in place instead of creating a duplicate
        // box with the same number. Only truly-new codes go to onAddAt.
        onClick: () => box ? onOpen(box) : onAddAt(code),
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
      const normalized = String(f.boxNumber).trim().toUpperCase();
      const existing = (allBoxes || []).find(
        (b) => b.id !== f.id && String(b.boxNumber).trim().toUpperCase() === normalized
      );
      if (existing) {
        const msg = existing.status === "active" ? `เบอร์กล่อง "${f.boxNumber}" มีปูกำลังเลี้ยงอยู่แล้ว กรุณาตรวจสอบ หรือเก็บเกี่ยว/บันทึกปูตายกล่องเดิมก่อน` : `กล่อง "${f.boxNumber}" มีอยู่แล้วในระบบ (สถานะว่าง) กรุณาเปิดกล่องเดิมแล้วกด "ลงปูใหม่" แทนการเพิ่มกล่องใหม่ เพื่อไม่ให้มีเบอร์กล่องซ้ำ`;
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
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState("");
  const [aiFilledKeys, setAiFilledKeys] = useState([]);
  const [myApiKey, setMyApiKey] = useState(() => {
    try {
      return localStorage.getItem("cf_gemini_api_key") || "";
    } catch {
      return "";
    }
  });
  const [showKeyBox, setShowKeyBox] = useState(false);
  const [showExtraParams, setShowExtraParams] = useState(false);
  const saveMyApiKey = (val) => {
    setMyApiKey(val);
    try {
      if (val) localStorage.setItem("cf_gemini_api_key", val);
      else localStorage.removeItem("cf_gemini_api_key");
    } catch {
    }
  };
  const aiFileRef = useRef(null);
  const aiGalleryRef = useRef(null);
  const handleAiPhoto = async (file) => {
    if (!file) return;
    setAiLoading(true);
    setAiError("");
    setAiFilledKeys([]);
    try {
      const { base64Data, mediaType } = await resizeImageToBase64(file);
      const paramList = params.map((p) => `${p.key} (${p.label}${p.unit ? ", \u0E2B\u0E19\u0E48\u0E27\u0E22 " + p.unit : ""})`).join(", ");
      const prompt = `\u0E19\u0E35\u0E48\u0E04\u0E37\u0E2D\u0E23\u0E39\u0E1B\u0E16\u0E48\u0E32\u0E22\u0E1C\u0E25\u0E15\u0E23\u0E27\u0E08\u0E04\u0E38\u0E13\u0E20\u0E32\u0E1E\u0E19\u0E49\u0E33 (\u0E2D\u0E32\u0E08\u0E40\u0E1B\u0E47\u0E19\u0E41\u0E16\u0E1A\u0E17\u0E14\u0E2A\u0E2D\u0E1A\u0E2A\u0E35 (test strip) \u0E40\u0E17\u0E35\u0E22\u0E1A\u0E01\u0E31\u0E1A\u0E0A\u0E32\u0E23\u0E4C\u0E15\u0E2D\u0E49\u0E32\u0E07\u0E2D\u0E34\u0E07\u0E43\u0E19\u0E20\u0E32\u0E1E \u0E2B\u0E23\u0E37\u0E2D\u0E2B\u0E19\u0E49\u0E32\u0E08\u0E2D\u0E40\u0E04\u0E23\u0E37\u0E48\u0E2D\u0E07\u0E27\u0E31\u0E14\u0E14\u0E34\u0E08\u0E34\u0E17\u0E31\u0E25) \u0E43\u0E2B\u0E49\u0E2D\u0E48\u0E32\u0E19\u0E04\u0E48\u0E32\u0E08\u0E32\u0E01\u0E20\u0E32\u0E1E\u0E19\u0E35\u0E49 \u0E41\u0E25\u0E49\u0E27\u0E41\u0E1B\u0E25\u0E07\u0E40\u0E1B\u0E47\u0E19\u0E04\u0E48\u0E32\u0E15\u0E31\u0E27\u0E40\u0E25\u0E02\u0E2A\u0E33\u0E2B\u0E23\u0E31\u0E1A\u0E1E\u0E32\u0E23\u0E32\u0E21\u0E34\u0E40\u0E15\u0E2D\u0E23\u0E4C\u0E15\u0E48\u0E2D\u0E44\u0E1B\u0E19\u0E35\u0E49\u0E40\u0E17\u0E48\u0E32\u0E17\u0E35\u0E48\u0E21\u0E2D\u0E07\u0E40\u0E2B\u0E47\u0E19\u0E44\u0E14\u0E49\u0E08\u0E32\u0E01\u0E20\u0E32\u0E1E: ${paramList}. \u0E16\u0E49\u0E32\u0E1E\u0E32\u0E23\u0E32\u0E21\u0E34\u0E40\u0E15\u0E2D\u0E23\u0E4C\u0E44\u0E2B\u0E19\u0E44\u0E21\u0E48\u0E21\u0E35\u0E43\u0E19\u0E20\u0E32\u0E1E\u0E2B\u0E23\u0E37\u0E2D\u0E44\u0E21\u0E48\u0E21\u0E31\u0E48\u0E19\u0E43\u0E08 \u0E43\u0E2B\u0E49\u0E02\u0E49\u0E32\u0E21\u0E44\u0E1B\u0E44\u0E21\u0E48\u0E15\u0E49\u0E2D\u0E07\u0E43\u0E2A\u0E48\u0E43\u0E19\u0E1C\u0E25\u0E25\u0E31\u0E1E\u0E18\u0E4C \u0E15\u0E2D\u0E1A\u0E01\u0E25\u0E31\u0E1A\u0E40\u0E1B\u0E47\u0E19 JSON \u0E40\u0E17\u0E48\u0E32\u0E19\u0E31\u0E49\u0E19 \u0E2B\u0E49\u0E32\u0E21\u0E21\u0E35\u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21\u0E2D\u0E37\u0E48\u0E19\u0E43\u0E14 \u0E2B\u0E49\u0E32\u0E21\u0E21\u0E35 markdown code fence \u0E23\u0E39\u0E1B\u0E41\u0E1A\u0E1A: {"key1": number, "key2": number} \u0E43\u0E0A\u0E49 key \u0E15\u0E23\u0E07\u0E15\u0E32\u0E21\u0E17\u0E35\u0E48\u0E01\u0E33\u0E2B\u0E19\u0E14\u0E40\u0E1B\u0E4A\u0E30 \u0E46 (\u0E40\u0E0A\u0E48\u0E19 "ph", "salinity", "temp", "hardness", "nitrate", "orp")`;
      const response = await fetch("/api/analyze-water", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageBase64: base64Data,
          mediaType,
          prompt,
          apiKeyOverride: myApiKey || void 0
        })
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "\u0E40\u0E23\u0E35\u0E22\u0E01 API \u0E44\u0E21\u0E48\u0E2A\u0E33\u0E40\u0E23\u0E47\u0E08");
      }
      if (!data.text) throw new Error("\u0E44\u0E21\u0E48\u0E44\u0E14\u0E49\u0E23\u0E31\u0E1A\u0E1C\u0E25\u0E25\u0E31\u0E1E\u0E18\u0E4C\u0E08\u0E32\u0E01 AI");
      const cleaned = data.text.replace(/```json|```/g, "").trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : cleaned);
      const filled = [];
      setReadings((r) => {
        const next = { ...r };
        params.forEach((p) => {
          const v = parsed[p.key];
          if (v !== void 0 && v !== null && !isNaN(v)) {
            next[p.key] = String(v);
            filled.push(p.key);
          }
        });
        return next;
      });
      setAiFilledKeys(filled);
      if (filled.some((k) => !CORE_PARAM_KEYS.includes(k))) setShowExtraParams(true);
      if (filled.length === 0) {
        setAiError("AI \u0E44\u0E21\u0E48\u0E1E\u0E1A\u0E04\u0E48\u0E32\u0E17\u0E35\u0E48\u0E2D\u0E48\u0E32\u0E19\u0E44\u0E14\u0E49\u0E0A\u0E31\u0E14\u0E40\u0E08\u0E19\u0E43\u0E19\u0E20\u0E32\u0E1E\u0E19\u0E35\u0E49 \u0E25\u0E2D\u0E07\u0E16\u0E48\u0E32\u0E22\u0E43\u0E2B\u0E21\u0E48\u0E43\u0E2B\u0E49\u0E0A\u0E31\u0E14\u0E02\u0E36\u0E49\u0E19 \u0E2B\u0E23\u0E37\u0E2D\u0E01\u0E23\u0E2D\u0E01\u0E40\u0E2D\u0E07\u0E41\u0E17\u0E19");
      }
    } catch (err) {
      console.error(err);
      const detail = (err && err.message) || String(err);
      setAiError(`\u0E2D\u0E48\u0E32\u0E19\u0E04\u0E48\u0E32\u0E08\u0E32\u0E01\u0E20\u0E32\u0E1E\u0E44\u0E21\u0E48\u0E2A\u0E33\u0E40\u0E23\u0E47\u0E08: ${detail}`);
    } finally {
      setAiLoading(false);
    }
  };
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
    setAiFilledKeys([]);
    setAiError("");
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
  return /* @__PURE__ */ React.createElement("div", { className: "cf-grid-water", style: { display: "grid", gridTemplateColumns: "380px 1fr", gap: 20, alignItems: "start" } }, /* @__PURE__ */ React.createElement("div", { style: cardStyle }, /* @__PURE__ */ React.createElement(SectionTitle, null, "\u0E1A\u0E31\u0E19\u0E17\u0E36\u0E01\u0E04\u0E48\u0E32\u0E19\u0E49\u0E33\u0E27\u0E31\u0E19\u0E19\u0E35\u0E49"), /* @__PURE__ */ React.createElement("input", { ref: aiFileRef, type: "file", accept: "image/*", capture: "environment", style: { display: "none" }, onChange: (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) handleAiPhoto(file);
    e.target.value = "";
  } }), /* @__PURE__ */ React.createElement("input", { ref: aiGalleryRef, type: "file", accept: "image/*", style: { display: "none" }, onChange: (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) handleAiPhoto(file);
    e.target.value = "";
  } }), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 8, marginBottom: 6 } }, /* @__PURE__ */ React.createElement(Btn, { tone: "ghost", disabled: aiLoading, onClick: () => aiFileRef.current && aiFileRef.current.click(), style: { flex: 1 } }, aiLoading ? "\u{1F504} \u0E01\u0E33\u0E25\u0E31\u0E07\u0E2D\u0E48\u0E32\u0E19\u2026" : "\u{1F4F7} \u0E16\u0E48\u0E32\u0E22\u0E23\u0E39\u0E1B"), /* @__PURE__ */ React.createElement(Btn, { tone: "ghost", disabled: aiLoading, onClick: () => aiGalleryRef.current && aiGalleryRef.current.click(), style: { flex: 1 } }, aiLoading ? "\u{1F504} \u0E01\u0E33\u0E25\u0E31\u0E07\u0E2D\u0E48\u0E32\u0E19\u2026" : "\u{1F5BC}\uFE0F \u0E42\u0E2B\u0E25\u0E14\u0E23\u0E39\u0E1B")), /* @__PURE__ */ React.createElement("a", { href: "https://aistudio.google.com/apikey", target: "_blank", rel: "noopener noreferrer", style: { display: "block", textAlign: "center", fontSize: 12, color: C.water, marginBottom: 6, textDecoration: "none" } }, "\u{1F511} \u0E22\u0E31\u0E07\u0E44\u0E21\u0E48\u0E21\u0E35 API Key? \u0E2A\u0E21\u0E31\u0E04\u0E23\u0E1F\u0E23\u0E35\u0E17\u0E35\u0E48 Google AI Studio \u2192"), /* @__PURE__ */ React.createElement("div", { style: { textAlign: "center", marginBottom: 10 } }, /* @__PURE__ */ React.createElement("button", { type: "button", onClick: () => setShowKeyBox((v) => !v), style: { background: "none", border: "none", cursor: "pointer", fontSize: 11.5, color: C.muted, textDecoration: "underline" } }, myApiKey ? "\u2713 \u0E15\u0E31\u0E49\u0E07 API Key \u0E02\u0E2D\u0E07\u0E09\u0E31\u0E19\u0E41\u0E25\u0E49\u0E27 (\u0E41\u0E01\u0E49\u0E44\u0E02)" : "\u2699\uFE0F \u0E43\u0E2A\u0E48 API Key \u0E02\u0E2D\u0E07\u0E09\u0E31\u0E19\u0E40\u0E2D\u0E07 (\u0E44\u0E21\u0E48\u0E1A\u0E31\u0E07\u0E04\u0E31\u0E1A)")), showKeyBox && /* @__PURE__ */ React.createElement("div", { style: { background: "rgba(60,150,110,0.06)", border: `1px solid ${C.line}`, borderRadius: 8, padding: 10, marginBottom: 10 } }, /* @__PURE__ */ React.createElement("input", { type: "password", placeholder: "AIza...", style: { ...inputStyle, marginBottom: 6 }, value: myApiKey, onChange: (e) => saveMyApiKey(e.target.value) }), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 11, color: C.muted } }, "\u0E40\u0E01\u0E47\u0E1A\u0E44\u0E27\u0E49\u0E43\u0E19\u0E40\u0E04\u0E23\u0E37\u0E48\u0E2D\u0E07\u0E19\u0E35\u0E49\u0E40\u0E1E\u0E35\u0E22\u0E07\u0E40\u0E04\u0E23\u0E37\u0E48\u0E2D\u0E07\u0E40\u0E14\u0E35\u0E22\u0E27 \u0E44\u0E21\u0E48\u0E44\u0E14\u0E49\u0E2A\u0E48\u0E07\u0E02\u0E36\u0E49\u0E19 Supabase \u0E2B\u0E23\u0E37\u0E2D\u0E41\u0E0A\u0E23\u0E4C\u0E01\u0E31\u0E1A\u0E40\u0E04\u0E23\u0E37\u0E48\u0E2D\u0E07\u0E2D\u0E37\u0E48\u0E19 \u0E16\u0E49\u0E32\u0E1B\u0E25\u0E48\u0E2D\u0E22\u0E27\u0E48\u0E32\u0E07\u0E44\u0E27\u0E49 \u0E23\u0E30\u0E1A\u0E1A\u0E08\u0E30\u0E43\u0E0A\u0E49 GEMINI_API_KEY \u0E17\u0E35\u0E48\u0E15\u0E31\u0E49\u0E07\u0E44\u0E27\u0E49\u0E1A\u0E19 Vercel \u0E41\u0E17\u0E19")), aiError && /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12, color: C.coral, marginBottom: 8 } }, aiError), aiFilledKeys.length > 0 && !aiError && /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12, color: C.seagrass, marginBottom: 8, fontWeight: 600 } }, "\u2713 AI \u0E01\u0E23\u0E2D\u0E01\u0E04\u0E48\u0E32\u0E43\u0E2B\u0E49\u0E41\u0E25\u0E49\u0E27 ", aiFilledKeys.length, " \u0E1E\u0E32\u0E23\u0E32\u0E21\u0E34\u0E40\u0E15\u0E2D\u0E23\u0E4C \u2014 \u0E15\u0E23\u0E27\u0E08\u0E2A\u0E2D\u0E1A\u0E01\u0E48\u0E2D\u0E19\u0E1A\u0E31\u0E19\u0E17\u0E36\u0E01\u0E14\u0E49\u0E27\u0E22\u0E19\u0E30"), /* @__PURE__ */ React.createElement(Field, { label: "\u0E27\u0E31\u0E19\u0E40\u0E27\u0E25\u0E32" }, /* @__PURE__ */ React.createElement("input", { type: "datetime-local", style: inputStyle, value: when, onChange: (e) => setWhen(e.target.value) })), params.filter((p) => CORE_PARAM_KEYS.includes(p.key)).map((p) => /* @__PURE__ */ React.createElement(Field, { key: p.key, label: `${p.label}${p.unit ? ` (${p.unit})` : ""}`, hint: `\u0E0A\u0E48\u0E27\u0E07\u0E1B\u0E01\u0E15\u0E34 ${p.min}\u2013${p.max}${p.unit}` }, /* @__PURE__ */ React.createElement("input", { type: "number", step: "any", style: { ...inputStyle, ...(aiFilledKeys.includes(p.key) ? { borderColor: C.seagrass, background: "rgba(60,150,110,0.06)" } : {}) }, value: readings[p.key], onChange: (e) => setReadings((r) => ({ ...r, [p.key]: e.target.value })) }))), (() => {
    const extraParams = params.filter((p) => !CORE_PARAM_KEYS.includes(p.key));
    const extraAiFilled = extraParams.filter((p) => aiFilledKeys.includes(p.key)).length;
    return /* @__PURE__ */ React.createElement("div", { style: { marginTop: 4, marginBottom: 10 } }, /* @__PURE__ */ React.createElement("button", { type: "button", onClick: () => setShowExtraParams((v) => !v), style: { width: "100%", textAlign: "left", background: "none", border: `1px dashed ${C.line}`, borderRadius: 8, padding: "8px 10px", cursor: "pointer", fontSize: 12.5, color: extraAiFilled > 0 ? C.seagrass : C.muted, fontWeight: extraAiFilled > 0 ? 700 : 400 } }, showExtraParams ? "\u25BE " : "\u25B8 ", `\u0E04\u0E48\u0E32\u0E40\u0E1E\u0E34\u0E48\u0E21\u0E40\u0E15\u0E34\u0E21 (\u0E04\u0E27\u0E32\u0E21\u0E01\u0E23\u0E30\u0E14\u0E49\u0E32\u0E07/\u0E42\u0E25\u0E2B\u0E30\u0E2B\u0E19\u0E31\u0E01/\u0E04\u0E25\u0E2D\u0E23\u0E35\u0E19/ORP \u0E2F\u0E25\u0E2F \u2014 ${extraParams.length} \u0E23\u0E32\u0E22\u0E01\u0E32\u0E23)${extraAiFilled > 0 ? ` \u2014 AI \u0E01\u0E23\u0E2D\u0E01\u0E43\u0E2B\u0E49 ${extraAiFilled} \u0E0A\u0E48\u0E2D\u0E07` : ""}`), showExtraParams && /* @__PURE__ */ React.createElement("div", { style: { marginTop: 8 } }, extraParams.map((p) => /* @__PURE__ */ React.createElement(Field, { key: p.key, label: `${p.label}${p.unit ? ` (${p.unit})` : ""}`, hint: `\u0E0A\u0E48\u0E27\u0E07\u0E1B\u0E01\u0E15\u0E34 ${p.min}\u2013${p.max}${p.unit}` }, /* @__PURE__ */ React.createElement("input", { type: "number", step: "any", style: { ...inputStyle, ...(aiFilledKeys.includes(p.key) ? { borderColor: C.seagrass, background: "rgba(60,150,110,0.06)" } : {}) }, value: readings[p.key], onChange: (e) => setReadings((r) => ({ ...r, [p.key]: e.target.value })) })))));
  })(), /* @__PURE__ */ React.createElement(Field, { label: "\u0E2B\u0E21\u0E32\u0E22\u0E40\u0E2B\u0E15\u0E38" }, /* @__PURE__ */ React.createElement("textarea", { style: { ...inputStyle, minHeight: 50 }, value: notes, onChange: (e) => setNotes(e.target.value) })), /* @__PURE__ */ React.createElement(Btn, { tone: "seagrass", onClick: submit }, "\u0E1A\u0E31\u0E19\u0E17\u0E36\u0E01\u0E04\u0E48\u0E32\u0E19\u0E49\u0E33")), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 20 } }, /* @__PURE__ */ React.createElement("div", { style: cardStyle }, /* @__PURE__ */ React.createElement(SectionTitle, { sub: latest ? `\u0E2D\u0E31\u0E1B\u0E40\u0E14\u0E15\u0E25\u0E48\u0E32\u0E2A\u0E38\u0E14 ${fmtDate(latest.datetime)}` : "\u0E22\u0E31\u0E07\u0E44\u0E21\u0E48\u0E21\u0E35\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25" }, "\u0E2A\u0E16\u0E32\u0E19\u0E30\u0E04\u0E38\u0E13\u0E20\u0E32\u0E1E\u0E19\u0E49\u0E33"), !latest && /* @__PURE__ */ React.createElement("div", { style: { color: C.muted, fontSize: 13 } }, "\u0E1A\u0E31\u0E19\u0E17\u0E36\u0E01\u0E04\u0E48\u0E32\u0E19\u0E49\u0E33\u0E04\u0E23\u0E31\u0E49\u0E07\u0E41\u0E23\u0E01\u0E40\u0E1E\u0E37\u0E48\u0E2D\u0E40\u0E23\u0E34\u0E48\u0E21\u0E15\u0E34\u0E14\u0E15\u0E32\u0E21"), latest && /* @__PURE__ */ React.createElement("div", { className: "cf-grid-2col", style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 24px" } }, params.map((p) => {
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
function buildFarmContext({ boxes, activeBoxes, emptyBoxes, history, waterLogs, settings, financeTotal, totalBiomass, totalProfit }) {
  const lines = [];
  lines.push("\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E1B\u0E31\u0E08\u0E08\u0E38\u0E1A\u0E31\u0E19\u0E02\u0E2D\u0E07\u0E1F\u0E32\u0E23\u0E4C\u0E21\u0E1B\u0E39\u0E17\u0E30\u0E17\u0E35\u0E48\u0E40\u0E25\u0E35\u0E49\u0E22\u0E07 \u0E13 \u0E27\u0E31\u0E19\u0E17\u0E35\u0E48 " + (/* @__PURE__ */ new Date()).toLocaleDateString("th-TH", { year: "numeric", month: "long", day: "numeric" }) + ":");
  lines.push(`- \u0E01\u0E25\u0E48\u0E2D\u0E07\u0E17\u0E31\u0E49\u0E07\u0E2B\u0E21\u0E14 ${boxes.length} \u0E01\u0E25\u0E48\u0E2D\u0E07 (\u0E01\u0E33\u0E25\u0E31\u0E07\u0E40\u0E25\u0E35\u0E49\u0E22\u0E07 ${activeBoxes.length}, \u0E27\u0E48\u0E32\u0E07 ${emptyBoxes.length})`);
  lines.push(`- \u0E19\u0E49\u0E33\u0E2B\u0E19\u0E31\u0E01\u0E23\u0E27\u0E21\u0E1B\u0E39\u0E17\u0E35\u0E48\u0E40\u0E25\u0E35\u0E49\u0E22\u0E07\u0E2D\u0E22\u0E39\u0E48 (biomass): ${Math.round(totalBiomass)} \u0E01\u0E23\u0E31\u0E21`);
  lines.push(`- \u0E01\u0E33\u0E44\u0E23\u0E2A\u0E30\u0E2A\u0E21\u0E17\u0E31\u0E49\u0E07\u0E2B\u0E21\u0E14 (\u0E08\u0E32\u0E01\u0E1B\u0E39\u0E17\u0E35\u0E48\u0E02\u0E32\u0E22/\u0E15\u0E32\u0E22\u0E44\u0E1B\u0E41\u0E25\u0E49\u0E27): ${Math.round(totalProfit)} \u0E1A\u0E32\u0E17`);
  lines.push(`- \u0E01\u0E33\u0E44\u0E23\u0E1B\u0E23\u0E30\u0E40\u0E21\u0E34\u0E19\u0E23\u0E27\u0E21 (\u0E08\u0E32\u0E01\u0E1B\u0E39\u0E17\u0E35\u0E48\u0E22\u0E31\u0E07\u0E40\u0E25\u0E35\u0E49\u0E22\u0E07\u0E2D\u0E22\u0E39\u0E48 \u0E16\u0E49\u0E32\u0E02\u0E32\u0E22\u0E27\u0E31\u0E19\u0E19\u0E35\u0E49): ${Math.round(financeTotal.profitNow)} \u0E1A\u0E32\u0E17`);
  lines.push(`- \u0E15\u0E49\u0E19\u0E17\u0E38\u0E19\u0E2D\u0E32\u0E2B\u0E32\u0E23\u0E2A\u0E30\u0E2A\u0E21: ${Math.round(financeTotal.feedCostAccrued)} \u0E1A\u0E32\u0E17`);
  const recentDead = history.filter((h) => h.outcome === "dead").slice(-10);
  lines.push(`- \u0E1B\u0E39\u0E15\u0E32\u0E22\u0E2A\u0E30\u0E2A\u0E21 ${history.filter((h) => h.outcome === "dead").length} \u0E15\u0E31\u0E27 (${recentDead.length} \u0E23\u0E32\u0E22\u0E01\u0E32\u0E23\u0E25\u0E48\u0E32\u0E2A\u0E38\u0E14: ${recentDead.map((h) => `\u0E01\u0E25\u0E48\u0E2D\u0E07#${h.boxNumber} \u0E27\u0E31\u0E19\u0E17\u0E35\u0E48 ${h.harvestDate}${h.deathNote ? " (" + h.deathNote + ")" : ""}`).join("; ") || "\u2013"})`);
  const recentHarvest = history.filter((h) => h.outcome !== "dead").slice(-10);
  lines.push(`- \u0E08\u0E31\u0E1A\u0E02\u0E32\u0E22\u0E25\u0E48\u0E32\u0E2A\u0E38\u0E14 ${recentHarvest.length} \u0E23\u0E32\u0E22\u0E01\u0E32\u0E23: ${recentHarvest.map((h) => `\u0E01\u0E25\u0E48\u0E2D\u0E07#${h.boxNumber} ${h.sex === "female" ? "\u0E15\u0E31\u0E27\u0E40\u0E21\u0E35\u0E22" : "\u0E15\u0E31\u0E27\u0E1C\u0E39\u0E49"} \u0E19\u0E49\u0E33\u0E2B\u0E19\u0E31\u0E01 ${h.weight}\u0E01. \u0E01\u0E33\u0E44\u0E23 ${h.profit != null ? Math.round(h.profit) : "?"}\u0E1A.`).join("; ") || "\u2013"}`);
  const recentWater = [...waterLogs].sort((a, b) => new Date(b.datetime) - new Date(a.datetime)).slice(0, 5);
  if (recentWater.length) {
    lines.push("- \u0E04\u0E48\u0E32\u0E19\u0E49\u0E33\u0E17\u0E35\u0E48\u0E1A\u0E31\u0E19\u0E17\u0E36\u0E01\u0E25\u0E48\u0E32\u0E2A\u0E38\u0E14 (\u0E43\u0E2B\u0E21\u0E48\u2192\u0E40\u0E01\u0E48\u0E32):");
    recentWater.forEach((w) => {
      const parts = settings.parameters.filter((p) => w.readings[p.key] !== void 0 && w.readings[p.key] !== "").map((p) => {
        const v = Number(w.readings[p.key]);
        const flag = v < p.min || v > p.max ? " \u26A0\uFE0F\u0E1C\u0E34\u0E14\u0E0A\u0E48\u0E27\u0E07\u0E1B\u0E01\u0E15\u0E34" : "";
        return `${p.label}=${v}${p.unit}${flag}`;
      });
      lines.push(`  \u2022 ${w.datetime}: ${parts.join(", ")}${w.notes ? " (\u0E2B\u0E21\u0E32\u0E22\u0E40\u0E2B\u0E15\u0E38: " + w.notes + ")" : ""}`);
    });
  } else {
    lines.push("- \u0E22\u0E31\u0E07\u0E44\u0E21\u0E48\u0E21\u0E35\u0E01\u0E32\u0E23\u0E1A\u0E31\u0E19\u0E17\u0E36\u0E01\u0E04\u0E38\u0E13\u0E20\u0E32\u0E1E\u0E19\u0E49\u0E33");
  }
  return lines.join("\n");
}
function AiAssistantTab({ boxes, activeBoxes, emptyBoxes, history, waterLogs, settings, financeTotal, totalBiomass, totalProfit }) {
  const [report, setReport] = useState("");
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState("");
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const SYMPTOM_OPTIONS = [
    { key: "dead", label: "\u0E1B\u0E39\u0E15\u0E32\u0E22\u0E1C\u0E34\u0E14\u0E1B\u0E01\u0E15\u0E34/\u0E15\u0E32\u0E22\u0E40\u0E22\u0E2D\u0E30" },
    { key: "limbLoss", label: "\u0E41\u0E02\u0E19/\u0E01\u0E49\u0E32\u0E21\u0E2B\u0E25\u0E38\u0E14\u0E07\u0E48\u0E32\u0E22" },
    { key: "moltFail", label: "\u0E25\u0E2D\u0E01\u0E04\u0E23\u0E32\u0E1A\u0E44\u0E21\u0E48\u0E2A\u0E33\u0E40\u0E23\u0E47\u0E08/\u0E44\u0E21\u0E48\u0E04\u0E23\u0E1A" },
    { key: "softShell", label: "\u0E40\u0E1B\u0E25\u0E37\u0E2D\u0E01\u0E19\u0E34\u0E48\u0E21\u0E19\u0E32\u0E19\u0E1C\u0E34\u0E14\u0E1B\u0E01\u0E15\u0E34" },
    { key: "lowAppetite", label: "\u0E01\u0E34\u0E19\u0E2D\u0E32\u0E2B\u0E32\u0E23\u0E19\u0E49\u0E2D\u0E22\u0E25\u0E07/\u0E0B\u0E36\u0E21" },
    { key: "slowGrowth", label: "\u0E42\u0E15\u0E0A\u0E49\u0E32\u0E01\u0E27\u0E48\u0E32\u0E1B\u0E01\u0E15\u0E34" }
  ];
  const [symptoms, setSymptoms] = useState([]);
  const [symptomNote, setSymptomNote] = useState("");
  const [diagnosis, setDiagnosis] = useState("");
  const [diagnosisLoading, setDiagnosisLoading] = useState(false);
  const [diagnosisError, setDiagnosisError] = useState("");
  const toggleSymptom = (key) => {
    setSymptoms((s) => s.includes(key) ? s.filter((k) => k !== key) : [...s, key]);
  };
  const getApiKey = () => {
    try {
      return localStorage.getItem("cf_gemini_api_key") || "";
    } catch {
      return "";
    }
  };
  const callAi = async (message) => {
    const response = await fetch("/api/ai-chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, apiKeyOverride: getApiKey() || void 0 })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "\u0E40\u0E23\u0E35\u0E22\u0E01 API \u0E44\u0E21\u0E48\u0E2A\u0E33\u0E40\u0E23\u0E47\u0E08");
    if (!data.text) throw new Error("\u0E44\u0E21\u0E48\u0E44\u0E14\u0E49\u0E23\u0E31\u0E1A\u0E1C\u0E25\u0E25\u0E31\u0E1E\u0E18\u0E4C\u0E08\u0E32\u0E01 AI");
    return data.text;
  };
  const generateReport = async () => {
    setReportLoading(true);
    setReportError("");
    try {
      const context = buildFarmContext({ boxes, activeBoxes, emptyBoxes, history, waterLogs, settings, financeTotal, totalBiomass, totalProfit });
      const prompt = `${context}

\u0E0A\u0E48\u0E27\u0E22\u0E2A\u0E23\u0E38\u0E1B\u0E2A\u0E16\u0E32\u0E19\u0E30\u0E1F\u0E32\u0E23\u0E4C\u0E21\u0E1B\u0E39\u0E19\u0E35\u0E49\u0E43\u0E2B\u0E49\u0E2B\u0E19\u0E48\u0E2D\u0E22 \u0E40\u0E1B\u0E47\u0E19\u0E20\u0E32\u0E29\u0E32\u0E1E\u0E39\u0E14\u0E2D\u0E48\u0E32\u0E19\u0E07\u0E48\u0E32\u0E22 \u0E2A\u0E31\u0E49\u0E19 \u0E01\u0E23\u0E30\u0E0A\u0E31\u0E1A \u0E44\u0E21\u0E48\u0E15\u0E49\u0E2D\u0E07\u0E17\u0E27\u0E19\u0E15\u0E31\u0E27\u0E40\u0E25\u0E02\u0E17\u0E35\u0E48\u0E43\u0E2B\u0E49\u0E44\u0E1B\u0E41\u0E25\u0E49\u0E27 \u0E40\u0E19\u0E49\u0E19\u0E08\u0E38\u0E14\u0E17\u0E35\u0E48\u0E04\u0E27\u0E23\u0E23\u0E30\u0E27\u0E31\u0E07\u0E2B\u0E23\u0E37\u0E2D\u0E04\u0E27\u0E23\u0E17\u0E33\u0E2D\u0E30\u0E44\u0E23\u0E15\u0E48\u0E2D \u0E16\u0E49\u0E32\u0E44\u0E21\u0E48\u0E21\u0E35\u0E2D\u0E30\u0E44\u0E23\u0E19\u0E48\u0E32\u0E01\u0E31\u0E07\u0E27\u0E25\u0E01\u0E47\u0E1A\u0E2D\u0E01\u0E27\u0E48\u0E32\u0E42\u0E2D\u0E40\u0E04 \u0E15\u0E2D\u0E1A\u0E40\u0E1B\u0E47\u0E19\u0E02\u0E49\u0E2D 3-6 \u0E02\u0E49\u0E2D`;
      const text = await callAi(prompt);
      setReport(text);
    } catch (err) {
      setReportError((err && err.message) || String(err));
    } finally {
      setReportLoading(false);
    }
  };
  const runDiagnosis = async () => {
    if (symptoms.length === 0 && !symptomNote.trim()) return;
    setDiagnosisLoading(true);
    setDiagnosisError("");
    try {
      const context = buildFarmContext({ boxes, activeBoxes, emptyBoxes, history, waterLogs, settings, financeTotal, totalBiomass, totalProfit });
      const symptomLabels = SYMPTOM_OPTIONS.filter((o) => symptoms.includes(o.key)).map((o) => o.label);
      const mineralList = (settings.minerals || []).map((m) => `- ${m.name}${m.note ? " (" + m.note + ")" : ""}`).join("\n") || "\u2013";
      const prompt = `${context}

\u0E41\u0E23\u0E48\u0E18\u0E32\u0E15\u0E38/\u0E2A\u0E32\u0E23\u0E17\u0E35\u0E48\u0E21\u0E35\u0E2D\u0E22\u0E39\u0E48\u0E43\u0E19\u0E1F\u0E32\u0E23\u0E4C\u0E21\u0E2A\u0E33\u0E2B\u0E23\u0E31\u0E1A\u0E1B\u0E23\u0E31\u0E1A\u0E2A\u0E20\u0E32\u0E1E\u0E19\u0E49\u0E33\u0E17\u0E30\u0E40\u0E25\u0E40\u0E17\u0E35\u0E22\u0E21:
${mineralList}

\u0E2D\u0E32\u0E01\u0E32\u0E23\u0E17\u0E35\u0E48\u0E1E\u0E1A: ${symptomLabels.join(", ") || "\u2013"}
${symptomNote.trim() ? "\u0E23\u0E32\u0E22\u0E25\u0E30\u0E40\u0E2D\u0E35\u0E22\u0E14\u0E40\u0E1E\u0E34\u0E48\u0E21\u0E40\u0E15\u0E34\u0E21\u0E08\u0E32\u0E01\u0E1C\u0E39\u0E49\u0E43\u0E0A\u0E49: " + symptomNote.trim() : ""}

\u0E04\u0E38\u0E13\u0E04\u0E37\u0E2D\u0E1C\u0E39\u0E49\u0E40\u0E0A\u0E35\u0E48\u0E22\u0E27\u0E0A\u0E32\u0E0D\u0E14\u0E49\u0E32\u0E19\u0E01\u0E32\u0E23\u0E40\u0E25\u0E35\u0E49\u0E22\u0E07\u0E1B\u0E39\u0E17\u0E30/\u0E2A\u0E31\u0E15\u0E27\u0E4C\u0E19\u0E49\u0E33\u0E01\u0E23\u0E30\u0E14\u0E2D\u0E07 \u0E0A\u0E48\u0E27\u0E22\u0E27\u0E34\u0E40\u0E04\u0E23\u0E32\u0E30\u0E2B\u0E4C\u0E27\u0E48\u0E32\u0E2D\u0E32\u0E01\u0E32\u0E23\u0E17\u0E35\u0E48\u0E1E\u0E1A\u0E19\u0E48\u0E32\u0E08\u0E30\u0E40\u0E01\u0E34\u0E14\u0E08\u0E32\u0E01\u0E2A\u0E32\u0E40\u0E2B\u0E15\u0E38\u0E43\u0E14\u0E44\u0E14\u0E49\u0E1A\u0E49\u0E32\u0E07 (\u0E40\u0E0A\u0E48\u0E19 \u0E02\u0E32\u0E14\u0E41\u0E04\u0E25\u0E40\u0E0B\u0E35\u0E22\u0E21/\u0E41\u0E21\u0E01\u0E19\u0E35\u0E40\u0E0B\u0E35\u0E22\u0E21\u0E2A\u0E33\u0E2B\u0E23\u0E31\u0E1A\u0E25\u0E2D\u0E01\u0E04\u0E23\u0E32\u0E1A \u0E04\u0E38\u0E13\u0E20\u0E32\u0E1E\u0E19\u0E49\u0E33\u0E44\u0E21\u0E48\u0E14\u0E35 \u0E42\u0E23\u0E04 \u0E2F\u0E25\u0E2F) \u0E41\u0E25\u0E49\u0E27\u0E41\u0E19\u0E30\u0E19\u0E33\u0E27\u0E48\u0E32\u0E08\u0E32\u0E01\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23\u0E41\u0E23\u0E48\u0E18\u0E32\u0E15\u0E38\u0E17\u0E35\u0E48\u0E21\u0E35\u0E2D\u0E22\u0E39\u0E48\u0E08\u0E23\u0E34\u0E07\u0E14\u0E49\u0E32\u0E19\u0E1A\u0E19 \u0E04\u0E27\u0E23\u0E40\u0E15\u0E34\u0E21\u0E15\u0E31\u0E27\u0E44\u0E2B\u0E19\u0E1A\u0E49\u0E32\u0E07 \u0E42\u0E14\u0E22\u0E15\u0E2D\u0E1A\u0E40\u0E1B\u0E47\u0E19\u0E02\u0E49\u0E2D ๆ:
1) \u0E2A\u0E32\u0E40\u0E2B\u0E15\u0E38\u0E17\u0E35\u0E48\u0E40\u0E1B\u0E47\u0E19\u0E44\u0E1B\u0E44\u0E14\u0E49 (\u0E40\u0E23\u0E35\u0E22\u0E07\u0E15\u0E32\u0E21\u0E19\u0E49\u0E33\u0E2B\u0E19\u0E31\u0E01\u0E04\u0E27\u0E32\u0E21\u0E40\u0E1B\u0E47\u0E19\u0E44\u0E1B\u0E44\u0E14\u0E49)
2) \u0E04\u0E27\u0E23\u0E40\u0E15\u0E34\u0E21\u0E41\u0E23\u0E48\u0E18\u0E32\u0E15\u0E38\u0E15\u0E31\u0E27\u0E44\u0E2B\u0E19\u0E08\u0E32\u0E01\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23\u0E02\u0E49\u0E32\u0E07\u0E15\u0E49\u0E19 (\u0E23\u0E30\u0E1A\u0E38\u0E0A\u0E37\u0E48\u0E2D\u0E0A\u0E31\u0E14 \u0E16\u0E49\u0E32\u0E44\u0E21\u0E48\u0E21\u0E35\u0E15\u0E31\u0E27\u0E17\u0E35\u0E48\u0E40\u0E2B\u0E21\u0E32\u0E30\u0E2A\u0E21\u0E43\u0E19\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23\u0E43\u0E2B\u0E49\u0E1A\u0E2D\u0E01\u0E15\u0E23\u0E07\u0E46 \u0E27\u0E48\u0E32\u0E44\u0E21\u0E48\u0E21\u0E35)
3) \u0E27\u0E34\u0E18\u0E35\u0E40\u0E15\u0E34\u0E21\u0E41\u0E1A\u0E1A\u0E04\u0E23\u0E48\u0E32\u0E27\u0E46 \u0E40\u0E0A\u0E48\u0E19 \u0E04\u0E27\u0E23\u0E17\u0E22\u0E2D\u0E22\u0E17\u0E35\u0E25\u0E30\u0E19\u0E49\u0E2D\u0E22\u0E41\u0E25\u0E49\u0E27\u0E27\u0E31\u0E14\u0E04\u0E48\u0E32\u0E0B\u0E49\u0E33\u0E01\u0E48\u0E2D\u0E19\u0E40\u0E15\u0E34\u0E21\u0E23\u0E2D\u0E1A\u0E15\u0E48\u0E2D\u0E44\u0E1B
4) \u0E02\u0E49\u0E2D\u0E04\u0E27\u0E23\u0E23\u0E30\u0E27\u0E31\u0E07/\u0E02\u0E49\u0E2D\u0E08\u0E33\u0E01\u0E31\u0E14
\u0E22\u0E49\u0E33\u0E27\u0E48\u0E32\u0E19\u0E35\u0E48\u0E44\u0E21\u0E48\u0E43\u0E0A\u0E48\u0E04\u0E33\u0E41\u0E19\u0E30\u0E19\u0E33\u0E17\u0E32\u0E07\u0E01\u0E32\u0E23\u0E41\u0E1E\u0E17\u0E22\u0E4C\u0E17\u0E35\u0E48\u0E41\u0E21\u0E48\u0E19\u0E22\u0E33 100% \u0E40\u0E1B\u0E47\u0E19\u0E41\u0E19\u0E27\u0E17\u0E32\u0E07\u0E40\u0E1A\u0E37\u0E49\u0E2D\u0E07\u0E15\u0E49\u0E19\u0E40\u0E17\u0E48\u0E32\u0E19\u0E31\u0E49\u0E19 \u0E15\u0E49\u0E2D\u0E07\u0E04\u0E48\u0E2D\u0E22\u0E46\u0E17\u0E14\u0E25\u0E2D\u0E07\u0E41\u0E25\u0E30\u0E27\u0E31\u0E14\u0E04\u0E48\u0E32\u0E0B\u0E49\u0E33`;
      const text = await callAi(prompt);
      setDiagnosis(text);
    } catch (err) {
      setDiagnosisError((err && err.message) || String(err));
    } finally {
      setDiagnosisLoading(false);
    }
  };
  const sendChat = async () => {
    const question = input.trim();
    if (!question || chatLoading) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", text: question }]);
    setChatLoading(true);
    try {
      const context = buildFarmContext({ boxes, activeBoxes, emptyBoxes, history, waterLogs, settings, financeTotal, totalBiomass, totalProfit });
      const prompt = `\u0E04\u0E38\u0E13\u0E04\u0E37\u0E2D\u0E1C\u0E39\u0E49\u0E0A\u0E48\u0E27\u0E22\u0E14\u0E39\u0E41\u0E25\u0E1F\u0E32\u0E23\u0E4C\u0E21\u0E40\u0E25\u0E35\u0E49\u0E22\u0E07\u0E1B\u0E39\u0E17\u0E30 \u0E15\u0E2D\u0E1A\u0E04\u0E33\u0E16\u0E32\u0E21\u0E42\u0E14\u0E22\u0E2D\u0E49\u0E32\u0E07\u0E2D\u0E34\u0E07\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E08\u0E23\u0E34\u0E07\u0E02\u0E2D\u0E07\u0E1F\u0E32\u0E23\u0E4C\u0E21\u0E19\u0E35\u0E49 \u0E15\u0E2D\u0E1A\u0E2A\u0E31\u0E49\u0E19 \u0E01\u0E23\u0E30\u0E0A\u0E31\u0E1A \u0E40\u0E1B\u0E47\u0E19\u0E01\u0E31\u0E19\u0E40\u0E2D\u0E07:

${context}

\u0E04\u0E33\u0E16\u0E32\u0E21\u0E08\u0E32\u0E01\u0E1C\u0E39\u0E49\u0E43\u0E0A\u0E49\u0E07\u0E32\u0E19: ${question}`;
      const text = await callAi(prompt);
      setMessages((m) => [...m, { role: "ai", text }]);
    } catch (err) {
      setMessages((m) => [...m, { role: "ai", text: `\u274C \u0E40\u0E01\u0E34\u0E14\u0E02\u0E49\u0E2D\u0E1C\u0E34\u0E14\u0E1E\u0E25\u0E32\u0E14: ${(err && err.message) || err}` }]);
    } finally {
      setChatLoading(false);
    }
  };
  return /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 20 } }, /* @__PURE__ */ React.createElement("div", { style: cardStyle }, /* @__PURE__ */ React.createElement(SectionTitle, { sub: "\u0E43\u0E2B\u0E49 AI \u0E2D\u0E48\u0E32\u0E19\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E01\u0E25\u0E48\u0E2D\u0E07\u0E1B\u0E39+\u0E01\u0E32\u0E23\u0E40\u0E07\u0E34\u0E19+\u0E04\u0E38\u0E13\u0E20\u0E32\u0E1E\u0E19\u0E49\u0E33\u0E17\u0E35\u0E48\u0E21\u0E35\u0E2D\u0E22\u0E39\u0E48\u0E43\u0E19\u0E23\u0E30\u0E1A\u0E1A \u0E41\u0E25\u0E49\u0E27\u0E2A\u0E23\u0E38\u0E1B\u0E43\u0E2B\u0E49\u0E2D\u0E48\u0E32\u0E19\u0E07\u0E48\u0E32\u0E22" }, "\u{1F4CA} \u0E2A\u0E23\u0E38\u0E1B\u0E2A\u0E16\u0E32\u0E19\u0E30\u0E1F\u0E32\u0E23\u0E4C\u0E21\u0E42\u0E14\u0E22 AI"), /* @__PURE__ */ React.createElement(Btn, { tone: "coral", disabled: reportLoading, onClick: generateReport }, reportLoading ? "\u{1F504} AI \u0E01\u0E33\u0E25\u0E31\u0E07\u0E27\u0E34\u0E40\u0E04\u0E23\u0E32\u0E30\u0E2B\u0E4C\u2026" : "\u2728 \u0E43\u0E2B\u0E49 AI \u0E2A\u0E23\u0E38\u0E1B\u0E15\u0E2D\u0E19\u0E19\u0E35\u0E49"), reportError && /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12.5, color: C.coral, marginTop: 8 } }, reportError), report && /* @__PURE__ */ React.createElement("div", { style: { marginTop: 14, padding: 14, background: "rgba(60,150,110,0.06)", border: `1px solid ${C.line}`, borderRadius: 10, fontSize: 13.5, lineHeight: 1.75, whiteSpace: "pre-wrap" } }, report)), /* @__PURE__ */ React.createElement("div", { style: cardStyle }, /* @__PURE__ */ React.createElement(SectionTitle, { sub: "\u0E40\u0E25\u0E37\u0E2D\u0E01\u0E2D\u0E32\u0E01\u0E32\u0E23\u0E17\u0E35\u0E48\u0E1E\u0E1A \u0E41\u0E25\u0E49\u0E27\u0E43\u0E2B\u0E49 AI \u0E41\u0E19\u0E30\u0E19\u0E33\u0E27\u0E48\u0E32\u0E04\u0E27\u0E23\u0E40\u0E15\u0E34\u0E21\u0E41\u0E23\u0E48\u0E18\u0E32\u0E15\u0E38\u0E15\u0E31\u0E27\u0E44\u0E2B\u0E19 \u0E08\u0E32\u0E01\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23\u0E17\u0E35\u0E48\u0E15\u0E31\u0E49\u0E07\u0E04\u0E48\u0E32\u0E44\u0E27\u0E49\u0E43\u0E19 \u0E15\u0E31\u0E49\u0E07\u0E04\u0E48\u0E32" }, "\u{1FA7A} \u0E27\u0E34\u0E19\u0E34\u0E08\u0E09\u0E31\u0E22\u0E1B\u0E31\u0E0D\u0E2B\u0E32\u0E1B\u0E39 & \u0E41\u0E19\u0E30\u0E19\u0E33\u0E01\u0E32\u0E23\u0E40\u0E15\u0E34\u0E21\u0E41\u0E23\u0E48\u0E18\u0E32\u0E15\u0E38"), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 } }, SYMPTOM_OPTIONS.map((o) => /* @__PURE__ */ React.createElement("button", { key: o.key, type: "button", onClick: () => toggleSymptom(o.key), style: { padding: "7px 12px", borderRadius: 20, fontSize: 12.5, cursor: "pointer", border: `1.5px solid ${symptoms.includes(o.key) ? C.coral : C.line}`, background: symptoms.includes(o.key) ? "rgba(226,96,58,0.1)" : "#fff", color: symptoms.includes(o.key) ? C.coral : C.text, fontWeight: symptoms.includes(o.key) ? 700 : 400 } }, o.label))), /* @__PURE__ */ React.createElement("textarea", { style: { ...inputStyle, minHeight: 60, resize: "vertical", marginBottom: 10 }, placeholder: "\u0E23\u0E32\u0E22\u0E25\u0E30\u0E40\u0E2D\u0E35\u0E22\u0E14\u0E40\u0E1E\u0E34\u0E48\u0E21\u0E40\u0E15\u0E34\u0E21 (\u0E16\u0E49\u0E32\u0E21\u0E35) \u0E40\u0E0A\u0E48\u0E19 \u0E40\u0E01\u0E34\u0E14\u0E01\u0E31\u0E1A\u0E1B\u0E39\u0E01\u0E35\u0E48\u0E15\u0E31\u0E27 \u0E19\u0E32\u0E19\u0E01\u0E35\u0E48\u0E27\u0E31\u0E19\u0E41\u0E25\u0E49\u0E27", value: symptomNote, onChange: (e) => setSymptomNote(e.target.value) }), /* @__PURE__ */ React.createElement(Btn, { tone: "coral", disabled: diagnosisLoading || symptoms.length === 0 && !symptomNote.trim(), onClick: runDiagnosis }, diagnosisLoading ? "\u{1F504} AI \u0E01\u0E33\u0E25\u0E31\u0E07\u0E27\u0E34\u0E19\u0E34\u0E08\u0E09\u0E31\u0E22\u2026" : "\u{1FA7A} \u0E27\u0E34\u0E19\u0E34\u0E08\u0E09\u0E31\u0E22\u0E41\u0E25\u0E30\u0E41\u0E19\u0E30\u0E19\u0E33"), diagnosisError && /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12.5, color: C.coral, marginTop: 8 } }, diagnosisError), diagnosis && /* @__PURE__ */ React.createElement("div", { style: { marginTop: 14, padding: 14, background: "rgba(226,96,58,0.06)", border: `1px solid ${C.line}`, borderRadius: 10, fontSize: 13.5, lineHeight: 1.75, whiteSpace: "pre-wrap" } }, diagnosis)), /* @__PURE__ */ React.createElement("div", { style: cardStyle }, /* @__PURE__ */ React.createElement(SectionTitle, { sub: "\u0E16\u0E32\u0E21\u0E44\u0E14\u0E49\u0E17\u0E38\u0E01\u0E40\u0E23\u0E37\u0E48\u0E2D\u0E07\u0E40\u0E01\u0E35\u0E48\u0E22\u0E27\u0E01\u0E31\u0E1A\u0E1F\u0E32\u0E23\u0E4C\u0E21\u0E1B\u0E39\u0E02\u0E2D\u0E07\u0E04\u0E38\u0E13 AI \u0E08\u0E30\u0E14\u0E36\u0E07\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E08\u0E23\u0E34\u0E07\u0E43\u0E19\u0E23\u0E30\u0E1A\u0E1A\u0E21\u0E32\u0E15\u0E2D\u0E1A" }, "\u{1F4AC} \u0E41\u0E0A\u0E17\u0E01\u0E31\u0E1A AI \u0E1C\u0E39\u0E49\u0E0A\u0E48\u0E27\u0E22\u0E1F\u0E32\u0E23\u0E4C\u0E21"), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 10, maxHeight: 420, overflowY: "auto", marginBottom: 12, padding: messages.length ? 4 : 0 } }, messages.length === 0 && /* @__PURE__ */ React.createElement("div", { style: { fontSize: 13, color: C.muted } }, '\u0E25\u0E2D\u0E07\u0E16\u0E32\u0E21\u0E14\u0E39 \u0E40\u0E0A\u0E48\u0E19 "\u0E17\u0E33\u0E44\u0E21\u0E1B\u0E39\u0E15\u0E32\u0E22\u0E40\u0E22\u0E2D\u0E30\u0E0A\u0E48\u0E27\u0E07\u0E19\u0E35\u0E49" \u0E2B\u0E23\u0E37\u0E2D "\u0E04\u0E38\u0E13\u0E20\u0E32\u0E1E\u0E19\u0E49\u0E33\u0E15\u0E2D\u0E19\u0E19\u0E35\u0E49\u0E42\u0E2D\u0E40\u0E04\u0E44\u0E2B\u0E21"'), messages.map((m, i) => /* @__PURE__ */ React.createElement("div", { key: i, style: { alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "85%", background: m.role === "user" ? C.ink : "rgba(60,150,110,0.08)", color: m.role === "user" ? "#fff" : C.text, borderRadius: 12, padding: "8px 12px", fontSize: 13.5, lineHeight: 1.6, whiteSpace: "pre-wrap" } }, m.text)), chatLoading && /* @__PURE__ */ React.createElement("div", { style: { alignSelf: "flex-start", fontSize: 12.5, color: C.muted } }, "\u{1F504} AI \u0E01\u0E33\u0E25\u0E31\u0E07\u0E1E\u0E34\u0E21\u0E1E\u0E4C\u2026")), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 8 } }, /* @__PURE__ */ React.createElement("input", { style: { ...inputStyle, flex: 1 }, placeholder: "\u0E1E\u0E34\u0E21\u0E1E\u0E4C\u0E04\u0E33\u0E16\u0E32\u0E21\u2026", value: input, onChange: (e) => setInput(e.target.value), onKeyDown: (e) => {
    if (e.key === "Enter") sendChat();
  } }), /* @__PURE__ */ React.createElement(Btn, { tone: "coral", disabled: chatLoading || !input.trim(), onClick: sendChat }, "\u0E2A\u0E48\u0E07"))));
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
  const setMineral = (i, field, val) => {
    const minerals = [...(s.minerals || [])];
    minerals[i] = { ...minerals[i], [field]: val };
    setS({ ...s, minerals });
  };
  const addMineral = () => {
    setS({ ...s, minerals: [...(s.minerals || []), { key: uid(), name: "", note: "" }] });
  };
  const removeMineral = (i) => {
    const minerals = [...(s.minerals || [])];
    minerals.splice(i, 1);
    setS({ ...s, minerals });
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
  )), /* @__PURE__ */ React.createElement(Field, { label: "\u0E08\u0E33\u0E19\u0E27\u0E19\u0E0A\u0E48\u0E2D\u0E07\u0E15\u0E48\u0E2D\u0E41\u0E16\u0E27" }, /* @__PURE__ */ React.createElement("input", { type: "number", min: "1", style: inputStyle, value: s.layoutSlotsPerRow, onChange: (e) => setS({ ...s, layoutSlotsPerRow: Number(e.target.value) }) })))), /* @__PURE__ */ React.createElement("div", { style: cardStyle }, /* @__PURE__ */ React.createElement(SectionTitle, null, "\u0E04\u0E48\u0E32\u0E17\u0E31\u0E48\u0E27\u0E44\u0E1B\u0E02\u0E2D\u0E07\u0E23\u0E30\u0E1A\u0E1A"), /* @__PURE__ */ React.createElement("div", { className: "cf-grid-3col", style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0 16px" } }, /* @__PURE__ */ React.createElement(Field, { label: "\u0E1B\u0E23\u0E34\u0E21\u0E32\u0E15\u0E23\u0E19\u0E49\u0E33\u0E43\u0E19\u0E23\u0E30\u0E1A\u0E1A (\u0E25\u0E34\u0E15\u0E23)" }, /* @__PURE__ */ React.createElement("input", { type: "number", style: inputStyle, value: s.tankVolumeLiters, onChange: (e) => setS({ ...s, tankVolumeLiters: Number(e.target.value) }) })), /* @__PURE__ */ React.createElement(Field, { label: "\u0E2D\u0E31\u0E15\u0E23\u0E32\u0E01\u0E32\u0E23\u0E43\u0E2B\u0E49\u0E2D\u0E32\u0E2B\u0E32\u0E23\u0E40\u0E23\u0E34\u0E48\u0E21\u0E15\u0E49\u0E19 (%)" }, /* @__PURE__ */ React.createElement("input", { type: "number", style: inputStyle, value: s.feedRatePercent, onChange: (e) => setS({ ...s, feedRatePercent: Number(e.target.value) }) })), /* @__PURE__ */ React.createElement(Field, { label: "\u0E40\u0E15\u0E37\u0E2D\u0E19\u0E15\u0E23\u0E27\u0E08\u0E25\u0E2D\u0E01\u0E04\u0E23\u0E32\u0E1A\u0E2B\u0E32\u0E01\u0E40\u0E01\u0E34\u0E19 (\u0E27\u0E31\u0E19)" }, /* @__PURE__ */ React.createElement("input", { type: "number", style: inputStyle, value: s.moltReminderDays, onChange: (e) => setS({ ...s, moltReminderDays: Number(e.target.value) }) })), /* @__PURE__ */ React.createElement(Field, { label: "\u0E19\u0E49\u0E33\u0E2B\u0E19\u0E31\u0E01\u0E40\u0E1E\u0E34\u0E48\u0E21\u0E02\u0E31\u0E49\u0E19\u0E15\u0E48\u0E33/\u0E04\u0E23\u0E31\u0E49\u0E07\u0E25\u0E2D\u0E01\u0E04\u0E23\u0E32\u0E1A (%)", hint: "\u0E43\u0E0A\u0E49\u0E40\u0E17\u0E35\u0E22\u0E1A\u0E01\u0E31\u0E1A\u0E19\u0E49\u0E33\u0E2B\u0E19\u0E31\u0E01\u0E01\u0E48\u0E2D\u0E19\u0E25\u0E2D\u0E01\u0E04\u0E23\u0E32\u0E1A\u0E41\u0E15\u0E48\u0E25\u0E30\u0E04\u0E23\u0E31\u0E49\u0E07" }, /* @__PURE__ */ React.createElement("input", { type: "number", step: "0.5", min: "0", style: inputStyle, value: s.moltStandardGrowthPercent, onChange: (e) => setS({ ...s, moltStandardGrowthPercent: Number(e.target.value) }) })))), /* @__PURE__ */ React.createElement("div", { style: cardStyle }, /* @__PURE__ */ React.createElement(SectionTitle, { sub: "\u0E1B\u0E23\u0E31\u0E1A\u0E0A\u0E48\u0E27\u0E07\u0E04\u0E48\u0E32\u0E1B\u0E01\u0E15\u0E34\u0E41\u0E25\u0E30\u0E15\u0E31\u0E27\u0E04\u0E39\u0E13\u0E04\u0E33\u0E19\u0E27\u0E13\u0E42\u0E14\u0E2A\u0E43\u0E2B\u0E49\u0E15\u0E23\u0E07\u0E01\u0E31\u0E1A\u0E1C\u0E25\u0E34\u0E15\u0E20\u0E31\u0E13\u0E11\u0E4C\u0E08\u0E23\u0E34\u0E07\u0E17\u0E35\u0E48\u0E43\u0E0A\u0E49\u0E43\u0E19\u0E1F\u0E32\u0E23\u0E4C\u0E21" }, "\u0E1E\u0E32\u0E23\u0E32\u0E21\u0E34\u0E40\u0E15\u0E2D\u0E23\u0E4C\u0E04\u0E38\u0E13\u0E20\u0E32\u0E1E\u0E19\u0E49\u0E33"), /* @__PURE__ */ React.createElement("div", { style: { overflowX: "auto" } }, /* @__PURE__ */ React.createElement("table", { style: tableStyle }, /* @__PURE__ */ React.createElement("thead", null, /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E1E\u0E32\u0E23\u0E32\u0E21\u0E34\u0E40\u0E15\u0E2D\u0E23\u0E4C"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E2B\u0E19\u0E48\u0E27\u0E22"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E15\u0E48\u0E33\u0E2A\u0E38\u0E14"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E40\u0E1B\u0E49\u0E32\u0E2B\u0E21\u0E32\u0E22"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E2A\u0E39\u0E07\u0E2A\u0E38\u0E14"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E15\u0E31\u0E27\u0E04\u0E39\u0E13\u0E42\u0E14\u0E2A"))), /* @__PURE__ */ React.createElement("tbody", null, s.parameters.map((p, i) => /* @__PURE__ */ React.createElement("tr", { key: p.key }, /* @__PURE__ */ React.createElement("td", { style: tdStyle }, p.label), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, p.unit || "\u2014"), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, /* @__PURE__ */ React.createElement("input", { type: "number", style: { ...inputStyle, width: 70 }, value: p.min, onChange: (e) => setParam(i, "min", Number(e.target.value)) })), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, /* @__PURE__ */ React.createElement("input", { type: "number", style: { ...inputStyle, width: 70 }, value: p.target, onChange: (e) => setParam(i, "target", Number(e.target.value)) })), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, /* @__PURE__ */ React.createElement("input", { type: "number", style: { ...inputStyle, width: 70 }, value: p.max, onChange: (e) => setParam(i, "max", Number(e.target.value)) })), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, p.dosable ? /* @__PURE__ */ React.createElement("input", { type: "number", step: "0.001", style: { ...inputStyle, width: 80 }, value: p.doseFactor, onChange: (e) => setParam(i, "doseFactor", Number(e.target.value)) }) : "\u2014"))))))), /* @__PURE__ */ React.createElement("div", { style: cardStyle }, /* @__PURE__ */ React.createElement(SectionTitle, { sub: "\u0E43\u0E0A\u0E49\u0E14\u0E36\u0E07\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E2A\u0E20\u0E32\u0E1E\u0E2D\u0E32\u0E01\u0E32\u0E28\u0E43\u0E19\u0E41\u0E17\u0E47\u0E1A \u0E19\u0E49\u0E33 / \u0E1B\u0E31\u0E4A\u0E21" }, "\u0E15\u0E33\u0E41\u0E2B\u0E19\u0E48\u0E07\u0E1F\u0E32\u0E23\u0E4C\u0E21"), /* @__PURE__ */ React.createElement("div", { className: "cf-grid-3col", style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0 16px" } }, /* @__PURE__ */ React.createElement(Field, { label: "\u0E0A\u0E37\u0E48\u0E2D\u0E2A\u0E16\u0E32\u0E19\u0E17\u0E35\u0E48/\u0E08\u0E31\u0E07\u0E2B\u0E27\u0E31\u0E14" }, /* @__PURE__ */ React.createElement("input", { style: inputStyle, value: s.farmLocationName || "", onChange: (e) => setS({ ...s, farmLocationName: e.target.value }) })), /* @__PURE__ */ React.createElement(Field, { label: "\u0E25\u0E30\u0E15\u0E34\u0E08\u0E39\u0E14 (lat)" }, /* @__PURE__ */ React.createElement("input", { type: "number", step: "any", style: inputStyle, value: s.farmLat, onChange: (e) => setS({ ...s, farmLat: Number(e.target.value) }) })), /* @__PURE__ */ React.createElement(Field, { label: "\u0E25\u0E2D\u0E07\u0E08\u0E34\u0E08\u0E39\u0E14 (lon)" }, /* @__PURE__ */ React.createElement("input", { type: "number", step: "any", style: inputStyle, value: s.farmLon, onChange: (e) => setS({ ...s, farmLon: Number(e.target.value) }) }))), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 11.5, color: C.muted, marginTop: 8 } }, "\u0E40\u0E01\u0E47\u0E1A\u0E1E\u0E34\u0E01\u0E31\u0E14 lat/lon \u0E44\u0E14\u0E49\u0E08\u0E32\u0E01 Google Maps \u2014 \u0E01\u0E14\u0E04\u0E49\u0E32\u0E07\u0E1A\u0E19\u0E41\u0E1C\u0E19\u0E17\u0E35\u0E48\u0E15\u0E33\u0E41\u0E2B\u0E19\u0E48\u0E07\u0E1F\u0E32\u0E23\u0E4C\u0E21 \u0E15\u0E31\u0E27\u0E40\u0E25\u0E02\u0E17\u0E35\u0E48\u0E02\u0E36\u0E49\u0E19\u0E15\u0E49\u0E19 URL \u0E04\u0E37\u0E2D\u0E1E\u0E34\u0E01\u0E31\u0E14")), /* @__PURE__ */ React.createElement("div", { style: cardStyle }, /* @__PURE__ */ React.createElement(SectionTitle, { sub: "\u0E43\u0E0A\u0E49\u0E04\u0E33\u0E19\u0E27\u0E13\u0E15\u0E49\u0E19\u0E17\u0E38\u0E19\u0E2B\u0E31\u0E27\u0E2D\u0E32\u0E2B\u0E32\u0E23\u0E2A\u0E30\u0E2A\u0E21\u0E41\u0E25\u0E30\u0E01\u0E33\u0E44\u0E23\u0E15\u0E48\u0E2D\u0E19\u0E49\u0E33\u0E2B\u0E19\u0E31\u0E01\u0E1B\u0E31\u0E08\u0E08\u0E38\u0E1A\u0E31\u0E19\u0E43\u0E19\u0E41\u0E14\u0E0A\u0E1A\u0E2D\u0E23\u0E4C\u0E14" }, "\u0E15\u0E49\u0E19\u0E17\u0E38\u0E19\u0E2D\u0E32\u0E2B\u0E32\u0E23 & \u0E23\u0E32\u0E04\u0E32\u0E02\u0E32\u0E22"), /* @__PURE__ */ React.createElement(Field, { label: "\u0E15\u0E49\u0E19\u0E17\u0E38\u0E19\u0E2D\u0E32\u0E2B\u0E32\u0E23\u0E15\u0E48\u0E2D\u0E01\u0E34\u0E42\u0E25\u0E01\u0E23\u0E31\u0E21 (\u0E1A\u0E32\u0E17/\u0E01\u0E01. \u0E2D\u0E32\u0E2B\u0E32\u0E23)" }, /* @__PURE__ */ React.createElement("input", { type: "number", style: { ...inputStyle, maxWidth: 220 }, value: s.feedCostPerKg, onChange: (e) => setS({ ...s, feedCostPerKg: Number(e.target.value) }) })), /* @__PURE__ */ React.createElement("div", { style: { overflowX: "auto", marginTop: 10 } }, /* @__PURE__ */ React.createElement("table", { style: tableStyle }, /* @__PURE__ */ React.createElement("thead", null, /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E1B\u0E23\u0E30\u0E40\u0E20\u0E17\u0E1B\u0E39"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E23\u0E32\u0E04\u0E32\u0E1B\u0E31\u0E08\u0E08\u0E38\u0E1A\u0E31\u0E19 (\u0E1A\u0E32\u0E17/\u0E01\u0E01.)"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E23\u0E32\u0E04\u0E32\u0E04\u0E32\u0E14\u0E01\u0E32\u0E23\u0E13\u0E4C (\u0E1A\u0E32\u0E17/\u0E01\u0E01.)"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E40\u0E1B\u0E49\u0E32\u0E2B\u0E21\u0E32\u0E22\u0E02\u0E32\u0E22 (\u0E01\u0E01.)"))), /* @__PURE__ */ React.createElement("tbody", null, /* @__PURE__ */ React.createElement("tr", { key: "male" }, /* @__PURE__ */ React.createElement("td", { style: tdStyle }, "\u0E15\u0E31\u0E27\u0E1C\u0E39\u0E49"), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, /* @__PURE__ */ React.createElement("input", { type: "number", style: { ...inputStyle, width: 90 }, value: s.pricing.male.current, onChange: (e) => setPricing("male", "current", e.target.value) })), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, /* @__PURE__ */ React.createElement("input", { type: "number", style: { ...inputStyle, width: 90 }, value: s.pricing.male.forecast, onChange: (e) => setPricing("male", "forecast", e.target.value) })), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, /* @__PURE__ */ React.createElement("input", { type: "number", style: { ...inputStyle, width: 90 }, value: s.salesTargets.male, onChange: (e) => setSalesTarget("male", e.target.value) }))), /* @__PURE__ */ React.createElement("tr", { key: "female" }, /* @__PURE__ */ React.createElement("td", { style: tdStyle }, "\u0E15\u0E31\u0E27\u0E40\u0E21\u0E35\u0E22"), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, /* @__PURE__ */ React.createElement("input", { type: "number", style: { ...inputStyle, width: 90 }, value: s.pricing.female.current, onChange: (e) => setPricing("female", "current", e.target.value) })), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, /* @__PURE__ */ React.createElement("input", { type: "number", style: { ...inputStyle, width: 90 }, value: s.pricing.female.forecast, onChange: (e) => setPricing("female", "forecast", e.target.value) })), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, /* @__PURE__ */ React.createElement("input", { type: "number", style: { ...inputStyle, width: 90 }, value: s.salesTargets.female, onChange: (e) => setSalesTarget("female", e.target.value) }))), /* @__PURE__ */ React.createElement("tr", { key: "eggs" }, /* @__PURE__ */ React.createElement("td", { style: tdStyle }, "\u0E1B\u0E39\u0E44\u0E02\u0E48"), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, /* @__PURE__ */ React.createElement("input", { type: "number", style: { ...inputStyle, width: 90 }, value: s.pricing.eggs.current, onChange: (e) => setPricing("eggs", "current", e.target.value) })), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, /* @__PURE__ */ React.createElement("input", { type: "number", style: { ...inputStyle, width: 90 }, value: s.pricing.eggs.forecast, onChange: (e) => setPricing("eggs", "forecast", e.target.value) })), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, /* @__PURE__ */ React.createElement("input", { type: "number", style: { ...inputStyle, width: 90 }, value: s.salesTargets.eggs, onChange: (e) => setSalesTarget("eggs", e.target.value) })))))), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 11.5, color: C.muted, marginTop: 8 } }, "\"\u0E23\u0E32\u0E04\u0E32\u0E1B\u0E31\u0E08\u0E08\u0E38\u0E1A\u0E31\u0E19\" \u0E04\u0E37\u0E2D\u0E23\u0E32\u0E04\u0E32\u0E15\u0E25\u0E32\u0E14\u0E27\u0E31\u0E19\u0E19\u0E35\u0E49 \u0E43\u0E0A\u0E49\u0E04\u0E33\u0E19\u0E27\u0E13\u0E01\u0E33\u0E44\u0E23\u0E08\u0E23\u0E34\u0E07 \u0E2A\u0E48\u0E27\u0E19 \"\u0E23\u0E32\u0E04\u0E32\u0E04\u0E32\u0E14\u0E01\u0E32\u0E23\u0E13\u0E4C\" \u0E43\u0E0A\u0E49\u0E1B\u0E23\u0E30\u0E21\u0E32\u0E13\u0E01\u0E33\u0E44\u0E23\u0E25\u0E48\u0E27\u0E07\u0E2B\u0E19\u0E49\u0E32 \u2014 \u0E1B\u0E23\u0E31\u0E1A\u0E17\u0E31\u0E49\u0E07\u0E2A\u0E2D\u0E07\u0E04\u0E48\u0E32\u0E44\u0E14\u0E49\u0E40\u0E2D\u0E07\u0E15\u0E32\u0E21\u0E23\u0E32\u0E04\u0E32\u0E15\u0E25\u0E32\u0E14\u0E08\u0E23\u0E34\u0E07\u0E17\u0E35\u0E48\u0E40\u0E0A\u0E47\u0E04\u0E21\u0E32 (\u0E40\u0E0A\u0E48\u0E19 \u0E1B\u0E39\u0E44\u0E02\u0E48 1,000 \u0E01\u0E01. \u0E17\u0E35\u0E48 600 \u0E1A\u0E32\u0E17/\u0E01\u0E01.)"), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 11.5, color: C.muted, marginTop: 4 } }, "\u0E15\u0E31\u0E49\u0E07\u0E23\u0E32\u0E04\u0E32\u0E01\u0E25\u0E32\u0E07\u0E44\u0E27\u0E49\u0E17\u0E35\u0E48\u0E19\u0E35\u0E48\u0E01\u0E48\u0E2D\u0E19 \u0E41\u0E25\u0E49\u0E27\u0E44\u0E1B\u0E41\u0E01\u0E49\u0E44\u0E02\u0E23\u0E32\u0E04\u0E32\u0E02\u0E32\u0E22\u0E40\u0E09\u0E1E\u0E32\u0E30\u0E01\u0E25\u0E48\u0E2D\u0E07\u0E44\u0E14\u0E49\u0E43\u0E19\u0E2B\u0E19\u0E49\u0E32\u0E41\u0E01\u0E49\u0E44\u0E02\u0E01\u0E25\u0E48\u0E2D\u0E07\u0E1B\u0E39\u0E41\u0E15\u0E48\u0E25\u0E30\u0E01\u0E25\u0E48\u0E2D\u0E07 (\u0E23\u0E32\u0E04\u0E32\u0E40\u0E09\u0E1E\u0E32\u0E30\u0E01\u0E25\u0E48\u0E2D\u0E07\u0E08\u0E30\u0E2A\u0E33\u0E04\u0E31\u0E0D\u0E01\u0E27\u0E48\u0E32\u0E23\u0E32\u0E04\u0E32\u0E01\u0E25\u0E32\u0E07)")), /* @__PURE__ */ React.createElement("div", { style: cardStyle }, /* @__PURE__ */ React.createElement(SectionTitle, { sub: "\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23\u0E41\u0E23\u0E48\u0E18\u0E32\u0E15\u0E38/\u0E2A\u0E32\u0E23\u0E40\u0E04\u0E21\u0E35\u0E17\u0E35\u0E48\u0E21\u0E35\u0E43\u0E19\u0E1F\u0E32\u0E23\u0E4C\u0E21 \u2014 AI \u0E1C\u0E39\u0E49\u0E0A\u0E48\u0E27\u0E22\u0E08\u0E30\u0E43\u0E0A\u0E49\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23\u0E19\u0E35\u0E49\u0E15\u0E2D\u0E19\u0E41\u0E19\u0E30\u0E19\u0E33\u0E27\u0E48\u0E32\u0E04\u0E27\u0E23\u0E40\u0E15\u0E34\u0E21\u0E2A\u0E32\u0E23\u0E15\u0E31\u0E27\u0E44\u0E2B\u0E19" }, "\u{1F9EA} \u0E41\u0E23\u0E48\u0E18\u0E32\u0E15\u0E38\u0E2A\u0E33\u0E2B\u0E23\u0E31\u0E1A\u0E17\u0E33\u0E19\u0E49\u0E33\u0E17\u0E30\u0E40\u0E25\u0E40\u0E17\u0E35\u0E22\u0E21"), (s.minerals || []).map((m, i) => /* @__PURE__ */ React.createElement("div", { key: m.key || i, style: { display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 8, alignItems: "center", marginBottom: 8 } }, /* @__PURE__ */ React.createElement("input", { style: inputStyle, placeholder: "\u0E0A\u0E37\u0E48\u0E2D\u0E2A\u0E32\u0E23/\u0E41\u0E23\u0E48\u0E18\u0E32\u0E15\u0E38", value: m.name, onChange: (e) => setMineral(i, "name", e.target.value) }), /* @__PURE__ */ React.createElement("input", { style: inputStyle, placeholder: "\u0E2B\u0E21\u0E32\u0E22\u0E40\u0E2B\u0E15\u0E38 (\u0E04\u0E27\u0E32\u0E21\u0E40\u0E02\u0E49\u0E21\u0E02\u0E49\u0E19/\u0E02\u0E19\u0E32\u0E14\u0E16\u0E38\u0E07/\u0E43\u0E0A\u0E49\u0E17\u0E33\u0E2D\u0E30\u0E44\u0E23)", value: m.note, onChange: (e) => setMineral(i, "note", e.target.value) }), /* @__PURE__ */ React.createElement(Btn, { tone: "ghost", size: "sm", onClick: () => removeMineral(i) }, "\u2715"))), /* @__PURE__ */ React.createElement(Btn, { tone: "ghost", size: "sm", onClick: addMineral }, "+ \u0E40\u0E1E\u0E34\u0E48\u0E21\u0E41\u0E23\u0E48\u0E18\u0E32\u0E15\u0E38")), isDirty && /* @__PURE__ */ React.createElement("div", { style: { background: "rgba(201,138,46,0.12)", border: `1px solid ${C.amber}`, borderRadius: 8, padding: "10px 14px", fontSize: 12.5, color: C.text, fontWeight: 600 } }, "\u26A0\uFE0F \u0E21\u0E35\u0E01\u0E32\u0E23\u0E41\u0E01\u0E49\u0E44\u0E02\u0E17\u0E35\u0E48\u0E22\u0E31\u0E07\u0E44\u0E21\u0E48\u0E44\u0E14\u0E49\u0E1A\u0E31\u0E19\u0E17\u0E36\u0E01 \u2014 \u0E15\u0E49\u0E2D\u0E07\u0E01\u0E14\u0E1B\u0E38\u0E48\u0E21 \"\u0E1A\u0E31\u0E19\u0E17\u0E36\u0E01\u0E01\u0E32\u0E23\u0E15\u0E31\u0E49\u0E07\u0E04\u0E48\u0E32\" \u0E14\u0E49\u0E32\u0E19\u0E25\u0E48\u0E32\u0E07\u0E01\u0E48\u0E2D\u0E19 \u0E44\u0E21\u0E48\u0E07\u0E31\u0E49\u0E19\u0E15\u0E31\u0E27\u0E40\u0E25\u0E02\u0E08\u0E30\u0E44\u0E21\u0E48\u0E2D\u0E31\u0E1B\u0E40\u0E14\u0E15\u0E17\u0E35\u0E48\u0E41\u0E14\u0E0A\u0E1A\u0E2D\u0E23\u0E4C\u0E14"), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center" } }, /* @__PURE__ */ React.createElement(Btn, { tone: "seagrass", disabled: saveState === "saving", onClick: handleSave }, saveState === "saving" ? "\u0E01\u0E33\u0E25\u0E31\u0E07\u0E1A\u0E31\u0E19\u0E17\u0E36\u0E01\u2026" : "\u0E1A\u0E31\u0E19\u0E17\u0E36\u0E01\u0E01\u0E32\u0E23\u0E15\u0E31\u0E49\u0E07\u0E04\u0E48\u0E32"), /* @__PURE__ */ React.createElement(SaveStatusText, { state: saveState })), /* @__PURE__ */ React.createElement(DataManagementCard, { onExport, onImport, onResetAll, counts }), /* @__PURE__ */ React.createElement(ChangePasswordCard, null));
}
function DashboardChartsCard({ boxes, waterLogs, settings, financeByCategory, history }) {
  const coreParams = settings.parameters.filter((p) => CORE_PARAM_KEYS.includes(p.key));
  const [paramKey, setParamKey] = useState(coreParams[0] ? coreParams[0].key : "salinity");
  const param = settings.parameters.find((p) => p.key === paramKey) || coreParams[0];
  const waterSeries = useMemo(() => {
    const sorted = [...waterLogs].sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
    const points = sorted.filter((l) => l.readings[paramKey] !== void 0 && l.readings[paramKey] !== "").map((l) => ({ x: new Date(l.datetime).getTime(), y: Number(l.readings[paramKey]) }));
    return [{ name: param ? param.label : paramKey, color: C.water, points }];
  }, [waterLogs, paramKey, param]);
  const compositionData = ["male", "female", "eggs"].map((cat) => ({
    label: crabCategoryLabel(cat),
    value: financeByCategory[cat] ? financeByCategory[cat].weightKg : 0,
    color: cat === "male" ? C.water : cat === "female" ? C.coral : C.amber
  }));
  const monthlyProfit = useMemo(() => computeMonthlyProfit(history), [history]);
  const recentMonths = monthlyProfit.slice(-6);
  const latestMonth = monthlyProfit.length ? monthlyProfit[monthlyProfit.length - 1] : null;
  const level = monthlyProfitLevel(monthlyProfit);
  const profitSeries = [{ name: "\u0E01\u0E33\u0E44\u0E23\u0E23\u0E32\u0E22\u0E40\u0E14\u0E37\u0E2D\u0E19", color: C.seagrass, points: recentMonths.map((m, i) => ({ x: i, y: m.profit })) }];
  return /* @__PURE__ */ React.createElement("div", { style: cardStyle }, /* @__PURE__ */ React.createElement(SectionTitle, { sub: "\u0E19\u0E49\u0E33, \u0E2A\u0E31\u0E14\u0E2A\u0E48\u0E27\u0E19\u0E1B\u0E39\u0E23\u0E32\u0E22\u0E01\u0E25\u0E48\u0E2D\u0E07 \u0E41\u0E25\u0E30\u0E01\u0E33\u0E44\u0E23\u0E23\u0E32\u0E22\u0E40\u0E14\u0E37\u0E2D\u0E19 \u0E43\u0E19\u0E20\u0E32\u0E1E\u0E23\u0E27\u0E21" }, "\u{1F4C8} \u0E01\u0E23\u0E32\u0E1F\u0E20\u0E32\u0E1E\u0E23\u0E27\u0E21"), /* @__PURE__ */ React.createElement("div", { className: "cf-grid-2col", style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 } }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 } }, /* @__PURE__ */ React.createElement("div", { style: { fontWeight: 700, fontSize: 13.5 } }, "\u0E41\u0E19\u0E27\u0E42\u0E19\u0E49\u0E21\u0E04\u0E38\u0E13\u0E20\u0E32\u0E1E\u0E19\u0E49\u0E33"), /* @__PURE__ */ React.createElement("select", { style: { ...inputStyle, width: 170, padding: "5px 8px", fontSize: 12 }, value: paramKey, onChange: (e) => setParamKey(e.target.value) }, coreParams.map((p) => /* @__PURE__ */ React.createElement("option", { key: p.key, value: p.key }, p.label)))), /* @__PURE__ */ React.createElement(LineChartSVG, { series: waterSeries, yFormat: (v) => num(v, param && param.unit === "\u00B0C" ? 1 : 2) })), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { fontWeight: 700, fontSize: 13.5, marginBottom: 8 } }, "\u0E2A\u0E31\u0E14\u0E2A\u0E48\u0E27\u0E19\u0E1B\u0E39\u0E23\u0E32\u0E22\u0E01\u0E25\u0E48\u0E2D\u0E07\u0E15\u0E32\u0E21\u0E1B\u0E23\u0E30\u0E40\u0E20\u0E17 (\u0E01\u0E01. \u0E19\u0E49\u0E33\u0E2B\u0E19\u0E31\u0E01\u0E23\u0E27\u0E21)"), /* @__PURE__ */ React.createElement(BarChartSVG, { data: compositionData })), /* @__PURE__ */ React.createElement("div", { style: { gridColumn: "1 / -1", borderTop: `1px solid ${C.line}`, paddingTop: 16, marginTop: 4 } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 16, marginBottom: 8 } }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { fontWeight: 700, fontSize: 13.5 } }, "\u0E01\u0E33\u0E44\u0E23\u0E23\u0E32\u0E22\u0E40\u0E14\u0E37\u0E2D\u0E19\u0E25\u0E48\u0E32\u0E2A\u0E38\u0E14"), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 11.5, color: C.muted } }, latestMonth ? latestMonth.label : "\u2014")), /* @__PURE__ */ React.createElement("div", { style: { textAlign: "right" } }, /* @__PURE__ */ React.createElement("div", { style: { fontFamily: MONO, fontWeight: 700, fontSize: 24, color: latestMonth && latestMonth.profit >= 0 ? C.seagrass : C.coral } }, latestMonth ? `${money(latestMonth.profit)} \u0E1A.` : "\u2014"), /* @__PURE__ */ React.createElement(Pill, { tone: level.tone }, level.label))), /* @__PURE__ */ React.createElement(LineChartSVG, { series: profitSeries, yFormat: (v) => num(v, 0) }), recentMonths.length > 0 && /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 10, flexWrap: "wrap", fontSize: 11, color: C.muted, marginTop: 4 } }, recentMonths.map((m) => /* @__PURE__ */ React.createElement("span", { key: m.key }, m.label))))));
}
const TABS = [
  { id: "dashboard", label: "\u0E41\u0E14\u0E0A\u0E1A\u0E2D\u0E23\u0E4C\u0E14" },
  { id: "boxes", label: "\u0E01\u0E25\u0E48\u0E2D\u0E07 / \u0E04\u0E2D\u0E19\u0E42\u0E14" },
  { id: "alerts", label: "\u0E41\u0E08\u0E49\u0E07\u0E40\u0E15\u0E37\u0E2D\u0E19" },
  { id: "water", label: "\u0E19\u0E49\u0E33 / \u0E1B\u0E31\u0E4A\u0E21" },
  { id: "feed", label: "\u0E04\u0E33\u0E19\u0E27\u0E13\u0E2D\u0E32\u0E2B\u0E32\u0E23" },
  { id: "history", label: "\u0E1B\u0E23\u0E30\u0E27\u0E31\u0E15\u0E34 / \u0E23\u0E32\u0E22\u0E07\u0E32\u0E19" },
  { id: "market", label: "\u0E15\u0E25\u0E32\u0E14 / \u0E25\u0E39\u0E01\u0E04\u0E49\u0E32" },
  { id: "assistant", label: "\u{1F916} \u0E1C\u0E39\u0E49\u0E0A\u0E48\u0E27\u0E22 AI" },
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
function MarketPricesPanel({ marketPrices, settings, onAdd, onDelete }) {
  const blankForm = () => ({
    date: todayStr(),
    category: "male",
    sizeLabel: (settings.crabSizePresets || [])[0] || "",
    wholesalePrice: "",
    agentPrice: "",
    marketName: "",
    notes: ""
  });
  const [form, setForm] = useState(blankForm());
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState("");
  const [aiResults, setAiResults] = useState(null);
  const [myApiKey] = useState(() => {
    try {
      return localStorage.getItem("cf_gemini_api_key") || "";
    } catch {
      return "";
    }
  });
  const [chartCategory, setChartCategory] = useState("male");

  const submit = () => {
    if (form.wholesalePrice === "" && form.agentPrice === "") {
      alert("\u0E01\u0E23\u0E2D\u0E01\u0E23\u0E32\u0E04\u0E32\u0E2A\u0E48\u0E07\u0E2B\u0E23\u0E37\u0E2D\u0E23\u0E32\u0E04\u0E32\u0E1B\u0E35\u0E01\u0E2D\u0E22\u0E48\u0E32\u0E07\u0E19\u0E49\u0E2D\u0E22 1 \u0E0A\u0E48\u0E2D\u0E07");
      return;
    }
    onAdd({
      id: uid(),
      date: form.date,
      category: form.category,
      sizeLabel: form.sizeLabel,
      wholesalePrice: form.wholesalePrice === "" ? null : Number(form.wholesalePrice),
      agentPrice: form.agentPrice === "" ? null : Number(form.agentPrice),
      marketName: form.marketName,
      notes: form.notes,
      source: "manual"
    });
    setForm(blankForm());
  };

  const searchAi = async () => {
    setAiLoading(true);
    setAiError("");
    setAiResults(null);
    try {
      const locationName = settings.farmLocationName || "\u0E1B\u0E23\u0E30\u0E40\u0E17\u0E28\u0E44\u0E17\u0E22";
      const res = await fetch("/api/market-price-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locationName, apiKeyOverride: myApiKey || void 0 })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "\u0E40\u0E23\u0E35\u0E22\u0E01 API \u0E44\u0E21\u0E48\u0E2A\u0E33\u0E40\u0E23\u0E47\u0E08");
      if (!Array.isArray(data.results) || data.results.length === 0) {
        throw new Error("AI \u0E44\u0E21\u0E48\u0E1E\u0E1A\u0E23\u0E32\u0E04\u0E32\u0E15\u0E25\u0E32\u0E14\u0E17\u0E35\u0E48\u0E0A\u0E31\u0E14\u0E40\u0E08\u0E19 \u0E25\u0E2D\u0E07\u0E43\u0E2B\u0E21\u0E48\u0E2D\u0E35\u0E01\u0E04\u0E23\u0E31\u0E49\u0E07\u0E2B\u0E23\u0E37\u0E2D\u0E01\u0E23\u0E2D\u0E01\u0E40\u0E2D\u0E07");
      }
      setAiResults(data.results);
    } catch (err) {
      setAiError((err && err.message) || String(err));
    } finally {
      setAiLoading(false);
    }
  };

  const acceptAiResult = (r) => {
    onAdd({
      id: uid(),
      date: todayStr(),
      category: r.category || "male",
      sizeLabel: r.sizeLabel || "",
      wholesalePrice: r.wholesalePrice != null && !isNaN(r.wholesalePrice) ? Number(r.wholesalePrice) : null,
      agentPrice: r.agentPrice != null && !isNaN(r.agentPrice) ? Number(r.agentPrice) : null,
      marketName: r.marketName || "AI \u0E04\u0E49\u0E19\u0E2B\u0E32",
      notes: r.note || "",
      source: "ai"
    });
    setAiResults((prev) => prev ? prev.filter((x) => x !== r) : prev);
  };

  const sorted = [...marketPrices].sort((a, b) => new Date(b.date) - new Date(a.date));
  const chartRows = marketPrices.filter((m) => m.category === chartCategory).sort((a, b) => new Date(a.date) - new Date(b.date));
  const chartSeries = [
    { name: "\u0E23\u0E32\u0E04\u0E32\u0E2A\u0E48\u0E07", color: C.water, points: chartRows.filter((m) => m.wholesalePrice != null).map((m) => ({ x: new Date(m.date).getTime(), y: m.wholesalePrice })) },
    { name: "\u0E23\u0E32\u0E04\u0E32\u0E1B\u0E35\u0E01", color: C.coral, points: chartRows.filter((m) => m.agentPrice != null).map((m) => ({ x: new Date(m.date).getTime(), y: m.agentPrice })) }
  ].filter((s) => s.points.length);

  return /* @__PURE__ */ React.createElement("div", { className: "cf-grid-2col", style: { display: "grid", gridTemplateColumns: "340px 1fr", gap: 20, alignItems: "start" } }, /* @__PURE__ */ React.createElement("div", { style: cardStyle }, /* @__PURE__ */ React.createElement(SectionTitle, null, "\u0E1A\u0E31\u0E19\u0E17\u0E36\u0E01\u0E23\u0E32\u0E04\u0E32\u0E15\u0E25\u0E32\u0E14\u0E27\u0E31\u0E19\u0E19\u0E35\u0E49"), /* @__PURE__ */ React.createElement(Btn, { tone: "ghost", size: "sm", disabled: aiLoading, onClick: searchAi, style: { width: "100%", marginBottom: 10 } }, aiLoading ? "\u{1F504} \u0E01\u0E33\u0E25\u0E31\u0E07\u0E04\u0E49\u0E19\u0E2B\u0E32\u2026" : "\u{1F50E} \u0E04\u0E49\u0E19\u0E2B\u0E32\u0E23\u0E32\u0E04\u0E32\u0E15\u0E25\u0E32\u0E14\u0E14\u0E49\u0E27\u0E22 AI"), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 11, color: C.muted, marginBottom: 10, lineHeight: 1.5 } }, "\u0E43\u0E0A\u0E49 API Key \u0E40\u0E14\u0E35\u0E22\u0E27\u0E01\u0E31\u0E1A\u0E2B\u0E19\u0E49\u0E32 \u0E19\u0E49\u0E33 / \u0E1B\u0E31\u0E4A\u0E21 (\u0E15\u0E31\u0E49\u0E07\u0E04\u0E48\u0E32\u0E44\u0E14\u0E49\u0E17\u0E35\u0E48\u0E19\u0E31\u0E48\u0E19) \u2014 \u0E1C\u0E25\u0E25\u0E31\u0E1E\u0E18\u0E4C\u0E40\u0E1B\u0E47\u0E19\u0E23\u0E32\u0E04\u0E32\u0E2D\u0E49\u0E32\u0E07\u0E2D\u0E34\u0E07\u0E08\u0E32\u0E01\u0E01\u0E32\u0E23\u0E04\u0E49\u0E19\u0E2B\u0E32\u0E1A\u0E19\u0E40\u0E27\u0E47\u0E1A \u0E04\u0E27\u0E23\u0E15\u0E23\u0E27\u0E08\u0E2A\u0E2D\u0E1A\u0E01\u0E48\u0E2D\u0E19\u0E23\u0E31\u0E1A\u0E08\u0E23\u0E34\u0E07"), aiError && /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12, color: C.coral, marginBottom: 10 } }, aiError), aiResults && aiResults.length > 0 && /* @__PURE__ */ React.createElement("div", { style: { background: "rgba(44,125,160,0.06)", border: `1px solid ${C.line}`, borderRadius: 8, padding: 10, marginBottom: 12 } }, /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12, fontWeight: 700, marginBottom: 6 } }, "\u0E1C\u0E25\u0E01\u0E32\u0E23\u0E04\u0E49\u0E19\u0E2B\u0E32\u0E08\u0E32\u0E01 AI \u2014 \u0E01\u0E14\u0E23\u0E31\u0E1A\u0E40\u0E1E\u0E37\u0E48\u0E2D\u0E1A\u0E31\u0E19\u0E17\u0E36\u0E01"), aiResults.map((r, i) => /* @__PURE__ */ React.createElement("div", { key: i, style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: i < aiResults.length - 1 ? `1px solid ${C.line}` : "none", gap: 8 } }, /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12, minWidth: 0 } }, /* @__PURE__ */ React.createElement("div", { style: { fontWeight: 700 } }, crabCategoryLabel(r.category), r.sizeLabel ? ` \u00B7 ${r.sizeLabel}` : ""), /* @__PURE__ */ React.createElement("div", { style: { color: C.muted, fontSize: 11 } }, r.wholesalePrice != null ? `\u0E2A\u0E48\u0E07 ${num(r.wholesalePrice)} \u0E1A.` : "", r.wholesalePrice != null && r.agentPrice != null ? " \u00B7 " : "", r.agentPrice != null ? `\u0E1B\u0E35\u0E01 ${num(r.agentPrice)} \u0E1A.` : ""), r.marketName && /* @__PURE__ */ React.createElement("div", { style: { color: C.muted, fontSize: 10.5 } }, r.marketName)), /* @__PURE__ */ React.createElement(Btn, { tone: "seagrass", size: "sm", onClick: () => acceptAiResult(r) }, "\u0E23\u0E31\u0E1A")))), /* @__PURE__ */ React.createElement(Field, { label: "\u0E27\u0E31\u0E19\u0E17\u0E35\u0E48" }, /* @__PURE__ */ React.createElement("input", { type: "date", style: inputStyle, value: form.date, onChange: (e) => setForm((f) => ({ ...f, date: e.target.value })) })), /* @__PURE__ */ React.createElement(Field, { label: "\u0E1B\u0E23\u0E30\u0E40\u0E20\u0E17\u0E1B\u0E39" }, /* @__PURE__ */ React.createElement("select", { style: inputStyle, value: form.category, onChange: (e) => setForm((f) => ({ ...f, category: e.target.value })) }, CRAB_CATEGORIES.map((c) => /* @__PURE__ */ React.createElement("option", { key: c.key, value: c.key }, c.label)))), /* @__PURE__ */ React.createElement(Field, { label: "\u0E44\u0E0B\u0E2A\u0E4C" }, /* @__PURE__ */ React.createElement("input", { list: "crabfarm-size-presets", style: inputStyle, value: form.sizeLabel, onChange: (e) => setForm((f) => ({ ...f, sizeLabel: e.target.value })), placeholder: "\u0E40\u0E0A\u0E48\u0E19 3-4 \u0E15\u0E31\u0E27/\u0E01\u0E01." }), /* @__PURE__ */ React.createElement("datalist", { id: "crabfarm-size-presets" }, (settings.crabSizePresets || []).map((s) => /* @__PURE__ */ React.createElement("option", { key: s, value: s })))), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 } }, /* @__PURE__ */ React.createElement(Field, { label: "\u0E23\u0E32\u0E04\u0E32\u0E2A\u0E48\u0E07 (\u0E1A\u0E32\u0E17/\u0E01\u0E01.)" }, /* @__PURE__ */ React.createElement("input", { type: "number", step: "any", style: inputStyle, value: form.wholesalePrice, onChange: (e) => setForm((f) => ({ ...f, wholesalePrice: e.target.value })) })), /* @__PURE__ */ React.createElement(Field, { label: "\u0E23\u0E32\u0E04\u0E32\u0E1B\u0E35\u0E01 (\u0E1A\u0E32\u0E17/\u0E01\u0E01.)" }, /* @__PURE__ */ React.createElement("input", { type: "number", step: "any", style: inputStyle, value: form.agentPrice, onChange: (e) => setForm((f) => ({ ...f, agentPrice: e.target.value })) }))), /* @__PURE__ */ React.createElement(Field, { label: "\u0E0A\u0E37\u0E48\u0E2D\u0E15\u0E25\u0E32\u0E14/\u0E41\u0E2B\u0E25\u0E48\u0E07\u0E23\u0E32\u0E04\u0E32" }, /* @__PURE__ */ React.createElement("input", { style: inputStyle, value: form.marketName, onChange: (e) => setForm((f) => ({ ...f, marketName: e.target.value })), placeholder: "\u0E40\u0E0A\u0E48\u0E19 \u0E15\u0E25\u0E32\u0E14\u0E17\u0E30\u0E40\u0E25\u0E44\u0E17\u0E22, \u0E41\u0E1E\u0E1B\u0E39\u0E1A\u0E49\u0E32\u0E19\u0E14\u0E2D\u0E19" })), /* @__PURE__ */ React.createElement(Field, { label: "\u0E2B\u0E21\u0E32\u0E22\u0E40\u0E2B\u0E15\u0E38" }, /* @__PURE__ */ React.createElement("textarea", { style: { ...inputStyle, minHeight: 50 }, value: form.notes, onChange: (e) => setForm((f) => ({ ...f, notes: e.target.value })) })), /* @__PURE__ */ React.createElement(Btn, { tone: "seagrass", onClick: submit }, "+ \u0E1A\u0E31\u0E19\u0E17\u0E36\u0E01\u0E23\u0E32\u0E04\u0E32")), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 18 } }, /* @__PURE__ */ React.createElement("div", { style: cardStyle }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 } }, /* @__PURE__ */ React.createElement(SectionTitle, null, "\u0E41\u0E19\u0E27\u0E42\u0E19\u0E49\u0E21\u0E23\u0E32\u0E04\u0E32"), /* @__PURE__ */ React.createElement("select", { style: { ...inputStyle, width: 140, padding: "5px 8px", fontSize: 12 }, value: chartCategory, onChange: (e) => setChartCategory(e.target.value) }, CRAB_CATEGORIES.map((c) => /* @__PURE__ */ React.createElement("option", { key: c.key, value: c.key }, c.label)))), /* @__PURE__ */ React.createElement(LineChartSVG, { series: chartSeries, yFormat: (v) => num(v, 0) })), /* @__PURE__ */ React.createElement("div", { style: cardStyle }, /* @__PURE__ */ React.createElement(SectionTitle, null, "\u0E1B\u0E23\u0E30\u0E27\u0E31\u0E15\u0E34\u0E23\u0E32\u0E04\u0E32\u0E15\u0E25\u0E32\u0E14"), /* @__PURE__ */ React.createElement("div", { style: { overflowX: "auto", maxHeight: 340, overflowY: "auto" } }, /* @__PURE__ */ React.createElement("table", { style: tableStyle }, /* @__PURE__ */ React.createElement("thead", null, /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E27\u0E31\u0E19\u0E17\u0E35\u0E48"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E1B\u0E23\u0E30\u0E40\u0E20\u0E17"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E44\u0E0B\u0E2A\u0E4C"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E23\u0E32\u0E04\u0E32\u0E2A\u0E48\u0E07"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E23\u0E32\u0E04\u0E32\u0E1B\u0E35\u0E01"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E15\u0E25\u0E32\u0E14/\u0E41\u0E2B\u0E25\u0E48\u0E07\u0E23\u0E32\u0E04\u0E32"), /* @__PURE__ */ React.createElement("th", { style: thStyle }))), /* @__PURE__ */ React.createElement("tbody", null, sorted.map((m) => /* @__PURE__ */ React.createElement("tr", { key: m.id }, /* @__PURE__ */ React.createElement("td", { style: tdStyle }, fmtDate(m.date)), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, crabCategoryLabel(m.category)), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, m.sizeLabel || "\u2014"), /* @__PURE__ */ React.createElement("td", { style: { ...tdStyle, fontFamily: MONO } }, m.wholesalePrice != null ? num(m.wholesalePrice) : "\u2014"), /* @__PURE__ */ React.createElement("td", { style: { ...tdStyle, fontFamily: MONO } }, m.agentPrice != null ? num(m.agentPrice) : "\u2014"), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, m.marketName || "\u2014", m.source === "ai" ? " \u{1F916}" : ""), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, /* @__PURE__ */ React.createElement("button", { type: "button", onClick: () => onDelete(m.id), style: { background: "none", border: "none", color: C.coral, cursor: "pointer", fontSize: 12 } }, "\u0E25\u0E1A")))), sorted.length === 0 && /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("td", { style: tdStyle, colSpan: 7 }, "\u0E22\u0E31\u0E07\u0E44\u0E21\u0E48\u0E21\u0E35\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E23\u0E32\u0E04\u0E32\u0E15\u0E25\u0E32\u0E14"))))))));
}
function CustomersPanel({ customers, onSave, onDelete }) {
  const blank = () => ({ id: null, name: "", phone: "", type: "regular", address: "", notes: "" });
  const [form, setForm] = useState(blank());
  const submit = () => {
    if (!form.name.trim()) {
      alert("\u0E01\u0E23\u0E2D\u0E01\u0E0A\u0E37\u0E48\u0E2D\u0E25\u0E39\u0E01\u0E04\u0E49\u0E32");
      return;
    }
    onSave({ ...form, id: form.id || uid(), createdAt: form.createdAt || (/* @__PURE__ */ new Date()).toISOString() });
    setForm(blank());
  };
  const edit = (c) => setForm({ ...c });
  const sorted = [...customers].sort((a, b) => (a.name || "").localeCompare(b.name || "", "th"));
  return /* @__PURE__ */ React.createElement("div", { className: "cf-grid-2col", style: { display: "grid", gridTemplateColumns: "320px 1fr", gap: 20, alignItems: "start" } }, /* @__PURE__ */ React.createElement("div", { style: cardStyle }, /* @__PURE__ */ React.createElement(SectionTitle, null, form.id ? "\u0E41\u0E01\u0E49\u0E44\u0E02\u0E25\u0E39\u0E01\u0E04\u0E49\u0E32" : "\u0E40\u0E1E\u0E34\u0E48\u0E21\u0E25\u0E39\u0E01\u0E04\u0E49\u0E32\u0E43\u0E2B\u0E21\u0E48"), /* @__PURE__ */ React.createElement(Field, { label: "\u0E0A\u0E37\u0E48\u0E2D\u0E25\u0E39\u0E01\u0E04\u0E49\u0E32" }, /* @__PURE__ */ React.createElement("input", { style: inputStyle, value: form.name, onChange: (e) => setForm((f) => ({ ...f, name: e.target.value })) })), /* @__PURE__ */ React.createElement(Field, { label: "\u0E40\u0E1A\u0E2D\u0E23\u0E4C\u0E42\u0E17\u0E23" }, /* @__PURE__ */ React.createElement("input", { style: inputStyle, value: form.phone, onChange: (e) => setForm((f) => ({ ...f, phone: e.target.value })) })), /* @__PURE__ */ React.createElement(Field, { label: "\u0E1B\u0E23\u0E30\u0E40\u0E20\u0E17\u0E25\u0E39\u0E01\u0E04\u0E49\u0E32" }, /* @__PURE__ */ React.createElement("select", { style: inputStyle, value: form.type, onChange: (e) => setForm((f) => ({ ...f, type: e.target.value })) }, /* @__PURE__ */ React.createElement("option", { value: "regular" }, CUSTOMER_TYPE_LABELS.regular), /* @__PURE__ */ React.createElement("option", { value: "agent" }, CUSTOMER_TYPE_LABELS.agent))), /* @__PURE__ */ React.createElement(Field, { label: "\u0E17\u0E35\u0E48\u0E2D\u0E22\u0E39\u0E48/\u0E1E\u0E37\u0E49\u0E19\u0E17\u0E35\u0E48" }, /* @__PURE__ */ React.createElement("input", { style: inputStyle, value: form.address, onChange: (e) => setForm((f) => ({ ...f, address: e.target.value })) })), /* @__PURE__ */ React.createElement(Field, { label: "\u0E2B\u0E21\u0E32\u0E22\u0E40\u0E2B\u0E15\u0E38" }, /* @__PURE__ */ React.createElement("textarea", { style: { ...inputStyle, minHeight: 50 }, value: form.notes, onChange: (e) => setForm((f) => ({ ...f, notes: e.target.value })) })), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 8 } }, /* @__PURE__ */ React.createElement(Btn, { tone: "seagrass", onClick: submit }, form.id ? "\u0E1A\u0E31\u0E19\u0E17\u0E36\u0E01\u0E01\u0E32\u0E23\u0E41\u0E01\u0E49\u0E44\u0E02" : "+ \u0E40\u0E1E\u0E34\u0E48\u0E21\u0E25\u0E39\u0E01\u0E04\u0E49\u0E32"), form.id && /* @__PURE__ */ React.createElement(Btn, { tone: "ghost", onClick: () => setForm(blank()) }, "\u0E22\u0E01\u0E40\u0E25\u0E34\u0E01"))), /* @__PURE__ */ React.createElement("div", { style: cardStyle }, /* @__PURE__ */ React.createElement(SectionTitle, { sub: `${customers.length} \u0E23\u0E32\u0E22` }, "\u0E23\u0E32\u0E22\u0E0A\u0E37\u0E48\u0E2D\u0E25\u0E39\u0E01\u0E04\u0E49\u0E32"), /* @__PURE__ */ React.createElement("div", { style: { overflowX: "auto" } }, /* @__PURE__ */ React.createElement("table", { style: tableStyle }, /* @__PURE__ */ React.createElement("thead", null, /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E0A\u0E37\u0E48\u0E2D"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E1B\u0E23\u0E30\u0E40\u0E20\u0E17"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E40\u0E1A\u0E2D\u0E23\u0E4C\u0E42\u0E17\u0E23"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E17\u0E35\u0E48\u0E2D\u0E22\u0E39\u0E48"), /* @__PURE__ */ React.createElement("th", { style: thStyle }))), /* @__PURE__ */ React.createElement("tbody", null, sorted.map((c) => /* @__PURE__ */ React.createElement("tr", { key: c.id }, /* @__PURE__ */ React.createElement("td", { style: { ...tdStyle, fontWeight: 700 } }, c.name), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, /* @__PURE__ */ React.createElement(Pill, { tone: c.type === "agent" ? "info" : "muted" }, CUSTOMER_TYPE_LABELS[c.type] || c.type)), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, c.phone || "\u2014"), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, c.address || "\u2014"), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, /* @__PURE__ */ React.createElement("button", { type: "button", onClick: () => edit(c), style: { background: "none", border: "none", color: C.water, cursor: "pointer", fontSize: 12, marginRight: 10 } }, "\u0E41\u0E01\u0E49\u0E44\u0E02"), /* @__PURE__ */ React.createElement("button", { type: "button", onClick: () => onDelete(c.id), style: { background: "none", border: "none", color: C.coral, cursor: "pointer", fontSize: 12 } }, "\u0E25\u0E1A")))), sorted.length === 0 && /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("td", { style: tdStyle, colSpan: 5 }, "\u0E22\u0E31\u0E07\u0E44\u0E21\u0E48\u0E21\u0E35\u0E25\u0E39\u0E01\u0E04\u0E49\u0E32")))))));
}
function OrdersPanel({ orders, customers, boxes, settings, onSave, onDelete }) {
  const blank = () => ({
    id: null,
    customerId: "",
    customerName: "",
    category: "male",
    sizeLabel: (settings.crabSizePresets || [])[0] || "",
    quantityKg: "",
    dueDate: todayStr(),
    jobType: "live",
    status: "pending",
    notes: ""
  });
  const [form, setForm] = useState(blank());
  const stock = categoryStockKg(boxes, form.category);
  const reserved = orderReservedKg(orders, form.category, form.id);
  const available = stock - reserved;
  const requestedKg = Number(form.quantityKg) || 0;
  const overAvailable = requestedKg > 0 && requestedKg > available;

  const submit = async () => {
    const customer = customers.find((c) => c.id === form.customerId);
    const name = customer ? customer.name : form.customerName;
    if (!name || !name.trim()) {
      alert("\u0E23\u0E30\u0E1A\u0E38\u0E0A\u0E37\u0E48\u0E2D\u0E25\u0E39\u0E01\u0E04\u0E49\u0E32");
      return;
    }
    if (!requestedKg) {
      alert("\u0E01\u0E23\u0E2D\u0E01\u0E08\u0E33\u0E19\u0E27\u0E19 (\u0E01\u0E01.)");
      return;
    }
    if (overAvailable && form.status === "pending") {
      const ok = await askConfirm(`\u0E2A\u0E15\u0E47\u0E2D\u0E01\u0E1B\u0E39\u0E1B\u0E23\u0E30\u0E40\u0E20\u0E17 "${crabCategoryLabel(form.category)}" \u0E17\u0E35\u0E48\u0E01\u0E33\u0E25\u0E31\u0E07\u0E40\u0E25\u0E35\u0E49\u0E22\u0E07\u0E2D\u0E22\u0E39\u0E48\u0E21\u0E35\u0E1E\u0E2D\u0E41\u0E04\u0E48 ${num(available, 1)} \u0E01\u0E01. (\u0E04\u0E33\u0E19\u0E27\u0E13\u0E08\u0E32\u0E01\u0E01\u0E25\u0E48\u0E2D\u0E07\u0E17\u0E35\u0E48\u0E21\u0E35 \u0E2B\u0E31\u0E01\u0E2D\u0E2D\u0E40\u0E14\u0E2D\u0E23\u0E4C\u0E04\u0E49\u0E32\u0E07\u0E2D\u0E37\u0E48\u0E19\u0E41\u0E25\u0E49\u0E27) \u0E41\u0E15\u0E48\u0E2D\u0E2D\u0E40\u0E14\u0E2D\u0E23\u0E4C\u0E19\u0E35\u0E49\u0E02\u0E2D ${num(requestedKg, 1)} \u0E01\u0E01. \u2014 \u0E22\u0E37\u0E19\u0E22\u0E31\u0E19\u0E1A\u0E31\u0E19\u0E17\u0E36\u0E01\u0E15\u0E48\u0E2D\u0E44\u0E1B\u0E44\u0E2B\u0E21?`);
      if (!ok) return;
    }
    onSave({
      ...form,
      id: form.id || uid(),
      customerName: name,
      quantityKg: requestedKg,
      createdAt: form.createdAt || (/* @__PURE__ */ new Date()).toISOString()
    });
    setForm(blank());
  };
  const edit = (o) => setForm({ ...o, customerId: o.customerId || "", customerName: o.customerName || "" });
  const setStatus = (o, status) => onSave({ ...o, status });
  const sorted = [...orders].sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
  const pendingCount = orders.filter((o) => o.status === "pending").length;
  return /* @__PURE__ */ React.createElement("div", { className: "cf-grid-2col", style: { display: "grid", gridTemplateColumns: "360px 1fr", gap: 20, alignItems: "start" } }, /* @__PURE__ */ React.createElement("div", { style: cardStyle }, /* @__PURE__ */ React.createElement(SectionTitle, null, form.id ? "\u0E41\u0E01\u0E49\u0E44\u0E02\u0E2D\u0E2D\u0E40\u0E14\u0E2D\u0E23\u0E4C" : "\u0E08\u0E2D\u0E07\u0E1B\u0E39 / \u0E23\u0E31\u0E1A\u0E2D\u0E2D\u0E40\u0E14\u0E2D\u0E23\u0E4C\u0E43\u0E2B\u0E21\u0E48"), /* @__PURE__ */ React.createElement(Field, { label: "\u0E25\u0E39\u0E01\u0E04\u0E49\u0E32 (\u0E40\u0E25\u0E37\u0E2D\u0E01\u0E08\u0E32\u0E01\u0E25\u0E39\u0E01\u0E04\u0E49\u0E32\u0E1B\u0E23\u0E30\u0E08\u0E33)" }, /* @__PURE__ */ React.createElement("select", { style: inputStyle, value: form.customerId, onChange: (e) => setForm((f) => ({ ...f, customerId: e.target.value, customerName: "" })) }, /* @__PURE__ */ React.createElement("option", { value: "" }, "\u2014 \u0E40\u0E25\u0E37\u0E2D\u0E01\u0E25\u0E39\u0E01\u0E04\u0E49\u0E32 \u2014"), customers.map((c) => /* @__PURE__ */ React.createElement("option", { key: c.id, value: c.id }, c.name, " (", CUSTOMER_TYPE_LABELS[c.type] || c.type, ")")))), !form.customerId && /* @__PURE__ */ React.createElement(Field, { label: "\u0E2B\u0E23\u0E37\u0E2D\u0E01\u0E23\u0E2D\u0E01\u0E0A\u0E37\u0E48\u0E2D\u0E25\u0E39\u0E01\u0E04\u0E49\u0E32\u0E43\u0E2B\u0E21\u0E48" }, /* @__PURE__ */ React.createElement("input", { style: inputStyle, value: form.customerName, onChange: (e) => setForm((f) => ({ ...f, customerName: e.target.value })) })), /* @__PURE__ */ React.createElement(Field, { label: "\u0E1B\u0E23\u0E30\u0E40\u0E20\u0E17\u0E07\u0E32\u0E19" }, /* @__PURE__ */ React.createElement("select", { style: inputStyle, value: form.jobType, onChange: (e) => setForm((f) => ({ ...f, jobType: e.target.value })) }, ORDER_JOB_TYPES.map((j) => /* @__PURE__ */ React.createElement("option", { key: j.key, value: j.key }, j.label)))), /* @__PURE__ */ React.createElement(Field, { label: "\u0E1B\u0E23\u0E30\u0E40\u0E20\u0E17\u0E1B\u0E39" }, /* @__PURE__ */ React.createElement("select", { style: inputStyle, value: form.category, onChange: (e) => setForm((f) => ({ ...f, category: e.target.value })) }, CRAB_CATEGORIES.map((c) => /* @__PURE__ */ React.createElement("option", { key: c.key, value: c.key }, c.label)))), /* @__PURE__ */ React.createElement(Field, { label: "\u0E44\u0E0B\u0E2A\u0E4C" }, /* @__PURE__ */ React.createElement("input", { list: "crabfarm-size-presets-order", style: inputStyle, value: form.sizeLabel, onChange: (e) => setForm((f) => ({ ...f, sizeLabel: e.target.value })), placeholder: "\u0E40\u0E0A\u0E48\u0E19 3-4 \u0E15\u0E31\u0E27/\u0E01\u0E01." }), /* @__PURE__ */ React.createElement("datalist", { id: "crabfarm-size-presets-order" }, (settings.crabSizePresets || []).map((s) => /* @__PURE__ */ React.createElement("option", { key: s, value: s })))), /* @__PURE__ */ React.createElement(Field, { label: "\u0E08\u0E33\u0E19\u0E27\u0E19 (\u0E01\u0E01.)", hint: `\u0E04\u0E07\u0E40\u0E2B\u0E25\u0E37\u0E2D\u0E43\u0E19\u0E01\u0E25\u0E48\u0E2D\u0E07 (\u0E2B\u0E31\u0E01\u0E2D\u0E2D\u0E40\u0E14\u0E2D\u0E23\u0E4C\u0E04\u0E49\u0E32\u0E07\u0E2D\u0E37\u0E48\u0E19\u0E41\u0E25\u0E49\u0E27): ${num(available, 1)} \u0E01\u0E01.` }, /* @__PURE__ */ React.createElement("input", { type: "number", step: "any", style: { ...inputStyle, ...(overAvailable ? { borderColor: C.coral, background: "rgba(226,96,58,0.06)" } : {}) }, value: form.quantityKg, onChange: (e) => setForm((f) => ({ ...f, quantityKg: e.target.value })) }), overAvailable && /* @__PURE__ */ React.createElement("div", { style: { fontSize: 11.5, color: C.coral, marginTop: 3 } }, "\u26A0\uFE0F \u0E40\u0E01\u0E34\u0E19\u0E08\u0E33\u0E19\u0E27\u0E19\u0E17\u0E35\u0E48\u0E21\u0E35\u0E2D\u0E22\u0E39\u0E48\u0E15\u0E2D\u0E19\u0E19\u0E35\u0E49")), /* @__PURE__ */ React.createElement(Field, { label: "\u0E27\u0E31\u0E19\u0E01\u0E33\u0E2B\u0E19\u0E14\u0E2A\u0E48\u0E07" }, /* @__PURE__ */ React.createElement("input", { type: "date", style: inputStyle, value: form.dueDate, onChange: (e) => setForm((f) => ({ ...f, dueDate: e.target.value })) })), /* @__PURE__ */ React.createElement(Field, { label: "\u0E2A\u0E16\u0E32\u0E19\u0E30" }, /* @__PURE__ */ React.createElement("select", { style: inputStyle, value: form.status, onChange: (e) => setForm((f) => ({ ...f, status: e.target.value })) }, /* @__PURE__ */ React.createElement("option", { value: "pending" }, ORDER_STATUS_LABELS.pending), /* @__PURE__ */ React.createElement("option", { value: "fulfilled" }, ORDER_STATUS_LABELS.fulfilled), /* @__PURE__ */ React.createElement("option", { value: "cancelled" }, ORDER_STATUS_LABELS.cancelled))), /* @__PURE__ */ React.createElement(Field, { label: "\u0E2B\u0E21\u0E32\u0E22\u0E40\u0E2B\u0E15\u0E38" }, /* @__PURE__ */ React.createElement("textarea", { style: { ...inputStyle, minHeight: 50 }, value: form.notes, onChange: (e) => setForm((f) => ({ ...f, notes: e.target.value })) })), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 8 } }, /* @__PURE__ */ React.createElement(Btn, { tone: "seagrass", onClick: submit }, form.id ? "\u0E1A\u0E31\u0E19\u0E17\u0E36\u0E01\u0E01\u0E32\u0E23\u0E41\u0E01\u0E49\u0E44\u0E02" : "+ \u0E1A\u0E31\u0E19\u0E17\u0E36\u0E01\u0E2D\u0E2D\u0E40\u0E14\u0E2D\u0E23\u0E4C"), form.id && /* @__PURE__ */ React.createElement(Btn, { tone: "ghost", onClick: () => setForm(blank()) }, "\u0E22\u0E01\u0E40\u0E25\u0E34\u0E01\u0E41\u0E01\u0E49\u0E44\u0E02"))), /* @__PURE__ */ React.createElement("div", { style: cardStyle }, /* @__PURE__ */ React.createElement(SectionTitle, { sub: `\u0E04\u0E49\u0E32\u0E07\u0E2A\u0E48\u0E07 ${pendingCount} \u0E2D\u0E2D\u0E40\u0E14\u0E2D\u0E23\u0E4C` }, "\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23\u0E08\u0E2D\u0E07 / \u0E2D\u0E2D\u0E40\u0E14\u0E2D\u0E23\u0E4C"), /* @__PURE__ */ React.createElement("div", { style: { overflowX: "auto" } }, /* @__PURE__ */ React.createElement("table", { style: tableStyle }, /* @__PURE__ */ React.createElement("thead", null, /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E01\u0E33\u0E2B\u0E19\u0E14\u0E2A\u0E48\u0E07"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E25\u0E39\u0E01\u0E04\u0E49\u0E32"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E1B\u0E23\u0E30\u0E40\u0E20\u0E17\u0E1B\u0E39"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E44\u0E0B\u0E2A\u0E4C"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E07\u0E32\u0E19"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E08\u0E33\u0E19\u0E27\u0E19 (\u0E01\u0E01.)"), /* @__PURE__ */ React.createElement("th", { style: thStyle }, "\u0E2A\u0E16\u0E32\u0E19\u0E30"), /* @__PURE__ */ React.createElement("th", { style: thStyle }))), /* @__PURE__ */ React.createElement("tbody", null, sorted.map((o) => /* @__PURE__ */ React.createElement("tr", { key: o.id }, /* @__PURE__ */ React.createElement("td", { style: tdStyle }, fmtDate(o.dueDate)), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, o.customerName), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, crabCategoryLabel(o.category)), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, o.sizeLabel || "\u2014"), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, (ORDER_JOB_TYPES.find((j) => j.key === o.jobType) || {}).label || o.jobType), /* @__PURE__ */ React.createElement("td", { style: { ...tdStyle, fontFamily: MONO } }, num(o.quantityKg, 1)), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, /* @__PURE__ */ React.createElement(Pill, { tone: o.status === "fulfilled" ? "good" : o.status === "cancelled" ? "muted" : "warn" }, ORDER_STATUS_LABELS[o.status] || o.status)), /* @__PURE__ */ React.createElement("td", { style: tdStyle }, o.status === "pending" && /* @__PURE__ */ React.createElement("button", { type: "button", onClick: () => setStatus(o, "fulfilled"), style: { background: "none", border: "none", color: C.seagrass, cursor: "pointer", fontSize: 12, marginRight: 8 } }, "\u0E2A\u0E48\u0E07\u0E41\u0E25\u0E49\u0E27"), /* @__PURE__ */ React.createElement("button", { type: "button", onClick: () => edit(o), style: { background: "none", border: "none", color: C.water, cursor: "pointer", fontSize: 12, marginRight: 8 } }, "\u0E41\u0E01\u0E49\u0E44\u0E02"), /* @__PURE__ */ React.createElement("button", { type: "button", onClick: () => onDelete(o.id), style: { background: "none", border: "none", color: C.coral, cursor: "pointer", fontSize: 12 } }, "\u0E25\u0E1A")))), sorted.length === 0 && /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("td", { style: tdStyle, colSpan: 8 }, "\u0E22\u0E31\u0E07\u0E44\u0E21\u0E48\u0E21\u0E35\u0E2D\u0E2D\u0E40\u0E14\u0E2D\u0E23\u0E4C")))))));
}
function MarketHubTab({ marketPrices, customers, orders, boxes, settings, onAddPrice, onDeletePrice, onSaveCustomer, onDeleteCustomer, onSaveOrder, onDeleteOrder }) {
  const [subTab, setSubTab] = useState("prices");
  const subNav = [
    { id: "prices", label: "\u0E23\u0E32\u0E04\u0E32\u0E15\u0E25\u0E32\u0E14" },
    { id: "customers", label: "\u0E25\u0E39\u0E01\u0E04\u0E49\u0E32" },
    { id: "orders", label: "\u0E08\u0E2D\u0E07\u0E1B\u0E39 / \u0E2D\u0E2D\u0E40\u0E14\u0E2D\u0E23\u0E4C" }
  ];
  return /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 6, background: "#E4E9E2", borderRadius: 10, padding: 3, marginBottom: 18, width: "fit-content" } }, subNav.map((s) => /* @__PURE__ */ React.createElement("button", { key: s.id, type: "button", onClick: () => setSubTab(s.id), style: { padding: "7px 16px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 13, fontWeight: 700, fontFamily: BODY, background: subTab === s.id ? C.card : "transparent", color: subTab === s.id ? C.ink : C.muted, boxShadow: subTab === s.id ? "0 1px 3px rgba(11,35,51,0.15)" : "none" } }, s.label))), subTab === "prices" && /* @__PURE__ */ React.createElement(MarketPricesPanel, { marketPrices, settings, onAdd: onAddPrice, onDelete: onDeletePrice }), subTab === "customers" && /* @__PURE__ */ React.createElement(CustomersPanel, { customers, onSave: onSaveCustomer, onDelete: onDeleteCustomer }), subTab === "orders" && /* @__PURE__ */ React.createElement(OrdersPanel, { orders, customers, boxes, settings, onSave: onSaveOrder, onDelete: onDeleteOrder }));
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
  const [marketPrices, setMarketPrices] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [orders, setOrders] = useState([]);
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
        const [b, h, w, s, mk, cu, ord] = await Promise.all([
          storeGetCollection(COL_BOXES),
          storeGetCollection(COL_HISTORY),
          storeGetCollection(COL_WATER),
          storeGetSettings(),
          storeGetCollection(COL_MARKET),
          storeGetCollection(COL_CUSTOMERS),
          storeGetCollection(COL_ORDERS)
        ]);
        if (cancelled) return;
        const deduped = dedupeBoxes(b);
        setBoxes(deduped.list);
        if (deduped.changed) storeSetCollection(COL_BOXES, deduped.list);
        setHistory(h);
        setWaterLogs(w);
        setSettings(mergeSettings(s));
        setMarketPrices(mk);
        setCustomers(cu);
        setOrders(ord);
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
        const [b, h, w, s, mk, cu, ord] = await Promise.all([
          storeGetCollection(COL_BOXES),
          storeGetCollection(COL_HISTORY),
          storeGetCollection(COL_WATER),
          storeGetSettings(),
          storeGetCollection(COL_MARKET),
          storeGetCollection(COL_CUSTOMERS),
          storeGetCollection(COL_ORDERS)
        ]);
        if (stopped) return;
        const deduped = dedupeBoxes(b);
        if (deduped.changed) storeSetCollection(COL_BOXES, deduped.list);
        setBoxes((prev) => JSON.stringify(prev) === JSON.stringify(deduped.list) ? prev : deduped.list);
        setHistory((prev) => JSON.stringify(prev) === JSON.stringify(h) ? prev : h);
        setWaterLogs((prev) => JSON.stringify(prev) === JSON.stringify(w) ? prev : w);
        setSettings((prev) => {
          const next = mergeSettings(s);
          return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
        });
        setMarketPrices((prev) => JSON.stringify(prev) === JSON.stringify(mk) ? prev : mk);
        setCustomers((prev) => JSON.stringify(prev) === JSON.stringify(cu) ? prev : cu);
        setOrders((prev) => JSON.stringify(prev) === JSON.stringify(ord) ? prev : ord);
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
  const persistMarket = useCallback((next, changedIds) => {
    setMarketPrices(next);
    storeSetCollection(COL_MARKET, next, changedIds);
  }, []);
  const persistCustomers = useCallback((next, changedIds) => {
    setCustomers(next);
    storeSetCollection(COL_CUSTOMERS, next, changedIds);
  }, []);
  const persistOrders = useCallback((next, changedIds) => {
    setOrders(next);
    storeSetCollection(COL_ORDERS, next, changedIds);
  }, []);
  const addMarketPrice = useCallback((entry) => {
    persistMarket([...marketPrices, entry], [entry.id]);
  }, [marketPrices, persistMarket]);
  const deleteMarketPrice = useCallback((id) => {
    persistMarket(marketPrices.filter((m) => m.id !== id), [id]);
  }, [marketPrices, persistMarket]);
  const saveCustomer = useCallback((customer) => {
    const exists = customers.some((c) => c.id === customer.id);
    const next = exists ? customers.map((c) => c.id === customer.id ? customer : c) : [...customers, customer];
    persistCustomers(next, [customer.id]);
  }, [customers, persistCustomers]);
  const deleteCustomer = useCallback(async (id) => {
    const ok = await askConfirm("\u0E25\u0E1A\u0E25\u0E39\u0E01\u0E04\u0E49\u0E32\u0E23\u0E32\u0E22\u0E19\u0E35\u0E49?");
    if (!ok) return;
    persistCustomers(customers.filter((c) => c.id !== id), [id]);
  }, [customers, persistCustomers]);
  const saveOrder = useCallback((order) => {
    const exists = orders.some((o) => o.id === order.id);
    const next = exists ? orders.map((o) => o.id === order.id ? order : o) : [...orders, order];
    persistOrders(next, [order.id]);
  }, [orders, persistOrders]);
  const deleteOrder = useCallback(async (id) => {
    const ok = await askConfirm("\u0E25\u0E1A\u0E2D\u0E2D\u0E40\u0E14\u0E2D\u0E23\u0E4C\u0E19\u0E35\u0E49?");
    if (!ok) return;
    persistOrders(orders.filter((o) => o.id !== id), [id]);
  }, [orders, persistOrders]);
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
      settings,
      marketPrices,
      customers,
      orders
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
  }, [boxes, history, waterLogs, settings, marketPrices, customers, orders]);
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
    const nmk = Array.isArray(data.marketPrices) ? data.marketPrices : [];
    const ncu = Array.isArray(data.customers) ? data.customers : [];
    const nord = Array.isArray(data.orders) ? data.orders : [];
    persistBoxes(nb);
    persistHistory(nh);
    persistWater(nw);
    persistSettings(ns);
    persistMarket(nmk);
    persistCustomers(ncu);
    persistOrders(nord);
    alert("\u0E19\u0E33\u0E40\u0E02\u0E49\u0E32\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E2A\u0E33\u0E40\u0E23\u0E47\u0E08");
  }, [persistBoxes, persistHistory, persistWater, persistSettings, persistMarket, persistCustomers, persistOrders]);
  const resetAll = useCallback(async () => {
    const ok = await askConfirm("\u0E22\u0E37\u0E19\u0E22\u0E31\u0E19\u0E25\u0E1A\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E17\u0E31\u0E49\u0E07\u0E2B\u0E21\u0E14\u0E43\u0E19\u0E40\u0E04\u0E23\u0E37\u0E48\u0E2D\u0E07\u0E19\u0E35\u0E49? \u0E01\u0E32\u0E23\u0E01\u0E23\u0E30\u0E17\u0E33\u0E19\u0E35\u0E49\u0E44\u0E21\u0E48\u0E2A\u0E32\u0E21\u0E32\u0E23\u0E16\u0E22\u0E49\u0E2D\u0E19\u0E01\u0E25\u0E31\u0E1A\u0E44\u0E14\u0E49");
    if (!ok) return;
    const ok2 = await askConfirm("\u0E22\u0E37\u0E19\u0E22\u0E31\u0E19\u0E2D\u0E35\u0E01\u0E04\u0E23\u0E31\u0E49\u0E07 \u2014 \u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E01\u0E25\u0E48\u0E2D\u0E07 \u0E1B\u0E23\u0E30\u0E27\u0E31\u0E15\u0E34 \u0E41\u0E25\u0E30\u0E04\u0E48\u0E32\u0E19\u0E49\u0E33\u0E17\u0E31\u0E49\u0E07\u0E2B\u0E21\u0E14\u0E08\u0E30\u0E16\u0E39\u0E01\u0E25\u0E1A\u0E16\u0E32\u0E27\u0E23");
    if (!ok2) return;
    storeClearCollection(COL_BOXES);
    storeClearCollection(COL_HISTORY);
    storeClearCollection(COL_WATER);
    storeClearCollection(COL_MARKET);
    storeClearCollection(COL_CUSTOMERS);
    storeClearCollection(COL_ORDERS);
    storeClearSettings();
    setBoxes([]);
    setHistory([]);
    setWaterLogs([]);
    setSettings(DEFAULT_SETTINGS);
    setMarketPrices([]);
    setCustomers([]);
    setOrders([]);
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
  }).sort((a, b) => compareBoxNumbers(a.boxNumber, b.boxNumber));
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
  }))), /* @__PURE__ */ React.createElement(DashboardChartsCard, { boxes: activeBoxes, waterLogs, settings, financeByCategory, history })), tab === "boxes" && /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "cf-toolbar-row", style: { display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 6, background: "#E4E9E2", borderRadius: 10, padding: 3 } }, /* @__PURE__ */ React.createElement(
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
  ) : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" } }, /* @__PURE__ */ React.createElement("input", { id: "crabfarm-search-input", className: "cf-field-flex", style: { ...inputStyle, width: 200 }, placeholder: "\u0E04\u0E49\u0E19\u0E2B\u0E32\u0E40\u0E1A\u0E2D\u0E23\u0E4C\u0E01\u0E25\u0E48\u0E2D\u0E07\u2026", value: boxFilter.q, onChange: (e) => setBoxFilter((f) => ({ ...f, q: e.target.value })) }), /* @__PURE__ */ React.createElement("select", { className: "cf-field-flex", style: { ...inputStyle, width: 150 }, value: boxFilter.status, onChange: (e) => setBoxFilter((f) => ({ ...f, status: e.target.value })) }, /* @__PURE__ */ React.createElement("option", { value: "all" }, "\u0E17\u0E38\u0E01\u0E2A\u0E16\u0E32\u0E19\u0E30"), /* @__PURE__ */ React.createElement("option", { value: "active" }, "\u0E01\u0E33\u0E25\u0E31\u0E07\u0E40\u0E25\u0E35\u0E49\u0E22\u0E07"), /* @__PURE__ */ React.createElement("option", { value: "empty" }, "\u0E27\u0E48\u0E32\u0E07")), /* @__PURE__ */ React.createElement("select", { className: "cf-field-flex", style: { ...inputStyle, width: 150 }, value: boxFilter.sex, onChange: (e) => setBoxFilter((f) => ({ ...f, sex: e.target.value })) }, /* @__PURE__ */ React.createElement("option", { value: "all" }, "\u0E17\u0E38\u0E01\u0E40\u0E1E\u0E28"), /* @__PURE__ */ React.createElement("option", { value: "male" }, "\u0E15\u0E31\u0E27\u0E1C\u0E39\u0E49"), /* @__PURE__ */ React.createElement("option", { value: "female" }, "\u0E15\u0E31\u0E27\u0E40\u0E21\u0E35\u0E22"))), /* @__PURE__ */ React.createElement(Btn, { tone: "ghost", size: "sm", onClick: () => setPrintPicker(filteredBoxes.length ? filteredBoxes : boxes) }, "\u{1F5A8}\uFE0F \u0E1E\u0E34\u0E21\u0E1E\u0E4C\u0E2A\u0E15\u0E34\u0E01\u0E40\u0E01\u0E2D\u0E23\u0E4C QR"), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12, color: C.muted, marginBottom: 10 } }, "\u0E1E\u0E1A ", filteredBoxes.length.toLocaleString(), " \u0E01\u0E25\u0E48\u0E2D\u0E07"), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 14 } }, pagedBoxes.map((b) => /* @__PURE__ */ React.createElement(BoxCard, { key: b.id, box: b, onOpen: setOpenBox, onQuickHarvest: setHarvestTarget, onQuickDeath: setDeathTarget, moltReminderDays: settings.moltReminderDays })), filteredBoxes.length === 0 && /* @__PURE__ */ React.createElement("div", { style: { color: C.muted, fontSize: 13 } }, "\u0E44\u0E21\u0E48\u0E1E\u0E1A\u0E01\u0E25\u0E48\u0E2D\u0E07\u0E15\u0E32\u0E21\u0E40\u0E07\u0E37\u0E48\u0E2D\u0E19\u0E44\u0E02")), listTotalPages > 1 && /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "center", gap: 14, marginTop: 20 } }, /* @__PURE__ */ React.createElement(Btn, { tone: "ghost", size: "sm", disabled: listPageClamped === 0, onClick: () => setListPage(Math.max(0, listPageClamped - 1)) }, "\u2190 \u0E01\u0E48\u0E2D\u0E19\u0E2B\u0E19\u0E49\u0E32"), /* @__PURE__ */ React.createElement("span", { style: { fontSize: 12.5, color: C.muted, fontFamily: MONO } }, "\u0E2B\u0E19\u0E49\u0E32 ", listPageClamped + 1, " / ", listTotalPages), /* @__PURE__ */ React.createElement(Btn, { tone: "ghost", size: "sm", disabled: listPageClamped >= listTotalPages - 1, onClick: () => setListPage(Math.min(listTotalPages - 1, listPageClamped + 1)) }, "\u0E16\u0E31\u0E14\u0E44\u0E1B \u2192")))), tab === "alerts" && /* @__PURE__ */ React.createElement(AlertsTab, { boxAlerts, overviewAlerts, boxes, onOpenBox: setOpenBox }), tab === "water" && /* @__PURE__ */ React.createElement(WaterTab, { waterLogs, settings, onAddLog: (l) => persistWater([...waterLogs, l], [l.id]), onUpdateSettings: persistSettings }), tab === "feed" && /* @__PURE__ */ React.createElement(FeedTab, { boxes, settings, onUpdateBox: updateBox, onUpdateSettings: persistSettings }), tab === "history" && /* @__PURE__ */ React.createElement(HistoryTab, { history }), tab === "market" && /* @__PURE__ */ React.createElement(MarketHubTab, { marketPrices, customers, orders, boxes: activeBoxes, settings, onAddPrice: addMarketPrice, onDeletePrice: deleteMarketPrice, onSaveCustomer: saveCustomer, onDeleteCustomer: deleteCustomer, onSaveOrder: saveOrder, onDeleteOrder: deleteOrder }), tab === "assistant" && /* @__PURE__ */ React.createElement(AiAssistantTab, { boxes, activeBoxes, emptyBoxes, history, waterLogs, settings, financeTotal, totalBiomass, totalProfit }), tab === "settings" && /* @__PURE__ */ React.createElement(
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
