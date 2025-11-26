import { useEffect, useState , useRef } from "react";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import api from "@/hooks/use-anymessage-api";

export const EmailGenerator = () => {
    // site and domain are fixed for the UI
    const FIXED_SITE = "reddit.com";
    const FIXED_DOMAIN = "gmail.com";
    // user can only enter how many emails to generate
    // use a string input to allow clearing the field while typing (prevents immediate clamp)
    const [countInput, setCountInput] = useState<string>("1");
    const [balance, setBalance] = useState<string | null>(null);
    const [orders, setOrders] = useState<Array<{ id: string; email: string; site?: string; status?: string; createdAt?: string; updatedAt?: string }>>([]);
    const [loading, setLoading] = useState(false);
    // preview is on-demand (no checkbox) to avoid accidental raw HTML rendering
    const [messageStatus, setMessageStatus] = useState<"none" | "waiting" | "received" | "error">("none");
    const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    // Whether the last error was user-triggered (persistent) or transient
    const [userError, setUserError] = useState<boolean>(false);
    // Small transient status message for user-visible success/info
    const [statusMsg, setStatusMsg] = useState<string | null>(null);
    // Store last raw (string) response so user can download/open it for debugging
    const [lastRawResponse, setLastRawResponse] = useState<string | null>(null);

    const scanningRef = useRef(false);

    useEffect(() => {
        // scan only orders that aren't already final
        const pending = orders.filter((o) => o.status !== 'success' && o.status !== 'canceled');
        if (pending.length === 0) return;

        let cancelled = false;
        const scanOnce = async () => {
            if (scanningRef.current) return; // avoid overlapping scans
            scanningRef.current = true;
            try {
                for (const o of pending) {
                    if (cancelled) break;
                    try {
                        const res = await api.getMessage(o.id, false); // non-preview so server can update DB
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

                            // ensure server marks status as success immediately
                            try {
                                await fetch(`/api/orders/mark-success?id=${encodeURIComponent(o.id)}`, { method: 'POST' });
                            } catch (e) {
                                console.warn('[scanOnce] mark-success failed for', o.id, e);
                            }

                            // small delay to avoid racing DB write, then refresh orders so UI sees 'success'
                            await new Promise((r) => setTimeout(r, 600));
                            await fetchStoredOrders().catch((e) => console.warn('refresh orders failed:', e));
                            // continue scanning remaining orders in same pass
                        }
                    } catch (e) {
                        // ignore per-order errors and continue
                    }
                }
            } finally {
                scanningRef.current = false;
            }
        };

        // run immediately then every 10s
        scanOnce();
        const id = setInterval(scanOnce, 10000);
        return () => {
            cancelled = true;
            clearInterval(id);
            scanningRef.current = false;
        };
    }, [orders, selectedMessageId]);

    // Lightweight toast system
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
            // add cache-busting query param to avoid CDN/browser 304 cached responses
            const url = `/api/stored-orders?_ts=${Date.now()}`;
            const res = await fetch(url);
            if (!res.ok) {
                // don't surface this as a persistent error to the user on refresh
                console.warn(`Failed to fetch stored orders: ${res.status}`);
                return;
            }
            const data = await res.json();
            // data is expected to be array of { id, email, site, status, createdAt, updatedAt }
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
            // don't block UI for stored orders - avoid setting persistent error on mount
         }
    };

    useEffect(() => {
        // clear any leftover error when the page mounts to avoid showing stale messages on refresh
        setError(null);
        setUserError(false);
         // fetch balance from proxy (proxy will attach token from .env)
         (async () => {
             setLoading(true);
             // Do not set persistent error for background balance fetch on mount; show brief statusMsg instead.
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

        // load stored orders on mount
        fetchStoredOrders();

        // client-side poller: refresh stored orders periodically so status changes made server-side are visible
        const intervalMs = 10000; // 10s
        const id = setInterval(() => {
            fetchStoredOrders().catch((e) => console.warn('Failed to refresh orders via poll:', e));
        }, intervalMs);
        return () => clearInterval(id);
    }, []);

    // Poll for message status when waiting
    useEffect(() => {
        if (!selectedMessageId) return;
        if (messageStatus !== 'waiting') return;

        let cancelled = false;
        const interval = setInterval(async () => {
            try {
                const res = await api.getMessage(selectedMessageId, false);
                if (cancelled) return;
                if (res && typeof res === 'object' && res.status === 'success') {
                    setMessageStatus('received');
                } else if (typeof res === 'string') {
                    // treat raw string as received
                    setMessageStatus('received');
                }
                // otherwise keep waiting
            } catch (e) {
                // ignore errors in polling
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
                    // persist is done server-side; we'll refresh stored orders after loop
                    showToast(`Ordered ${res.email}`, 'success', 2000);
                } else if (typeof res === "string") {
                    setLastRawResponse(res);
                    showToast('Server returned an HTML response — click Download to inspect', 'warning');
                    // continue attempting remaining orders
                } else if (res && typeof res === 'object' && res.value === 'html_response') {
                    showToast(`HTML response (len ${res.length ?? 'unknown'})`, 'warning');
                } else {
                    // other errors - show once
                    setError(JSON.stringify(res));
                    setUserError(true);
                }
            }
            // refresh stored orders from server
            await fetchStoredOrders();
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
            // annotate res as any to avoid TS2339 on `.status`
            const res: any = await api.getMessage(id, false);

            if (res == null) {
                setMessageStatus("error");
                showToast("Empty response", "warning");
            } else if (typeof res === "string") {
                // ... existing logic for string
                setLastRawResponse(res);
                showToast('Message returned as raw HTML — open or download to view', 'info');
                setMessageStatus("received");
                try {
                    await fetch(`/api/orders/mark-success?id=${encodeURIComponent(id)}`, { method: 'POST' });
                } catch (e) {
                    console.warn('[handleGetMessage] mark-success failed for', id, e);
                }
                await fetchStoredOrders();
            } else if (res?.status === "error") {
                if (String(res.value).toLowerCase().includes("wait")) {
                    setMessageStatus("waiting");
                } else {
                    setMessageStatus("error");
                    setError(JSON.stringify(res));
                    setUserError(true);
                }
            } else if (res?.status === "success") {
                setMessageStatus("received");
                await fetchStoredOrders();
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

    // Download or open preview HTML (on demand) to avoid auto-rendering large HTML
    const openPreviewHtml = async (id: string) => {
        try {
            const res = await fetch(`/api/email/getmessage?id=${encodeURIComponent(id)}&preview=1`);
            if (!res.ok) { setError(`Preview fetch failed: ${res.status}`); return; }
            const text = await res.text();
            // open in new tab as blob
            const blob = new Blob([text], { type: "text/html" });
            const url = URL.createObjectURL(blob);
            window.open(url, "_blank");
        } catch (e: any) {
            setError(String(e?.message ?? e));
            setUserError(true);
        }
    };

    const downloadPreviewHtml = async (id: string) => {
        try {
            const res = await fetch(`/api/email/getmessage?id=${encodeURIComponent(id)}&preview=1`);
            if (!res.ok) { setError(`Preview fetch failed: ${res.status}`); return; }
            const text = await res.text();
            const blob = new Blob([text], { type: "text/html" });
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
    };

    const handleCancel = async (id: string) => {
        setLoading(true);
        setError(null);
        try {
            const res = await api.cancelEmail(id);
            if (res?.status === "success") {
                await fetchStoredOrders();
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

    const handleReorder = async (id: string) => {
        setLoading(true);
        setError(null);
        try {
            const res = await api.reorderEmailById(id);
            if (res?.status === "success") {
                await fetchStoredOrders();
                setStatusMsg(`Reordered ${res.email ?? id}`);
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
                        // allow empty string while typing
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
                            // prevent form submission default
                            e.preventDefault();
                            handleOrder();
                        }
                    }}
                    onBlur={() => {
                        // clamp on blur to valid range
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
                    <ButtonUtility onClick={() => fetchStoredOrders()} size="sm" color="secondary">Refresh Orders</ButtonUtility>
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
                            <li key={o.id} className="flex items-center justify-between">
                                {/* Left: email + meta */}
                                <div className="flex-1 min-w-0">
                                    <button
                                        className="text-left text-sm text-primary underline block truncate"
                                        onClick={() => {
                                            handleGetMessage(o.id);
                                        }}
                                        title={o.email}
                                    >
                                        {o.email}
                                    </button>
                                    <div className="text-xs text-tertiary mt-1">
                                        {o.site && <span className="mr-2">{o.site}</span>}
                                        {o.createdAt && <span className="mr-2">{new Date(o.createdAt).toLocaleString()}</span>}
                                    </div>
                                </div>

                                {/* Middle: status column */}
                                <div className="w-32 flex-shrink-0 text-center">
                                    {o.status ? (
                                        <span
                                            title={o.updatedAt ? `Updated: ${new Date(o.updatedAt).toLocaleString()}` : undefined}
                                            className={`inline-block rounded px-2 py-0.5 text-xs ${
                                                o.status === 'success'
                                                    ? 'bg-success-50 text-success'
                                                    : o.status === 'pending'
                                                    ? 'bg-warning-50 text-warning'
                                                    : o.status === 'canceled'
                                                    ? 'bg-error-50 text-error'
                                                    : 'bg-tertiary-50 text-tertiary'
                                            }`}
                                        >
                                            {o.status}
                                        </span>
                                    ) : (
                                        <span className="text-xs text-tertiary">-</span>
                                    )}
                                </div>

                                {/* Right: action buttons */}
                                <div className="flex items-center gap-1 ml-4">
                                    <ButtonUtility onClick={() => handleCancel(o.id)} size="sm" color="secondary">
                                        Cancel
                                    </ButtonUtility>
                                    <ButtonUtility onClick={() => handleReorder(o.id)} size="sm" color="tertiary">
                                        Reorder
                                    </ButtonUtility>
                                </div>
                            </li>
                        ))}
                    </ul>
                </div>

                <div className="flex-1 overflow-auto rounded border p-4">
                    <div className="flex items-center justify-between">
                        <h3 className="text-sm font-semibold">Message</h3>
                        <div className="flex items-center gap-2">
                            <div className="text-xs text-tertiary">Message status & preview controls removed; use the Open/Download buttons when a message is received.</div>
                        </div>
                    </div>

                    {error && userError && <div className="mt-2 text-sm text-danger">{error}</div>}
                    {error && !userError && <div className="mt-2 text-sm text-tertiary">{error}</div>}

                    {/* If we captured a raw HTML response, show quick actions */}
                    {lastRawResponse && (
                        <div className="mt-2 flex gap-2">
                            <button onClick={openLastResponse} className="rounded border px-2 py-1 text-sm">Open raw response</button>
                            <button onClick={downloadLastResponse} className="rounded border px-2 py-1 text-sm">Download raw response</button>
                        </div>
                    )}

                    {/* Toast container */}
                    <div aria-live="polite" className="fixed right-4 bottom-4 z-50 flex flex-col-reverse gap-2">
                        {toasts.map((t) => (
                            <div key={t.id} className={`max-w-xs w-full rounded p-2 shadow ${t.variant === 'success' ? 'bg-success-50 text-success' : t.variant === 'error' ? 'bg-error-50 text-error' : t.variant === 'warning' ? 'bg-warning-50 text-warning' : 'bg-brand-50 text-brand-700'}`}>
                                <div className="flex items-center justify-between">
                                    <div className="text-xs">{t.message}</div>
                                    <button onClick={() => removeToast(t.id)} className="ml-2 text-xs opacity-70">✕</button>
                                </div>
                            </div>
                        ))}
                    </div>

                    {/* removed duplicate orders list from Message panel to avoid showing unintended content */}

                    {messageStatus === "received" && selectedMessageId ? (
                        <div className="mt-4">
                            <div className="text-sm text-success">Message received</div>
                            <div className="mt-2 flex gap-2">
                                <button className="rounded border px-2 py-1 text-sm" onClick={() => openPreviewHtml(selectedMessageId)}>Open HTML</button>
                                <button className="rounded border px-2 py-1 text-sm" onClick={() => downloadPreviewHtml(selectedMessageId)}>Download HTML</button>
                            </div>
                        </div>
                    ) : messageStatus === "waiting" ? (
                        <div className="mt-4 text-sm text-tertiary">Message not received yet — try again later</div>
                    ) : messageStatus === "error" ? (
                        <div className="mt-4 text-sm text-danger">{error ?? "Failed to fetch message"}</div>
                    ) : (
                        <div className="mt-4 text-sm text-tertiary">No message selected</div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default EmailGenerator;
