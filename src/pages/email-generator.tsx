// typescriptreact
import { useEffect, useState , useRef } from "react";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import api from "@/hooks/use-anymessage-api";

export const EmailGenerator = () => {
    const FIXED_SITE = "reddit.com";
    const FIXED_DOMAIN = "gmail.com";

    const [countInput, setCountInput] = useState<string>("1");
    const [balance, setBalance] = useState<string | null>(null);
    const [orders, setOrders] = useState<Array<{ id: string; email?: string; site?: string; status?: string; createdAt?: string; updatedAt?: string }>>([]);
    const [loading, setLoading] = useState(false);
    const [messageStatus, setMessageStatus] = useState<"none" | "waiting" | "received" | "error">("none");
    const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [userError, setUserError] = useState<boolean>(false);
    const [statusMsg, setStatusMsg] = useState<string | null>(null);
    const [lastRawResponse, setLastRawResponse] = useState<string | null>(null);
    const [lastReorder, setLastReorder] = useState<any | null>(null);

    const scanningRef = useRef(false);

    // --- rate limiter for api.getMessage ---
    // Ensures at most one api.getMessage call every RATE_LIMIT_MS milliseconds.
    const RATE_LIMIT_MS = 5000; // 5 seconds
    const lastCallRef = useRef<number>(0);
    // queue holds keys: `${id}:${preview ? 1 : 0}`
    const queueRef = useRef<string[]>([]);
    const queuedMapRef = useRef<Map<string, Array<{ resolve: (v: any) => void; reject: (e: any) => void }>>>(new Map());
    const pendingTimerRef = useRef<number | null>(null);
    const inFlightRef = useRef<Map<string, Promise<any>>>(new Map());

    const makeKey = (id: string, preview: boolean) => `${id}:${preview ? 1 : 0}`;
    const parseKey = (key: string) => {
        const idx = key.lastIndexOf(":");
        const id = key.slice(0, idx);
        const preview = key.slice(idx + 1) === '1';
        return { id, preview };
    };
    const QUEUE_MAX = 100; // safety cap for queued distinct ids

     const scheduleProcess = () => {
        if (pendingTimerRef.current != null) return;
        const now = Date.now();
        const elapsed = now - (lastCallRef.current || 0);
        const delay = Math.max(0, RATE_LIMIT_MS - elapsed);
        pendingTimerRef.current = window.setTimeout(async () => {
            pendingTimerRef.current = null;
            const key = queueRef.current.shift();
            if (!key) return;
            const listeners = queuedMapRef.current.get(key) ?? [];
            // remove from queuedMap so further enqueues create new entry
            queuedMapRef.current.delete(key);
            lastCallRef.current = Date.now();
            const { id, preview } = parseKey(key);
            let promise: Promise<any>;
            try {
                // If another caller already started an in-flight fetch for this key, use it
                if (inFlightRef.current.has(key)) {
                    promise = inFlightRef.current.get(key)!;
                } else {
                    promise = api.getMessage(id, preview);
                    inFlightRef.current.set(key, promise);
                }
                const res = await promise;
                // resolve all listeners
                for (const l of listeners) l.resolve(res);
            } catch (e) {
                for (const l of listeners) l.reject(e);
            } finally {
                inFlightRef.current.delete(key);
                if (queueRef.current.length > 0) scheduleProcess();
            }
        }, delay);
    };

    const getMessageRateLimited = (id: string, preview = false): Promise<any> => {
         const key = makeKey(id, preview);

         // If already in flight, return existing promise
         const inFlight = inFlightRef.current.get(key);
         if (inFlight) return inFlight;

         const now = Date.now();
         if (!lastCallRef.current || now - lastCallRef.current >= RATE_LIMIT_MS) {
             // call immediately and store in-flight so duplicates coalesce
             const p = api.getMessage(id, preview).finally(() => {
                 // nothing here; scheduleProcess / callers will handle deletion
             });
             inFlightRef.current.set(key, p);
             // ensure after completion we delete the inFlight entry
             p.then(() => inFlightRef.current.delete(key)).catch(() => inFlightRef.current.delete(key));
             return p;
         }

         // otherwise enqueue and coalesce duplicates by key
        // If queue is already large, avoid adding new distinct ids — return a quick "wait" response
        if (queueRef.current.length >= QUEUE_MAX && !queuedMapRef.current.has(key)) {
            return Promise.resolve({ status: 'error', value: 'wait message' });
        }

        return new Promise((resolve, reject) => {
             const existing = queuedMapRef.current.get(key);
             if (existing) {
                 existing.push({ resolve, reject });
             } else {
                 queuedMapRef.current.set(key, [{ resolve, reject }]);
                 queueRef.current.push(key);
                 scheduleProcess();
             }
         });
     };
     // --- end rate limiter ---

    useEffect(() => {
        // Only consider orders that are explicitly pending
        const pending = orders.filter((o) => o.status === 'pending');
        if (pending.length === 0) return;

        let cancelled = false;
        const BATCH_SIZE = 3; // scan only this many pending orders per run to avoid huge queues
        const scanOnce = async () => {
            if (scanningRef.current) return;
            scanningRef.current = true;
            try {
                const toCheck = pending.slice(0, BATCH_SIZE);
                for (const o of toCheck) {
                    if (cancelled) break;
                    try {
                        // use rate-limited getMessage to avoid bursts
                        const res = await getMessageRateLimited(o.id, false);
                        if (!res) continue;

                        const isRawString = typeof res === 'string' && res.trim().length > 0;
                        const isObjectMsg =
                            res && typeof res === 'object' && (
                                res.status === 'success' ||
                                res.value === 'html_response' ||
                                !!res.message
                            );

                        if (isRawString || isObjectMsg) {
                            if (isRawString) setLastRawResponse(res);
                            if (selectedMessageId === o.id) setMessageStatus('received');

                            try {
                                await fetch(`/api/orders/mark-success?id=${encodeURIComponent(o.id)}`, { method: 'POST' });
                            } catch (e) {
                                console.warn('[scanOnce] mark-success failed for', o.id, e);
                            }

                            await new Promise((r) => setTimeout(r, 600));
                            await fetchStoredOrdersRateLimited().catch((e) => console.warn('refresh orders failed:', e));
                        }
                    } catch (e) {
                        // ignore per-order errors
                    }
                }
            } finally {
                scanningRef.current = false;
            }
        };

        scanOnce();
        const id = setInterval(scanOnce, 10000);
        return () => {
            cancelled = true;
            clearInterval(id);
            scanningRef.current = false;
        };
    }, [orders, selectedMessageId]);

    type Toast = { id: string; message: string; variant?: "info" | "success" | "error" | "warning" };
    const [toasts, setToasts] = useState<Toast[]>([]);

    const showToast = (message: string, variant: Toast["variant"] = "info", duration = 10000) => {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const t: Toast = { id, message, variant };
        setToasts((s) => [t, ...s]);
        setTimeout(() => setToasts((s) => s.filter((x) => x.id !== id)), duration);
    };

    const removeToast = (id: string) => setToasts((s) => s.filter((t) => t.id !== id));

    const fetchStoredOrders = async () => {
        try {
            const url = `/api/stored-orders?_ts=${Date.now()}`;
            const res = await fetch(url);
            if (!res.ok) {
                console.warn(`Failed to fetch stored orders: ${res.status}`);
                return;
            }
            const data = await res.json();
            setOrders(
                Array.isArray(data)
                    ? data.map((d: any) => ({
                        id: String(d.id),
                        email: d.email,
                        site: d.site ?? undefined,
                        status: d.status ?? undefined,
                        createdAt: d.createdAt ?? undefined,
                        updatedAt: d.updatedAt ?? undefined,
                    }))
                    : [],
            );
        } catch (e: any) {
            console.warn('Failed to fetch stored orders:', e);
        }
    };

    // Rate-limited wrapper: fetch stored orders at most once every FETCH_STORED_ORDERS_MIN_MS
    const FETCH_STORED_ORDERS_MIN_MS = 3000; // 3 seconds
    const lastFetchOrdersRef = useRef<number>(0);
    const pendingFetchOrdersTimerRef = useRef<number | null>(null);

    const fetchStoredOrdersRateLimited = async (): Promise<void | null> => {
        const now = Date.now();
        const elapsed = now - (lastFetchOrdersRef.current || 0);
        if (!lastFetchOrdersRef.current || elapsed >= FETCH_STORED_ORDERS_MIN_MS) {
            // call immediately
            lastFetchOrdersRef.current = Date.now();
            if (pendingFetchOrdersTimerRef.current) {
                clearTimeout(pendingFetchOrdersTimerRef.current);
                pendingFetchOrdersTimerRef.current = null;
            }
            return fetchStoredOrders();
        }

        // schedule a single delayed fetch if not already scheduled
        if (pendingFetchOrdersTimerRef.current == null) {
            const delay = Math.max(0, FETCH_STORED_ORDERS_MIN_MS - elapsed);
            pendingFetchOrdersTimerRef.current = window.setTimeout(() => {
                pendingFetchOrdersTimerRef.current = null;
                lastFetchOrdersRef.current = Date.now();
                fetchStoredOrders().catch((e) => console.warn('refresh orders failed (deferred):', e));
            }, delay);
        }
        return Promise.resolve(null);
    };

    useEffect(() => {
        setError(null);
        setUserError(false);
        (async () => {
            setLoading(true);
            try {
                const res = await api.getBalance();
                if (res?.status === "success") {
                    setBalance(String(res.balance ?? res.data ?? "0"));
                } else {
                    console.warn('Failed to fetch balance on init:', res);
                    setBalance(null);
                    showToast('Failed to load balance', 'warning');
                }
            } catch (e: any) {
                console.warn('Failed to fetch balance on init:', e);
                showToast('Failed to load balance', 'warning');
            } finally {
                setLoading(false);
            }
        })();

        fetchStoredOrdersRateLimited();

        const intervalMs = 15000;
        const id = setInterval(() => {
            fetchStoredOrdersRateLimited().catch((e) => console.warn('Failed to refresh orders via poll:', e));
        }, intervalMs);
        return () => clearInterval(id);
    }, []);

    useEffect(() => {
        if (!selectedMessageId) return;
        if (messageStatus !== 'waiting') return;

        let cancelled = false;
        const interval = setInterval(async () => {
            try {
                const res = await getMessageRateLimited(selectedMessageId, false);
                if (cancelled) return;
                if (res && typeof res === 'object' && res.status === 'success') {
                    setMessageStatus('received');
                } else if (typeof res === 'string') {
                    setMessageStatus('received');
                }
            } catch (e) {
            }
        }, 10000);

        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [selectedMessageId, messageStatus]);

    const [orderingProgress, setOrderingProgress] = useState<number | null>(null);

    const handleOrder = async () => {
        const times = Math.max(1, Math.min(50, Math.floor(Number(countInput || 1))));
        setLoading(true);
        setError(null);
        setUserError(false);
        setOrderingProgress(0);
        let succeeded = 0;
        try {
            for (let i = 0; i < times; i++) {
                setOrderingProgress(i + 1);
                const res = await api.orderEmail(FIXED_SITE, FIXED_DOMAIN);
                if (res?.status === "success") {
                    succeeded++;
                    showToast(`Ordered ${res.email}`, 'success', 2000);
                } else if (typeof res === "string") {
                    setLastRawResponse(res);
                    showToast('Server returned an HTML response — click Download to inspect', 'warning');
                } else if (res && typeof res === 'object' && res.value === 'html_response') {
                    showToast(`HTML response (len ${res.length ?? 'unknown'})`, 'warning');
                } else {
                    setError(JSON.stringify(res));
                    setUserError(true);
                }
            }
            await fetchStoredOrdersRateLimited();
            setStatusMsg(`Ordered ${succeeded} of ${times}`);
            setTimeout(() => setStatusMsg(null), 4000);
         } catch (e: any) {
            setError(String(e?.message ?? e));
            setUserError(true);
        } finally {
            setOrderingProgress(null);
            setLoading(false);
        }
    };

    const handleGetMessage = async (id: string) => {
        setLoading(true);
        setError(null);
        setMessageStatus("none");
        setSelectedMessageId(id);
        try {
            const res: any = await getMessageRateLimited(id, false);

            if (res == null) {
                setMessageStatus("error");
                showToast("Empty response", "warning");
            } else if (typeof res === "string") {
                setLastRawResponse(res);
                showToast('Message returned as raw HTML — open or download to view', 'info');
                setMessageStatus("received");
                try {
                    await fetch(`/api/orders/mark-success?id=${encodeURIComponent(id)}`, { method: 'POST' });
                } catch (e) {
                    console.warn('[handleGetMessage] mark-success failed for', id, e);
                }
                await fetchStoredOrdersRateLimited();
            } else if (res?.status === "error") {
                if (String(res.value).toLowerCase().includes("wait")) {
                    // try short immediate polling before falling back to background waiting
                    const found = await pollForMessage(id);
                    if (!found) {
                        setMessageStatus("waiting");
                        showToast('Message not received yet — continuing to poll in background', 'info');
                    }
                } else {
                    setMessageStatus("error");
                    setError(JSON.stringify(res));
                    setUserError(true);
                }
            } else if (res?.status === "success" || res?.value === 'html_response') {
                setMessageStatus("received");
                try {
                    await fetch(`/api/orders/mark-success?id=${encodeURIComponent(id)}`, { method: 'POST' });
                } catch (e) {
                    console.warn('[handleGetMessage] mark-success failed for', id, e);
                }
                await fetchStoredOrdersRateLimited();
            } else {
                setMessageStatus("error");
                setError(JSON.stringify(res));
                setUserError(true);
            }
        } catch (e: any) {
            setMessageStatus("error");
            setError(String(e?.message ?? e));
            setUserError(true);
        } finally {
            setLoading(false);
        }
    };

    // Poll for a message. If preview=true, returns the HTML string when found; otherwise returns true/false.
    const pollForMessage = async (id: string, attempts = 6, intervalMs = 3000, preview = false): Promise<string | boolean> => {
        // mark the message as selected so UI reflects which id we're waiting for
        setSelectedMessageId(id);
        for (let i = 0; i < attempts; i++) {
            try {
                const url = `/api/email/getmessage?id=${encodeURIComponent(id)}${preview ? '&preview=1' : ''}`;
                const res = await fetch(url);
                if (!res.ok) {
                    // non-200 — treat like not ready and retry
                    console.warn('[pollForMessage] non-200', res.status);
                } else {
                    const text = await res.text();
                    // try parse JSON first
                    let parsed: any = null;
                    try { parsed = JSON.parse(text); } catch (e) { parsed = null; }

                    // If preview mode and we have raw HTML (or parsed.message), return the HTML text directly
                    if (preview) {
                        if (parsed == null && text.trim().length > 0) {
                            setLastRawResponse(text);
                            setMessageStatus('received');
                            try { await fetch(`/api/orders/mark-success?id=${encodeURIComponent(id)}`, { method: 'POST' }); } catch (e) { console.warn('[pollForMessage] mark-success failed', e); }
                            await fetchStoredOrdersRateLimited().catch((e) => console.warn('refresh orders failed:', e));
                            return text;
                        }
                        if (parsed && typeof parsed === 'object') {
                            if (parsed.status === 'success' || parsed.value === 'html_response' || parsed.message) {
                                const body = typeof parsed.message === 'string' ? parsed.message : text;
                                setLastRawResponse(body);
                                setMessageStatus('received');
                                try { await fetch(`/api/orders/mark-success?id=${encodeURIComponent(id)}`, { method: 'POST' }); } catch (e) { console.warn('[pollForMessage] mark-success failed', e); }
                                await fetchStoredOrdersRateLimited().catch((e) => console.warn('refresh orders failed:', e));
                                return body;
                            }
                            if (parsed.status === 'error') {
                                const val = String(parsed.value ?? parsed.error ?? '').toLowerCase();
                                if (val.includes('wait') || val.includes('not ready')) {
                                    // continue polling
                                } else {
                                    showToast(`Reorder fetch failed: ${String(parsed.value ?? parsed.error ?? JSON.stringify(parsed))}`, 'error');
                                    setError(JSON.stringify(parsed));
                                    setUserError(true);
                                    return false;
                                }
                            }
                        }
                    } else {
                        // non-preview mode: detect success object or raw string
                        if (parsed == null && text.trim().length > 0) {
                            setLastRawResponse(text);
                            setMessageStatus('received');
                            try { await fetch(`/api/orders/mark-success?id=${encodeURIComponent(id)}`, { method: 'POST' }); } catch (e) { console.warn('[pollForMessage] mark-success failed', e); }
                            await fetchStoredOrdersRateLimited().catch((e) => console.warn('refresh orders failed:', e));
                            return true;
                        }
                        if (parsed && typeof parsed === 'object') {
                            if (parsed.status === 'success' || parsed.value === 'html_response' || parsed.message) {
                                setMessageStatus('received');
                                if (typeof parsed.message === 'string') setLastRawResponse(parsed.message);
                                try { await fetch(`/api/orders/mark-success?id=${encodeURIComponent(id)}`, { method: 'POST' }); } catch (e) { console.warn('[pollForMessage] mark-success failed', e); }
                                await fetchStoredOrdersRateLimited().catch((e) => console.warn('refresh orders failed:', e));
                                return true;
                            }
                            if (parsed.status === 'error') {
                                const val = String(parsed.value ?? parsed.error ?? '').toLowerCase();
                                if (val.includes('wait') || val.includes('not ready')) {
                                    // continue polling
                                } else {
                                    showToast(`Reorder fetch failed: ${String(parsed.value ?? parsed.error ?? JSON.stringify(parsed))}`, 'error');
                                    setError(JSON.stringify(parsed));
                                    setUserError(true);
                                    return false;
                                }
                            }
                        }
                    }
                }
            } catch (e: any) {
                console.warn('[pollForMessage] attempt failed for', id, e);
            }

            // delay before next attempt
            await new Promise((r) => setTimeout(r, intervalMs));
        }
        return false;
    };

    // New: reorder handler - calls API (by id or by email+site), refreshes orders and attempts to fetch the new message
    const handleReorder = async (order: { id: string; email?: string; site?: string }) => {
        setLoading(true);
        setError(null);
        setUserError(false);
        try {
            let res: any;
            if (order.id) {
                res = await api.reorderEmailById(order.id);
            } else if (order.email && order.site) {
                res = await api.reorderEmailByEmail(order.email, order.site);
            } else {
                setError('Cannot reorder: missing id or email/site');
                setUserError(true);
                return;
            }

            if (res == null) {
                showToast('Empty response from reorder', 'warning');
                setError('Empty response from reorder');
                setUserError(true);
            } else if (typeof res === 'string') {
                setLastRawResponse(res);
                showToast('Reorder returned raw HTML — open or download to inspect', 'warning');
            } else if (res?.status === 'success') {
                // Save the full response so user can inspect it (object -> pretty JSON) and keep parsed object
                try {
                    setLastRawResponse(typeof res === 'object' ? JSON.stringify(res, null, 2) : String(res));
                } catch (e) {
                    setLastRawResponse(String(res));
                }
                setLastReorder(res ?? null);
                showToast(`Reorder successful${res.id ? ' — id: ' + res.id + (res.email ? ', email: ' + res.email : '') : ''}`, 'success');
                // refresh orders list (rate-limited helper)
                await fetchStoredOrdersRateLimited();
                // If server returned a new id, attempt to fetch the message using the existing handler
                // which will use getMessageRateLimited and fall back to polling if needed.
                if (res.id) {
                    // Kick off the normal get-message flow which already handles 'wait message' by polling
                    await handleGetMessage(String(res.id));
                }
             } else if (res?.status === 'error') {
                const val = String(res.value ?? res.error ?? JSON.stringify(res));
                showToast(`Reorder failed: ${val}`, 'error');
                setError(JSON.stringify(res));
                setUserError(true);
                setLastReorder(res ?? null);
             } else {
                showToast('Unexpected reorder response', 'warning');
                setError(JSON.stringify(res));
                setUserError(true);
                setLastReorder(res ?? null);
             }
        } catch (e: any) {
            setError(String(e?.message ?? e));
            setUserError(true);
        } finally {
            setLoading(false);
        }
    };

    const handleCancel = async (id: string) => {
        setLoading(true);
        setError(null);
        try {
            const res = await api.cancelEmail(id);
            if (res?.status === "success") {
                await fetchStoredOrdersRateLimited();
                setStatusMsg(`Cancelled ${id}`);
                setTimeout(() => setStatusMsg(null), 3000);
            } else {
                setError(JSON.stringify(res));
                setUserError(true);
            }
        } catch (e: any) {
            setError(String(e?.message ?? e));
            setUserError(true);
        } finally {
            setLoading(false);
        }
    };

    // Helpers: open or download preview HTML (preview=1)
    async function openPreviewHtml(id?: string | null) {
        if (!id) return;
        try {
            const res = await fetch(`/api/email/getmessage?id=${encodeURIComponent(id)}&preview=1`);
            if (!res.ok) { setError(`Preview fetch failed: ${res.status}`); setUserError(true); return; }
            const text = await res.text();
            // try parse JSON to detect 'wait' responses
            let parsed: any = null;
            try { parsed = JSON.parse(text); } catch (e) { parsed = null; }

            if (parsed && parsed.status === 'error' && String(parsed.value).toLowerCase().includes('wait')) {
                // message not ready — try short polling (preview mode) and open the HTML if found
                const found = await pollForMessage(id, 6, 3000, true);
                if (typeof found === 'string') {
                    const blob = new Blob([found], { type: "text/html" });
                    const url = URL.createObjectURL(blob);
                    window.open(url, "_blank");
                    return;
                }
                // If pollForMessage returned true (non-preview) or false, fallback to re-fetching preview
                if (found === true) {
                    const r2 = await fetch(`/api/email/getmessage?id=${encodeURIComponent(id)}&preview=1`);
                    if (r2.ok) {
                        const html = await r2.text();
                        const blob = new Blob([html], { type: "text/html" });
                        const url = URL.createObjectURL(blob);
                        window.open(url, "_blank");
                        return;
                    }
                }
             }

            // otherwise treat response as HTML (or JSON containing html/message)
            const htmlText = (parsed && typeof parsed === 'object' && typeof parsed.message === 'string') ? parsed.message : text;
            const blob = new Blob([htmlText], { type: "text/html" });
            const url = URL.createObjectURL(blob);
            window.open(url, "_blank");
        } catch (e: any) {
            setError(String(e?.message ?? e));
            setUserError(true);
        }
    }

    async function downloadPreviewHtml(id?: string | null) {
        if (!id) return;
        try {
            const res = await fetch(`/api/email/getmessage?id=${encodeURIComponent(id)}&preview=1`);
            if (!res.ok) { setError(`Preview fetch failed: ${res.status}`); setUserError(true); return; }
            const text = await res.text();
            let parsed: any = null;
            try { parsed = JSON.parse(text); } catch (e) { parsed = null; }

            if (parsed && parsed.status === 'error' && String(parsed.value).toLowerCase().includes('wait')) {
                const found = await pollForMessage(id, 6, 3000, true);
                if (typeof found === 'string') {
                    const blob = new Blob([found], { type: "text/html" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `message-${id}.html`;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    URL.revokeObjectURL(url);
                    return;
                }
                if (found === true) {
                    const r2 = await fetch(`/api/email/getmessage?id=${encodeURIComponent(id)}&preview=1`);
                    if (r2.ok) {
                        const html = await r2.text();
                        const blob = new Blob([html], { type: "text/html" });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = `message-${id}.html`;
                        document.body.appendChild(a);
                        a.click();
                        a.remove();
                        URL.revokeObjectURL(url);
                        return;
                    }
                }

                 setMessageStatus('waiting');
                 showToast('Message not received yet — try again later', 'info');
                 return;
             }

            const htmlText = (parsed && typeof parsed === 'object' && typeof parsed.message === 'string') ? parsed.message : text;
            const blob = new Blob([htmlText], { type: "text/html" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `message-${id}.html`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch (e: any) {
            setError(String(e?.message ?? e));
            setUserError(true);
        }
    }

    const downloadLastResponse = () => {
        if (!lastRawResponse) return;
        try {
            const blob = new Blob([lastRawResponse], { type: 'text/html' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'raw-response.html';
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch (e) {
            showToast('Failed to download raw response', 'error');
        }
    };

    const openLastResponse = () => {
        if (!lastRawResponse) return;
        const blob = new Blob([lastRawResponse], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank');
    };

    return (
        <div className="flex h-dvh flex-col">
            <div className="flex gap-4 p-4">
                <div className="flex items-center gap-2">
                    <div className="text-sm">Site: <strong className="ml-1">{FIXED_SITE}</strong></div>
                    <div className="text-sm">Domain: <strong className="ml-1">{FIXED_DOMAIN}</strong></div>
                </div>
                <input
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={countInput}
                    onChange={(e) => {
                        const v = e.target.value;
                        if (v === "") {
                            setCountInput("");
                            return;
                        }
                        const digits = v.replace(/[^0-9]/g, "");
                        setCountInput(digits);
                    }}
                    onFocus={(e) => e.currentTarget.select()}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            handleOrder();
                        }
                    }}
                    onBlur={() => {
                        const n = Math.max(1, Math.min(50, Math.floor(Number(countInput || 1))));
                        setCountInput(String(n));
                    }}
                    placeholder="How many"
                    className="w-24 rounded border px-2 py-1"
                />
                <Button onClick={handleOrder} color="primary" size="md">
                    Order Email
                </Button>

                <div className="ml-auto flex items-center gap-2">
                    <div className="text-sm">Balance: {loading ? "..." : balance ?? "-"}</div>
                    <ButtonUtility onClick={() => fetchStoredOrdersRateLimited()} size="sm" color="secondary">Refresh Orders</ButtonUtility>
                </div>
            </div>

            {statusMsg && <div className="p-2 text-sm text-success">{statusMsg}</div>}
            {orderingProgress !== null && (
                <div className="p-2 text-sm">Ordering {orderingProgress} / {Math.max(1, Math.min(50, Math.floor(Number(countInput || 1))))}</div>
            )}

            <div className="flex flex-1 gap-4 p-4">
                <div className="w-1/3 overflow-auto rounded border p-2">
                    <h3 className="text-sm font-semibold">Orders</h3>
                    {orders.length === 0 && <div className="text-sm text-tertiary">No orders yet</div>}
                    <ul className="mt-2 space-y-2">
                        {orders.map((o) => (
                            <li key={o.id} className="flex items-start justify-between gap-2 rounded p-2 hover:bg-surface-50">
                                <div>
                                    <div className="text-sm font-medium">{o.email ?? o.id}</div>
                                    <div className="text-xs text-tertiary">
                                        {o.site ?? FIXED_SITE} · {o.status ?? 'pending'}{o.updatedAt ? ` · ${new Date(o.updatedAt).toLocaleString()}` : ''}
                                    </div>
                                </div>

                                <div className="flex flex-wrap items-center gap-2">
                                    <button
                                        title="Fetch message now"
                                        onClick={() => handleGetMessage(o.id)}
                                        className="rounded border px-2 py-1 text-xs"
                                    >
                                        Get message
                                    </button>

                                    <button
                                        title="Open HTML preview (uses preview=1)"
                                        onClick={() => openPreviewHtml(o.id)}
                                        className="rounded border px-2 py-1 text-xs"
                                    >
                                        Preview HTML
                                    </button>

                                    <button
                                        title="Download HTML preview"
                                        onClick={() => downloadPreviewHtml(o.id)}
                                        className="rounded border px-2 py-1 text-xs"
                                    >
                                        Download HTML
                                    </button>

                                    <button
                                        title="Reorder this activation/order"
                                        onClick={() => handleReorder(o)}
                                        className="rounded border px-2 py-1 text-xs"
                                        disabled={loading}
                                    >
                                        Reorder
                                    </button>

                                    <button
                                        title="Cancel this activation/order"
                                        onClick={() => handleCancel(o.id)}
                                        className="rounded border px-2 py-1 text-xs text-danger"
                                    >
                                        Cancel
                                    </button>
                                </div>
                            </li>
                        ))}
                    </ul>
                </div>

                <div className="flex-1 overflow-auto rounded border p-4">
                    <div className="flex items-center justify-between">
                        <h3 className="text-sm font-semibold">Message</h3>
                        <div className="flex items-center gap-2">
                            {selectedMessageId && <div className="text-xs text-tertiary">Selected: {selectedMessageId}</div>}
                        </div>
                    </div>

                    {error && userError && <div className="mt-2 text-sm text-danger">{error}</div>}
                    {error && !userError && <div className="mt-2 text-sm text-tertiary">{error}</div>}

                    {lastRawResponse && (
                        <div className="mt-2 flex gap-2">
                            <button onClick={openLastResponse} className="rounded border px-2 py-1 text-sm">Open raw</button>
                            <button onClick={downloadLastResponse} className="rounded border px-2 py-1 text-sm">Download raw response</button>
                        </div>
                    )}

                    <div aria-live="polite" className="fixed right-4 bottom-4 z-50 flex flex-col-reverse gap-2">
                        {toasts.map((t) => (
                            <div key={t.id} className={`max-w-xs w-full rounded p-2 shadow ${t.variant === 'success' ? 'bg-success-50 text-success' : t.variant === 'error' ? 'bg-error-50 text-error' : t.variant === 'warning' ? 'bg-warning-50 text-warning' : 'bg-brand-50 text-brand-700'}`}>
                                <div className="flex justify-between items-center">
                                    <div className="text-sm">{t.message}</div>
                                    <button onClick={() => removeToast(t.id)} className="ml-2 text-xs">x</button>
                                </div>
                            </div>
                        ))}
                    </div>

                    {messageStatus === "received" && selectedMessageId ? (
                        <div className="mt-4">
                            <div className="text-sm">Message received for {selectedMessageId}</div>
                            <div className="mt-2">
                                <Button onClick={() => openPreviewHtml(selectedMessageId)}>Open Preview</Button>
                                <ButtonUtility onClick={() => downloadPreviewHtml(selectedMessageId)} size="sm">Download</ButtonUtility>
                            </div>
                        </div>
                    ) : messageStatus === "waiting" ? (
                        <div className="mt-4 text-sm text-tertiary">Message not received yet — try again later</div>
                    ) : messageStatus === "error" ? (
                        <div className="mt-4 text-sm text-danger">{error ?? "Failed to fetch message"}</div>
                    ) : (
                        <div className="mt-4 text-sm text-tertiary">No message selected</div>
                    )}

                    {lastReorder && (
                        <div className="mt-4 rounded border bg-surface-50 p-2 text-sm">
                            <div className="font-medium">Last Reorder</div>
                            <div className="mt-1">
                                <ButtonUtility onClick={() => handleGetMessage(String(lastReorder.id))} size="sm" color="secondary">
                                    Fetch Message by Reorder ID
                                </ButtonUtility>
                            </div>
                            <div className="mt-2 text-xs text-tertiary">
                                ID: {lastReorder.id} · Email: {lastReorder.email} · Site: {lastReorder.site}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default EmailGenerator;
