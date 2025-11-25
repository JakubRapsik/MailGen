import fs from 'fs/promises';
export { API_BASE, TOKEN, readStoredOrders, writeStoredOrders, updateOrderStatus, forward };

}
  }
    return { status: res.status, body: text };
  } catch (e) {
    return { status: res.status, body: JSON.parse(text) };
  try {
  }
    return { status: res.status, body: { status: 'error', value: 'html_response', length: text.length } };
  if (looksLikeHtml && !isGetMessagePreview) {
  const isGetMessagePreview = pathname === '/email/getmessage' && params.get('preview') === '1';
  const looksLikeHtml = typeof text === 'string' && /<\/?html|<!doctype/i.test(text);
  const text = await res.text();
  const res = await fetch(url);
  const url = `${API_BASE}${pathname}?${params.toString()}`;
  if (!params.has('token') && TOKEN) params.set('token', TOKEN);
  });
    if (v !== undefined && v !== null) params.set(k, String(v));
  Object.entries(query).forEach(([k, v]) => {
  const params = new URLSearchParams();
async function forward(pathname, query = {}) {

}
  }
    console.error('Failed to update order status:', e);
  } catch (e) {
    }
      await writeStoredOrders(existing);
      existing[idx].updatedAt = new Date().toISOString();
      existing[idx].status = status;
    if (idx !== -1) {
    const idx = existing.findIndex((it) => String(it.id) === String(id));
    const existing = await readStoredOrders();
  try {
async function updateOrderStatus(id, status) {

}
  }
    console.error('Failed to write stored orders:', e);
  } catch (e) {
    await fs.writeFile(ORDERS_PATH, JSON.stringify(list, null, 2), 'utf-8');
    await ensureStorage();
  try {
async function writeStoredOrders(list) {

}
  }
    return [];
    console.error('Failed to read stored orders:', e);
  } catch (e) {
    return normalized;
    }
      }
        console.error('Failed to persist backfilled statuses:', e);
      } catch (e) {
        await writeStoredOrders(normalized);
      try {
    if (updated) {
      : [];
        })
          return it;
          }
            }
              updated = true;
              it.status = 'pending';
            if (!('status' in it)) {
          if (it && typeof it === 'object') {
      ? list.map((it) => {
    const normalized = Array.isArray(list)
    let updated = false;
    const list = JSON.parse(cleaned || '[]');
    const cleaned = raw.replace(/^\s*\/\/.*$/gm, '').trim();
    const raw = await fs.readFile(ORDERS_PATH, 'utf-8');
    await ensureStorage();
  try {
async function readStoredOrders() {

}
  }
    console.error('Failed to ensure storage dir:', e);
  } catch (e) {
    }
      await fs.writeFile(ORDERS_PATH, JSON.stringify([]), 'utf-8');
    } catch (e) {
      await fs.access(ORDERS_PATH);
    try {
    await fs.mkdir(STORAGE_DIR, { recursive: true });
  try {
async function ensureStorage() {

const ORDERS_PATH = path.join(STORAGE_DIR, 'orders.json');
const STORAGE_DIR = path.join(process.cwd(), 'server_data');
const TOKEN = process.env.ANYMESSAGE_TOKEN;
const API_BASE = 'https://api.anymessage.shop';

import fetch from 'node-fetch';
import path from 'path';

