// javascript
import fs from 'fs/promises';
import path from 'path';
import fetch from 'node-fetch';
import os from 'os';
import { kv } from '@vercel/kv';
// Try to use official Upstash SDK when available for more reliable auth
let UpstashRedis;
try {
    // lazy require so local dev without dependency won't crash static analysis
    // eslint-disable-next-line import/no-extraneous-dependencies, node/no-extraneous-import
    UpstashRedis = await import('@upstash/redis').then(m => m.Redis).catch(() => null);
} catch (e) {
    UpstashRedis = null;
}

const API_BASE = 'https://api.anymessage.shop';
const TOKEN = process.env.ANYMESSAGE_TOKEN;

const STORAGE_DIR = path.join(process.cwd(), 'server_data');
const ORDERS_PATH = path.join(STORAGE_DIR, 'orders.json');
// Accept multiple env var names (compat with Vercel KV / Upstash and REDIS_URL aliases)
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || process.env.KV_URL || process.env.REDIS_URL || null;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || process.env.KV_REST_API_READ_ONLY_TOKEN || null;
const TMP_ORDERS_PATH = path.join(os.tmpdir(), 'orders.json');

// compute Upstash commands endpoint robustly
function upstashCommandsUrl() {
    if (!UPSTASH_URL) return null;
    // if the provided URL already contains /commands, use as-is
    if (UPSTASH_URL.includes('/commands')) return UPSTASH_URL.replace(/\/+$|\?token=.*$/,'');
    return UPSTASH_URL.replace(/\/+$/, '') + '/commands';
}

function upstashBaseUrl() {
    if (!UPSTASH_URL) return null;
    // remove trailing /commands if present
    return UPSTASH_URL.replace(/\/commands\/?$/i, '').replace(/\/+$/, '');
}

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

// helper: Upstash SDK client
// Use a cached singleton to avoid creating multiple clients across requests
let _cachedUpstashClient = null;
function getUpstashClient() {
    if (_cachedUpstashClient) return _cachedUpstashClient;

    if (!UpstashRedis) return null;

    try {
        // Prefer the SDK helper that reads from env (Redis.fromEnv()) if available
        if (typeof UpstashRedis.fromEnv === 'function') {
            try {
                _cachedUpstashClient = UpstashRedis.fromEnv();
                return _cachedUpstashClient;
            } catch (e) {
                // If fromEnv fails for any reason, fall back to explicit constructor below
                console.warn('[getUpstashClient] Redis.fromEnv() failed, falling back to explicit constructor:', e?.message ?? e);
            }
        }

        // If fromEnv isn't available or failed, try constructing with explicit url/token
        if (UPSTASH_URL && UPSTASH_TOKEN) {
            _cachedUpstashClient = new UpstashRedis({ url: UPSTASH_URL, token: UPSTASH_TOKEN });
            return _cachedUpstashClient;
        }

        // Last attempt: if REDIS_URL style (e.g., rediss://...) is present and UpstashRedis accepts it
        if (process.env.REDIS_URL && typeof UpstashRedis.fromEnv !== 'function') {
            try {
                _cachedUpstashClient = new UpstashRedis({ url: process.env.REDIS_URL, token: process.env.REDIS_PASSWORD || UPSTASH_TOKEN });
                return _cachedUpstashClient;
            } catch (e) {
                // ignore and return null below
            }
        }

        return null;
    } catch (e) {
        console.error('[getUpstashClient] failed to create client:', e?.message ?? e);
        return null;
    }
}

export { getUpstashClient };

