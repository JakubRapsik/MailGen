type AnyMessageResponse = Record<string, any>;

async function safeFetch(path: string) {
    const res = await fetch(path);
    const text = await res.text();
    try {
        return JSON.parse(text) as AnyMessageResponse;
    } catch (e) {
        return text as any;
    }
}

export async function getBalance(/* token is handled by proxy */) {
    return safeFetch(`/api/user/balance`);
}

export async function getEmailQuantity(site: string) {
    return safeFetch(`/api/email/quantity?site=${encodeURIComponent(site)}`);
}

export async function orderEmail(site: string, domain?: string, regex?: string, subject?: string) {
    const params = new URLSearchParams({ site });
    if (domain) params.set("domain", domain);
    if (regex) params.set("regex", regex);
    if (subject) params.set("subject", subject);
    return safeFetch(`/api/email/order?${params.toString()}`);
}

// --- rate-limited, deduplicating getMessage ---
const RATE_LIMIT_MS = 5000; // 5s global minimum between actual fetches
let lastCallTs = 0;
let queue: Array<{ id: string; preview: boolean; resolve: (v: any) => void; reject: (e: any) => void }> = [];
let timer: ReturnType<typeof setTimeout> | null = null;
const inFlight: Map<string, Promise<any>> = new Map();
const QUEUE_MAX = 200; // safety cap

function scheduleNext() {
    if (timer) return;
    const now = Date.now();
    const elapsed = now - lastCallTs;
    const delay = Math.max(0, RATE_LIMIT_MS - elapsed);
    timer = setTimeout(async () => {
        timer = null;
        const item = queue.shift();
        if (!item) return;
        lastCallTs = Date.now();
        const key = `${item.id}:${item.preview ? 1 : 0}`;
        try {
            const p = safeFetch(`/api/email/getmessage?${new URLSearchParams({ id: item.id, ...(item.preview ? { preview: '1' } : {}) }).toString()}`);
            inFlight.set(key, p);
            const res = await p;
            inFlight.delete(key);
            item.resolve(res);
        } catch (e) {
            inFlight.delete(key);
            item.reject(e);
        } finally {
            if (queue.length > 0) scheduleNext();
        }
    }, delay);
}

export function getMessage(id: string, preview = false): Promise<any> {
    const key = `${id}:${preview ? 1 : 0}`;

    // If already in flight for same id+preview, return that promise
    const existing = inFlight.get(key);
    if (existing) return existing;

    // If queue already has an entry for same key, return a promise that will be resolved when that queue item runs
    const queued = queue.find((q) => `${q.id}:${q.preview ? 1 : 0}` === key);
    if (queued) {
        return new Promise((resolve, reject) => {
            // push a resolver that will be called when the queued item resolves
            // To keep it simple, we piggyback on the existing queued item by attaching a small wrapper: when the queued item runs it resolves its own promise only; here we return a promise and also push a helper that will be executed when the queued item resolves.
            // Implementation: push a tiny 'listener' as another queue entry with same key but without adding extra network calls.
            // However to avoid complexity, we instead push a new wrapper that will be resolved by the next scheduled call (may cause duplicates). For correctness and simplicity, if there's already queued same key, we just create a promise that periodically checks inFlight and resolves when response available.
            const waiter = setInterval(() => {
                const p = inFlight.get(key);
                if (p) {
                    // wait for the inFlight promise to settle and then resolve/reject accordingly
                    p.then(resolve).catch(reject).finally(() => clearInterval(waiter));
                }
            }, 50);
            // safety timeout
            setTimeout(() => { clearInterval(waiter); reject(new Error('getMessage timeout')); }, RATE_LIMIT_MS * 20);
        });
    }

    // If queue is too large, reject to prevent memory blowup
    if (queue.length >= QUEUE_MAX) {
        return Promise.reject(new Error('getMessage queue full'));
    }

    return new Promise((resolve, reject) => {
        queue.push({ id, preview, resolve, reject });
        scheduleNext();
    });
}

// --- end getMessage ---

export async function reorderEmailById(id: string) {
    return safeFetch(`/api/email/reorder?id=${encodeURIComponent(id)}`);
}

export async function reorderEmailByEmail(email: string, site: string) {
    return safeFetch(`/api/email/reorder?email=${encodeURIComponent(email)}&site=${encodeURIComponent(site)}`);
}

export async function cancelEmail(id: string) {
    return safeFetch(`/api/email/cancel?id=${encodeURIComponent(id)}`);
}

export default {
    getBalance,
    getEmailQuantity,
    orderEmail,
    getMessage,
    reorderEmailById,
    reorderEmailByEmail,
    cancelEmail,
};
