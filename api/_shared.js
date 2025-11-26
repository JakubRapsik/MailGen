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
    const res = await fetch(`${UPSTASH_URL}/commands`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${UPSTASH_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ command: 'GET', args: ['orders'] })
    });
    if (!res.ok) throw new Error(`Upstash GET failed: ${res.status}`);
    const json = await res.json();
    // json.result will be string value or null
    if (!json || json.result == null) return [];
    try {
      return JSON.parse(json.result);
    } catch (e) {
      // if stored as plain string, return as empty array
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
    const value = JSON.stringify(list);
    const res = await fetch(`${UPSTASH_URL}/commands`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${UPSTASH_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ command: 'SET', args: ['orders', value] })
    });
    if (!res.ok) throw new Error(`Upstash SET failed: ${res.status}`);
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
  const tokenPresent = params.has('token');
  const redactedUrl = url.replace(/([?&]token=)[^&]+/, '$1***REDACTED***');
  console.log('[forward] forwarding ->', redactedUrl, 'tokenPresent=', tokenPresent);

  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    console.error('[forward] fetch failed for', redactedUrl, e);
    throw e;
  }

  const text = await res.text();

  // Detect raw HTML responses
  const looksLikeHtml = typeof text === 'string' && /<\/?html|<!doctype/i.test(text);
  const isGetMessagePreview = pathname === '/email/getmessage' && params.get('preview') === '1';

  console.log('[forward] upstream status=', res.status, 'bodyLength=', typeof text === 'string' ? text.length : 0, 'looksLikeHtml=', looksLikeHtml, 'isPreview=', isGetMessagePreview);

  // For explicit preview of getmessage return raw HTML/text so preview clients can render it
  if (isGetMessagePreview) {
    return { status: res.status, body: text };
  }

  if (looksLikeHtml && !isGetMessagePreview) {
    console.warn('[forward] detected HTML response for non-preview request, returning html_response marker');
    return { status: res.status, body: { status: 'error', value: 'html_response', length: text.length } };
  }

  try {
    const parsed = JSON.parse(text);
    return { status: res.status, body: parsed };
  } catch (e) {
    console.warn('[forward] failed to parse JSON, returning raw text body');
    return { status: res.status, body: text };
  }
}

export { API_BASE, TOKEN, readStoredOrders, writeStoredOrders, updateOrderStatus, forward };