async function upstashGetOrders() {
    // prefer SDK client if available
    const sdk = getUpstashClient();
    if (sdk) {
        try {
            console.log('[upstashGetOrders] using Upstash SDK client');
            const val = await sdk.get('orders');
            if (!val) return [];
            // sdk may return object/value directly or JSON string
            if (typeof val === 'string') {
                try {
                    return JSON.parse(val);
                } catch (e) {
                    console.warn('[upstashGetOrders] failed to parse KV JSON, falling back to Upstash/filesystem', e?.message ?? e);
                    // continue to fallbacks below (do not return [] here)
                }
            }
            // if it's object/array already
            return Array.isArray(val) ? val : [];
        } catch (e) {
            console.error('[upstashGetOrders] SDK client error, falling back to HTTP:', e);
            // fall through to HTTP fallback
        }
    }

    // Fallback to existing HTTP logic if SDK isn't usable
    const commandsUrl = upstashCommandsUrl();
    const baseUrl = upstashBaseUrl();
    if (!commandsUrl || !UPSTASH_TOKEN) return null;
    try {
        const redactedUrl = commandsUrl.replace(/([?&]token=)[^&]+/, '$1***REDACTED***');
        console.log('[upstashGetOrders] calling', redactedUrl, 'tokenPresent=', !!UPSTASH_TOKEN);

        // First attempt: Authorization header against /commands
        let res = await fetch(commandsUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${UPSTASH_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ command: 'GET', args: ['orders'] })
        });

        if (!res.ok) {
            let bodyText = await res.text().catch(() => '<no-body>');
            console.error(`[upstashGetOrders] Upstash responded with ${res.status}:`, bodyText);

            // If Upstash rejects COMMANDS route, retry using token as query param
            if (bodyText && /COMMANDS|Command is not available/i.test(bodyText)) {
                // Try /commands?token=...
                const urlWithToken = `${commandsUrl}?token=${encodeURIComponent(UPSTASH_TOKEN)}`;
                console.log('[upstashGetOrders] retrying with token in query param ->', urlWithToken.replace(/([?&]token=)[^&]+/, '$1***REDACTED***'));
                res = await fetch(urlWithToken, {
                    method: 'GET',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ command: 'GET', args: ['orders'] })
                });

                if (!res.ok) {
                    bodyText = await res.text().catch(() => '<no-body>');
                    console.error('[upstashGetOrders] retry with ?token also failed:', res.status, bodyText);

                    // If still failing and base URL is available, try REST GET endpoint (/get/:key)
                    if (baseUrl) {
                        const restGet = `${baseUrl}/get/orders?token=${encodeURIComponent(UPSTASH_TOKEN)}`;
                        console.log('[upstashGetOrders] trying REST GET endpoint ->', restGet.replace(/([?&]token=)[^&]+/, '$1***REDACTED***'));
                        const restRes = await fetch(restGet, { method: 'GET' });
                        if (!restRes.ok) {
                            const restBody = await restRes.text().catch(() => '<no-body>');
                            console.error('[upstashGetOrders] REST GET failed:', restRes.status, restBody);
                            throw new Error(`Upstash GET failed: ${res.status} ${bodyText}`);
                        }
                        const restJson = await restRes.json().catch(() => null);
                        if (!restJson) return [];
                        // restJson may have { result: '...' } or { items: ... }
                        const resultString = restJson.result ?? restJson.value ?? restJson["result"] ?? null;
                        if (!resultString) return [];
                        try {
                            return JSON.parse(resultString);
                        } catch (e) {
                            return [];
                        }
                    }

                    throw new Error(`Upstash GET failed: ${res.status} ${bodyText}`);
                }
            } else {
                throw new Error(`Upstash GET failed: ${res.status} ${bodyText}`);
            }
        }

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
    // prefer SDK client if available
    const sdk = getUpstashClient();
    if (sdk) {
        try {
            console.log('[upstashSetOrders] using Upstash SDK client');
            await sdk.set('orders', JSON.stringify(list));
            return true;
        } catch (e) {
            console.error('[upstashSetOrders] SDK client error, falling back to HTTP:', e);
            // fallthrough to HTTP fallback
        }
    }

    // Fallback to existing HTTP logic if SDK isn't usable
    const commandsUrl = upstashCommandsUrl();
    const baseUrl = upstashBaseUrl();
    if (!commandsUrl || !UPSTASH_TOKEN) return false;
    try {
        const redactedUrl = commandsUrl.replace(/([?&]token=)[^&]+/, '$1***REDACTED***');
        console.log('[upstashSetOrders] calling', redactedUrl, 'tokenPresent=', !!UPSTASH_TOKEN);

        const value = JSON.stringify(list);

        // First attempt: Authorization header against /commands
        let res = await fetch(commandsUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${UPSTASH_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ command: 'SET', args: ['orders', value] })
        });

        if (!res.ok) {
            let bodyText = await res.text().catch(() => '<no-body>');
            console.error(`[upstashSetOrders] Upstash responded with ${res.status}:`, bodyText);

            // If Upstash rejects COMMANDS route, retry using token as query param
            if (bodyText && /COMMANDS|Command is not available/i.test(bodyText)) {
                const urlWithToken = `${commandsUrl}?token=${encodeURIComponent(UPSTASH_TOKEN)}`;
                console.log('[upstashSetOrders] retrying with token in query param ->', urlWithToken.replace(/([?&]token=)[^&]+/, '$1***REDACTED***'));
                res = await fetch(urlWithToken, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ command: 'SET', args: ['orders', value] })
                });

                if (!res.ok) {
                    bodyText = await res.text().catch(() => '<no-body>');
                    console.error('[upstashSetOrders] retry with ?token also failed:', res.status, bodyText);

                    // try REST-style /set/:key endpoint if available
                    if (baseUrl) {
                        const restSet = `${baseUrl}/set/orders?token=${encodeURIComponent(UPSTASH_TOKEN)}`;
                        console.log('[upstashSetOrders] trying REST SET endpoint ->', restSet.replace(/([?&]token=)[^&]+/, '$1***REDACTED***'));
                        // Try posting raw JSON body
                        const restRes = await fetch(restSet, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: value
                        });
                        if (!restRes.ok) {
                            const restBody = await restRes.text().catch(() => '<no-body>');
                            console.error('[upstashSetOrders] REST SET failed:', restRes.status, restBody);
                            throw new Error(`Upstash SET failed: ${res.status} ${bodyText}`);
                        }
                        console.log('[upstashSetOrders] REST SET success');
                        return true;
                    }

                    throw new Error(`Upstash SET failed: ${res.status} ${bodyText}`);
                }
            } else {
                throw new Error(`Upstash SET failed: ${res.status} ${bodyText}`);
            }
        }

        const json = await res.json().catch(() => null);
        console.log('[upstashSetOrders] success', json ? json : 'no-json');
        return true;
    } catch (e) {
        console.error('Upstash SET error:', e);
        return false;
    }
}

