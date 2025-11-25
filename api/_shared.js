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
  try {
    // Upstash REST GET for a key: GET {url}/get/{key}?token={token}
    const base = UPSTASH_URL.replace(/\/$/, '');
    const url = `${base}/get/orders?token=${encodeURIComponent(UPSTASH_TOKEN)}`;
    console.log('[_shared] upstashGetOrders: calling', url);
    const res = await fetch(url, { method: 'GET' });
    const bodyText = await res.text();
    if (!res.ok) {
      console.error('[_shared] upstashGetOrders non-ok:', res.status, bodyText);
      return null;
    }
    let json;
    try {
      json = JSON.parse(bodyText);
    } catch (e) {
      console.warn('[_shared] upstashGetOrders: invalid JSON response', e, bodyText);
      return null;
    }
    // Upstash returns: { result: <value> } where result is the stored string
    if (!json || json.result == null) return [];
    try {
      return JSON.parse(json.result);
    } catch (e) {
      console.warn('[_shared] upstashGetOrders: parse error', e);
      return [];
    }
  } catch (e) {
    console.error('Upstash GET error:', e);
    return null;
  }
}

async function upstashSetOrders(list) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return false;
  try {
    const base = UPSTASH_URL.replace(/\/$/, '');
    const url = `${base}/set/orders?token=${encodeURIComponent(UPSTASH_TOKEN)}`;
    console.log('[_shared] upstashSetOrders: calling', url);
    const value = JSON.stringify(list);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value })
    });
    const bodyText = await res.text();
    if (!res.ok) {
      console.error('[_shared] upstashSetOrders non-ok:', res.status, bodyText);
      return false;
    }
    try {
      JSON.parse(bodyText);
    } catch (e) {
      // ignore
    }
    console.log('[_shared] upstashSetOrders: success');
    return true;
  } catch (e) {
    console.error('Upstash SET error:', e);
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
      if (ok) return;
      // fallback to filesystem if Upstash fails
    }
  } catch (e) {
    console.error('Upstash write failed, falling back to filesystem:', e);
  }

  // Try writing to repo path (works for local dev)
  try {
    await ensureStorage();
    await fs.writeFile(ORDERS_PATH, JSON.stringify(list, null, 2), 'utf-8');
    return;
  } catch (e) {
    console.warn('Write to repo path failed, attempting to write to tmp dir:', e?.message ?? e);
  }

  // Last resort: write to tmp dir (works on Vercel ephemeral filesystem for the running instance)
  try {
    await fs.writeFile(TMP_ORDERS_PATH, JSON.stringify(list, null, 2), 'utf-8');
    return;
  } catch (e) {
    console.error('Failed to write stored orders to tmp path:', e);
  }
}

async function updateOrderStatus(id, status) {
  try {
    const existing = await readStoredOrders();
    const idx = existing.findIndex((it) => String(it.id) === String(id));
    if (idx !== -1) {
      existing[idx].status = status;
      existing[idx].updatedAt = new Date().toISOString();
      await writeStoredOrders(existing);
    }
  } catch (e) {
    console.error('Failed to update order status:', e);
  }
}

// forward API requests to AnyMessage, attach token from env if not provided
async function forward(pathname, query = {}) {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([k, v]) => {
    if (v !== undefined && v !== null) params.set(k, String(v));
  });
  if (!params.has('token') && TOKEN) params.set('token', TOKEN);

  const url = `${API_BASE}${pathname}?${params.toString()}`;
  const res = await fetch(url);
  const text = await res.text();

  // Detect raw HTML responses
  const looksLikeHtml = typeof text === 'string' && /<\/?html|<!doctype/i.test(text);
  const isGetMessagePreview = pathname === '/email/getmessage' && params.get('preview') === '1';

  if (looksLikeHtml && !isGetMessagePreview) {
    return { status: res.status, body: { status: 'error', value: 'html_response', length: text.length } };
  }

  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch (e) {
    return { status: res.status, body: text };
  }
}

export { API_BASE, TOKEN, readStoredOrders, writeStoredOrders, updateOrderStatus, forward };
