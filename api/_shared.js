import fs from 'fs/promises';
import path from 'path';
import fetch from 'node-fetch';

const API_BASE = 'https://api.anymessage.shop';
const TOKEN = process.env.ANYMESSAGE_TOKEN;

const STORAGE_DIR = path.join(process.cwd(), 'server_data');
const ORDERS_PATH = path.join(STORAGE_DIR, 'orders.json');

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

async function readStoredOrders() {
  try {
    await ensureStorage();
    const raw = await fs.readFile(ORDERS_PATH, 'utf-8');
    // strip simple // comments and trim
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
    console.error('Failed to read stored orders:', e);
    return [];
  }
}

async function writeStoredOrders(list) {
  try {
    await ensureStorage();
    await fs.writeFile(ORDERS_PATH, JSON.stringify(list, null, 2), 'utf-8');
  } catch (e) {
    console.error('Failed to write stored orders:', e);
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