// Prefer KV (Vercel KV) if configured, otherwise prefer Upstash, otherwise filesystem. On Vercel filesystem might be read-only
async function readStoredOrders() {
    // 1) Try Vercel KV
    try {
        if (kv) {
            try {
                const val = await kv.get('orders');
                console.log('[readStoredOrders] KV value type=', Array.isArray(val) ? 'array' : typeof val, 'length=', Array.isArray(val) ? val.length : 'n/a');

                // Treat undefined/null/empty-string as no value so we can fallback to Upstash or filesystem
                if (val === undefined || val === null || (typeof val === 'string' && val.trim() === '')) {
                    // continue to fallbacks below
                } else if (Array.isArray(val)) {
                    // If KV has an empty array but Upstash is configured, prefer Upstash (avoid silent empty override)
                    if (val.length === 0 && (UPSTASH_URL || process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL)) {
                        console.log('[readStoredOrders] KV returned empty array and Upstash configured -> falling through to Upstash');
                        // continue to fallbacks below
                    } else {
                        return val;
                    }
                } else if (typeof val === 'string') {
                    try {
                        const parsed = JSON.parse(val);
                        if (Array.isArray(parsed)) {
                            if (parsed.length === 0 && (UPSTASH_URL || process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL)) {
                                console.log('[readStoredOrders] KV JSON parsed to empty array and Upstash configured -> falling through to Upstash');
                                // continue to fallbacks
                            } else {
                                return parsed;
                            }
                        } else {
                            return Array.isArray(parsed) ? parsed : [];
                        }
                    } catch (e) {
                        console.warn('[readStoredOrders] failed to parse KV JSON, falling back to Upstash/filesystem', e?.message ?? e);
                        // continue to fallbacks below (do not return [] here)
                    }
                } else {
                    // other types (object) -> try to normalize to array
                    return Array.isArray(val) ? val : [];
                }
            } catch (e) {
                console.warn('[readStoredOrders] KV read failed, falling back:', e?.message ?? e);
            }
        }
    } catch (e) {
        // ignore if kv import or runtime not available
    }

    // 2) Try Upstash if configured
    try {
        const fromUpstash = await upstashGetOrders();
        if (fromUpstash !== null) return fromUpstash;
    } catch (e) {
        console.error('Upstash read failed, falling back to filesystem:', e);
    }

    // 3) Filesystem fallback: check tmp path first (in case writes went there), then repo path
    try {
        await ensureStorage();
    } catch (e) {
        // ignore
    }

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
    // 1) Try Vercel KV
    try {
        if (kv) {
            try {
                await kv.set('orders', JSON.stringify(list));
                console.log('[writeStoredOrders] wrote orders to Vercel KV');
                return;
            } catch (e) {
                console.warn('[writeStoredOrders] KV write failed, falling back:', e?.message ?? e);
            }
        }
    } catch (e) {
        // ignore
    }

    // 2) Try Upstash if configured
    try {
        if (UPSTASH_URL && UPSTASH_TOKEN) {
            const ok = await upstashSetOrders(list);
            if (ok) {
                console.log('[writeStoredOrders] wrote orders to Upstash');
                return;
            }
            // fallback to filesystem if Upstash fails
        }
    } catch (e) {
        console.error('Upstash write failed, falling back to filesystem:', e);
    }

    // 3) Filesystem fallback
    try {
        await ensureStorage();
        await fs.writeFile(ORDERS_PATH, JSON.stringify(list, null, 2), 'utf-8');
        return;
    } catch (e) {
        console.warn('Write to repo path failed, attempting to write to tmp dir:', e?.message ?? e);
    }

    try {
        await fs.writeFile(TMP_ORDERS_PATH, JSON.stringify(list, null, 2), 'utf-8');
        return;
    } catch (e) {
        console.error('Failed to write stored orders to tmp path:', e);
    }
}

