import fs from 'fs/promises';
import path from 'path';
import fetch from 'node-fetch';
import os from 'os';

const API_BASE = 'https://api.anymessage.shop';
const TOKEN = process.env.ANYMESSAGE_TOKEN;

const STORAGE_DIR = path.join(process.cwd(), 'server_data');
const ORDERS_PATH = path.join(STORAGE_DIR, 'orders.json');
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const TMP_ORDERS_PATH = path.join(os.tmpdir(), 'orders.json');

// Debug: log whether Upstash env are set (masked)
console.log('[_shared] UPSTASH configured?', !!UPSTASH_URL, !!UPSTASH_TOKEN);

async function ensureStorage() {
  try {
    await fs.mkdir(STORAGE_DIR, { recursive: true });
    try {
      await fs.access(ORDERS_PATH);
    } catch (e) {
      await fs.writeFile(ORDERS_PATH, JSON.stringify([]), 'utf-8');
    }
  } catch (e) {
    console.error('Failed to ensure storage dir:', e);
  }
}

async function upstashGetOrders() {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  const base = UPSTASH_URL.replace(/\/$/, '');

  // Try Authorization header first (more reliable)
  const urlHeader = `${base}/get/orders`;
  try {
    console.log('[_shared] upstashGetOrders: trying Authorization header at', urlHeader);
    let res = await fetch(urlHeader, { method: 'GET', headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } });
    let bodyText = await res.text();
    if (res.ok) {
      let json;
      try {
        json = JSON.parse(bodyText);
      } catch (e) {
        console.warn('[_shared] upstashGetOrders: invalid JSON response', e, bodyText);
        return null;
      }
      if (!json || json.result == null) return [];
      // json.result may be a stringified array, or a stringified object like { value: '...'}
      try {
        const parsed = JSON.parse(json.result);
        if (Array.isArray(parsed)) return parsed;
        if (parsed && typeof parsed.value === 'string') {
          try {
            return JSON.parse(parsed.value);
          } catch (e) {
            console.warn('[_shared] upstashGetOrders: failed to parse nested value', e);
            return [];
          }
        }
        // unexpected shape
        console.warn('[_shared] upstashGetOrders: unexpected parsed shape', parsed);
        return [];
      } catch (e) {
        // json.result might already be the raw array string; try to parse directly
        try {
          const direct = JSON.parse(json.result);
          return Array.isArray(direct) ? direct : [];
        } catch (ee) {
          console.warn('[_shared] upstashGetOrders: failed to parse result', ee);
          return [];
        }
      }
    }

    console.warn('[_shared] upstashGetOrders: header call non-ok', res.status, bodyText);
  } catch (e) {
    console.error('[_shared] upstashGetOrders header attempt failed', e);
  }

  // Fallback to query-param method
  const urlQuery = `${base}/get/orders?token=${encodeURIComponent(UPSTASH_TOKEN)}`;
  try {
    console.log('[_shared] upstashGetOrders: trying query-param at', urlQuery);
    const res = await fetch(urlQuery, { method: 'GET' });
    const bodyText = await res.text();
    if (!res.ok) {
      console.error('[_shared] upstashGetOrders query call non-ok', res.status, bodyText);
      return null;
    }
    const json = JSON.parse(bodyText);
    if (!json || json.result == null) return [];
    try {
      const parsed = JSON.parse(json.result);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed.value === 'string') {
        try {
          return JSON.parse(parsed.value);
        } catch (e) {
          console.warn('[_shared] upstashGetOrders: failed to parse nested value', e);
          return [];
        }
      }
      return [];
    } catch (e) {
      try {
        const direct = JSON.parse(json.result);
        return Array.isArray(direct) ? direct : [];
      } catch (ee) {
        console.warn('[_shared] upstashGetOrders: failed to parse result', ee);
        return [];
      }
    }
  } catch (e) {
    console.error('Upstash GET error (query fallback):', e);
    return null;
  }
}