async function updateOrderStatus(id, status) {
    try {
        // 1) Try Vercel KV (keep existing behavior)
        if (kv) {
            try {
                const val = await kv.get('orders');
                let list = [];
                if (val) {
                    if (typeof val === 'string') {
                        try {
                            list = JSON.parse(val);
                        } catch (e) {
                            list = [];
                        }
                    } else if (Array.isArray(val)) {
                        list = val;
                    }
                }
                const idx = list.findIndex((it) => String(it.id) === String(id));
                if (idx !== -1) {
                    list[idx].status = status;
                    list[idx].updatedAt = new Date().toISOString();
                    await kv.set('orders', JSON.stringify(list));
                    console.log('[updateOrderStatus] updated order in KV', id, status);
                    // still attempt to update Upstash too if configured so external store stays in sync
                    if (UPSTASH_URL && UPSTASH_TOKEN) {
                        try {
                            const upstashList = await upstashGetOrders();
                            if (Array.isArray(upstashList)) {
                                const ui = upstashList.findIndex((it) => String(it.id) === String(id));
                                if (ui !== -1) {
                                    upstashList[ui].status = status;
                                    upstashList[ui].updatedAt = new Date().toISOString();
                                    const ok = await upstashSetOrders(upstashList);
                                    if (ok) console.log('[updateOrderStatus] also updated order in Upstash', id, status);
                                } else {
                                    // id not present in Upstash: try to merge by writing the KV list to Upstash
                                    const ok = await upstashSetOrders(list);
                                    if (ok) console.log('[updateOrderStatus] synced KV -> Upstash', id, status);
                                }
                            }
                        } catch (e) {
                            console.warn('[updateOrderStatus] Upstash sync after KV update failed:', e?.message ?? e);
                        }
                    }
                    return;
                }
                // if not found in KV, continue to update other stores
            } catch (e) {
                console.warn('[updateOrderStatus] KV update failed, falling back:', e?.message ?? e);
            }
        }

        // 2) If Upstash configured, update it directly (preferred for external DB-only setups)
        if (UPSTASH_URL && UPSTASH_TOKEN) {
            try {
                const upstashList = await upstashGetOrders();
                if (Array.isArray(upstashList)) {
                    const idx = upstashList.findIndex((it) => String(it.id) === String(id));
                    if (idx !== -1) {
                        upstashList[idx].status = status;
                        upstashList[idx].updatedAt = new Date().toISOString();
                        const ok = await upstashSetOrders(upstashList);
                        if (ok) {
                            console.log('[updateOrderStatus] updated order in Upstash', id, status);
                            return;
                        } else {
                            console.warn('[updateOrderStatus] upstashSetOrders returned false');
                        }
                    } else {
                        // If order missing in Upstash, merge by reading preferred storage and writing combined list
                        const existing = await readStoredOrders();
                        const merged = Array.isArray(existing) ? existing.slice() : [];
                        const found = merged.findIndex((it) => String(it.id) === String(id));
                        if (found !== -1) {
                            merged[found].status = status;
                            merged[found].updatedAt = new Date().toISOString();
                        } else {
                            // not present anywhere -> append minimal entry
                            merged.push({ id: String(id), status, updatedAt: new Date().toISOString() });
                        }
                        const ok2 = await upstashSetOrders(merged);
                        if (ok2) {
                            console.log('[updateOrderStatus] merged and wrote orders to Upstash', id, status);
                            return;
                        }
                    }
                } else {
                    console.warn('[updateOrderStatus] upstashGetOrders returned null/non-array, falling back');
                }
            } catch (e) {
                console.error('[updateOrderStatus] Upstash update failed, falling back:', e);
            }
        }

        // 3) Fallback: read from preferred storage chain and write back (filesystem or other)
        const existing = await readStoredOrders();
        const idx = existing.findIndex((it) => String(it.id) === String(id));
        if (idx !== -1) {
            existing[idx].status = status;
            existing[idx].updatedAt = new Date().toISOString();
            await writeStoredOrders(existing);
            console.log('[updateOrderStatus] updated order in fallback storage', id, status);
        } else {
            // If not found anywhere, append minimal record to fallback store
            existing.push({ id: String(id), status, updatedAt: new Date().toISOString() });
            await writeStoredOrders(existing);
            console.log('[updateOrderStatus] appended new order record in fallback storage', id, status);
        }
    } catch (e) {
        console.error('Failed to update order status:', e);
    }
}

// Conservative helper to detect known upstream error objects so we avoid false-positives
function isLikelyErrorObject(obj) {
    if (!obj || typeof obj !== 'object') return false;
    const st = (obj.status ?? '').toString().toLowerCase();
    if (st === 'error') return true;
    const text = String(obj.value ?? obj.message ?? obj.result ?? '').toLowerCase().trim();
    if (!text) return false;
    // Known error indicators from upstream docs / examples
    // Matches exact token, or phrases like "activation canceled", "no activation", "token", "cancel"
    return /(^(token)$)|\btoken\b|activation canceled|no activation|no activ|cancel(ed)?\b/.test(text);
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
    const isGetMessage = pathname === '/email/getmessage';
    const forwardedId = params.get('id');

    console.log('[forward] upstream status=', res.status, 'bodyLength=', typeof text === 'string' ? text.length : 0, 'looksLikeHtml=', looksLikeHtml, 'isPreview=', isGetMessagePreview);

    // For explicit preview of getmessage return raw HTML/text so preview clients can render it
    if (isGetMessagePreview) {
        return { status: res.status, body: text };
    }

    // If we detect HTML for non-preview getmessage, treat it as a received message
    if (looksLikeHtml && !isGetMessagePreview) {
        console.warn('[forward] detected HTML response for non-preview request, returning html_response marker');

        if (isGetMessage && forwardedId) {
            try {
                await updateOrderStatus(forwardedId, 'success');
                console.log('[forward] updated order status ->', forwardedId, 'to success (html response)');
            } catch (e) {
                console.error('[forward] failed to update order status for html response:', e);
            }
        }

        return { status: res.status, body: { status: 'error', value: 'html_response', length: text.length } };
    }

    try {
        const parsed = JSON.parse(text);

        // If this is getmessage and parsed indicates a success, update order status
        if (isGetMessage && forwardedId) {
            const parsedStatus = parsed && (parsed.status ?? parsed.result ?? parsed.state);
            const hasMessageLike =
                parsed &&
                typeof parsed === 'object' &&
                (
                    parsed.value === 'html_response' ||
                    ((parsed.message || parsed.result || parsed.value) && !isLikelyErrorObject(parsed))
                );

            if (parsedStatus === 'success' || hasMessageLike) {
                try {
                    await updateOrderStatus(forwardedId, 'success');
                    console.log('[forward] updated order status ->', forwardedId, 'to success (json response)');
                } catch (e) {
                    console.error('[forward] failed to update order status for json response:', e);
                }
            }
        }

        return { status: res.status, body: parsed };
    } catch (e) {
        console.warn('[forward] failed to parse JSON, returning raw text body');

        // If parsing failed but this is getmessage and we have non-empty text, treat as message arrival
        if (isGetMessage && forwardedId && typeof text === 'string' && text.trim().length > 0) {
            try {
                await updateOrderStatus(forwardedId, 'success');
                console.log('[forward] updated order status ->', forwardedId, 'to success (raw text response)');
            } catch (err) {
                console.error('[forward] failed to update order status for raw text response:', err);
            }
        }

        return { status: res.status, body: text };
    }
}

export { API_BASE, TOKEN, readStoredOrders, writeStoredOrders, updateOrderStatus, forward, isLikelyErrorObject };