async function upstashSetOrders(list) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return false;
  const base = UPSTASH_URL.replace(/\/$/, '');
  const urlHeader = `${base}/set/orders`;
  const body = JSON.stringify({ value: JSON.stringify(list) });

  // Try Authorization header first
  try {
    console.log('[_shared] upstashSetOrders: trying Authorization header at', urlHeader);
    let res = await fetch(urlHeader, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${UPSTASH_TOKEN}` },
      body
    });
    let bodyText = await res.text();
    if (res.ok) {
      console.log('[_shared] upstashSetOrders: header call success');
      return true;
    }
    console.warn('[_shared] upstashSetOrders: header call non-ok', res.status, bodyText);
  } catch (e) {
    console.error('[_shared] upstashSetOrders header attempt failed', e);
  }

  // Fallback to query-param
  const urlQuery = `${base}/set/orders?token=${encodeURIComponent(UPSTASH_TOKEN)}`;
  try {
    console.log('[_shared] upstashSetOrders: trying query-param at', urlQuery);
    const res = await fetch(urlQuery, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });
    const bodyText = await res.text();
    if (!res.ok) {
      console.error('[_shared] upstashSetOrders query call non-ok', res.status, bodyText);
      return false;
    }
    console.log('[_shared] upstashSetOrders: query call success');
    return true;
  } catch (e) {
    console.error('Upstash SET error (query fallback):', e);
    return false;
  }
}

// Prefer Upstash if configured, otherwise filesystem. On Vercel filesystem might be read-only
async function readStoredOrders() {
  // Try Upstash first
  try {
    const fromUpstash = await upstashGetOrders();
    if (fromUpstash !== null) return fromUpstash;
  } catch (e) {
    console.error('Upstash read failed, falling back to filesystem:', e);
  }

  // Filesystem fallback: check tmp path first (in case writes went there), then repo path
  try {
    // Ensure existence of storage dir for local dev
    await ensureStorage();
  } catch (e) {
    // ignore
  }

  // Try tmp path
  try {
    const rawTmp = await fs.readFile(TMP_ORDERS_PATH, 'utf-8');
    const cleanedTmp = rawTmp.replace(/^\s*\/\/.*$/gm, '').trim();
    const parsedTmp = JSON.parse(cleanedTmp || '[]');
    return parsedTmp;
  } catch (_) {
    // ignore and try repo path
  }

  try {
    const raw = await fs.readFile(ORDERS_PATH, 'utf-8');
    const cleaned = raw.replace(/^\s*\/\/.*$/gm, '').trim();
    const list = JSON.parse(cleaned || '[]');
    // Backfill missing status fields to 'pending'
    let updated = false;
    const normalized = Array.isArray(list)
      ? list.map((it) => {
          if (it && typeof it === 'object') {
            if (!('status' in it)) {
              it.status = 'pending';
              updated = true;
            }
          }
          return it;
        })
      : [];
    if (updated) {
      try {
        await writeStoredOrders(normalized);
      } catch (e) {
        console.error('Failed to persist backfilled statuses:', e);
      }
    }
    return normalized;
  } catch (e) {
    console.error('Failed to read stored orders from filesystem:', e);
    return [];
  }
}

async function writeStoredOrders(list) {
  // If Upstash configured, try that first
  try {
    if (UPSTASH_URL && UPSTASH_TOKEN) {
      const ok = await upstashSetOrders(list);
      if (ok) {
        console.log('[_shared] writeStoredOrders: stored to Upstash');
        return true;
      }
      // fallback to filesystem if Upstash fails
      console.warn('[_shared] writeStoredOrders: Upstash failed, falling back to filesystem');
    }
  } catch (e) {
    console.error('Upstash write failed, falling back to filesystem:', e);
  }

  // Try writing to repo path (works for local dev)
  try {
    await ensureStorage();
    await fs.writeFile(ORDERS_PATH, JSON.stringify(list, null, 2), 'utf-8');
    console.log('[_shared] writeStoredOrders: wrote to ORDERS_PATH', ORDERS_PATH);
    return true;
  } catch (e) {
    console.warn('Write to repo path failed, attempting to write to tmp dir:', e?.message ?? e);
  }

  // Last resort: write to tmp dir (works on Vercel ephemeral filesystem for the running instance)
  try {
    await fs.writeFile(TMP_ORDERS_PATH, JSON.stringify(list, null, 2), 'utf-8');
    console.log('[_shared] writeStoredOrders: wrote to TMP_ORDERS_PATH', TMP_ORDERS_PATH);
    return true;
  } catch (e) {
    console.error('Failed to write stored orders to tmp path:', e);
  }

  return false;
}

// Add missing helpers and exports used by other API routes
async function updateOrderStatus(id, status) {
  try {
    if (!id) return false;
    const existing = await readStoredOrders();
    const idx = existing.findIndex((it) => String(it.id) === String(id));
    if (idx !== -1) {
      existing[idx].status = status;
      existing[idx].updatedAt = new Date().toISOString();
      await writeStoredOrders(existing);
      return true;
    }
    return false;
  } catch (e) {
    console.error('updateOrderStatus error:', e);
    return false;
  }
}

async function forward(path, query) {
  try {
    const url = new URL(API_BASE + path);
    if (query && typeof query === 'object') {
      Object.entries(query).forEach(([k, v]) => {
        if (v != null) url.searchParams.set(k, String(v));
      });
    }
    const headers = { 'Content-Type': 'application/json' };
    if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;

    const res = await fetch(url.toString(), { method: 'GET', headers });
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      return { status: res.status, body: json };
    } catch (e) {
      return { status: res.status, body: text };
    }
  } catch (e) {
    console.error('forward error:', e);
    return { status: 500, body: { status: 'error', message: String(e) } };
  }
}

export { forward, readStoredOrders, writeStoredOrders, updateOrderStatus, TOKEN };
