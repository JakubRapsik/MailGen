// typescriptreact
import { useEffect, useState, useRef } from "react";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import api from "@/hooks/use-anymessage-api";

export const EmailGenerator = () => {
    const FIXED_SITE = "reddit.com";
    const FIXED_DOMAIN = "gmail.com";

    const [countInput, setCountInput] = useState<string>("1");
    const [balance, setBalance] = useState<string | null>(null);
    const [orders, setOrders] = useState<
        Array<{
            id: string;
            email?: string;
            site?: string;
            status?: string;
            createdAt?: string;
            updatedAt?: string;
        }>
    >([]);
    const [loading, setLoading] = useState(false);
    const [messageStatus, setMessageStatus] = useState<"none" | "waiting" | "received" | "error">("none");
    const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [userError, setUserError] = useState<boolean>(false);
    const [statusMsg, setStatusMsg] = useState<string | null>(null);
    const [lastRawResponse, setLastRawResponse] = useState<string | null>(null);

    const scanningRef = useRef(false);

    useEffect(() => {
        const pending = orders.filter((o) => o.status !== "success" && o.status !== "canceled");
        if (pending.length === 0) return;

        let cancelled = false;
        const scanOnce = async () => {
            if (scanningRef.current) return;
            scanningRef.current = true;
            try {
                for (const o of pending) {
                    if (cancelled) break;
                    try {
                        const res = await api.getMessage(o.id, false);
                        if (!res) continue;

                        const isRawString = typeof res === "string" && res.trim().length > 0;
                        const isObjectMsg = res && typeof res === "object" && (res.status === "success" || res.value === "html_response" || (res.message || res.result || res.value));

                        if (isRawString || isObjectMsg) {
                            if (isRawString) setLastRawResponse(res as string);
                            if (selectedMessageId === o.id) setMessageStatus("received");

                            try {
                                await fetch(`/api/orders/mark-success?id=${encodeURIComponent(o.id)}`, { method: "POST" });
                            } catch (e) {
                                console.warn("[scanOnce] mark-success failed for", o.id, e);
                            }

                            await new Promise((r) => setTimeout(r, 600));
                            await fetchStoredOrders().catch((e) => console.warn("refresh orders failed:", e));
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
            console.warn("Failed to fetch stored orders:", e);
        }
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
                    console.warn("Failed to fetch balance on init:", res);
                    setBalance(null);
                    showToast("Failed to load balance", "warning");
                }
            } catch (e: any) {
                console.warn("Failed to fetch balance on init:", e);
                showToast("Failed to load balance", "warning");
            } finally {
                setLoading(false);
            }
        })();

        fetchStoredOrders();

        const intervalMs = 10000;
        const id = setInterval(() => {
            fetchStoredOrders().catch((e) => console.warn("Failed to refresh orders via poll:", e));
        }, intervalMs);
        return () => clearInterval(id);
    }, []);

    useEffect(() => {
        if (!selectedMessageId) return;
        if (messageStatus !== "waiting") return;

        let cancelled = false;
        const interval = setInterval(async () => {
            try {
                const res = await api.getMessage(selectedMessageId, false);
                if (cancelled) return;
                if (res && typeof res === "object" && res.status === "success") {
                    setMessageStatus("received");
                } else if (typeof res === "string") {
                    setMessageStatus("received");
                }
            } catch (e) {
                // ignore
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
                    showToast(`Ordered ${res.email}`, "success", 2000);
                } else if (typeof res === "string") {
                    setLastRawResponse(res);
                    showToast("Server returned an HTML response — click Download to inspect", "warning");
                } else if (res && typeof res === "object" && res.value === "html_response") {
                    showToast(`HTML response (len ${res.length ?? "unknown"})`, "warning");
                } else {
                    setError(JSON.stringify(res));
                    setUserError(true);
                }
            }
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
            const res: any = await api.getMessage(id, false);

            if (res == null) {
                setMessageStatus("error");
                showToast("Empty response", "warning");
            } else if (typeof res === "string") {
                setLastRawResponse(res);
                showToast("Message returned as raw HTML — open or download to view", "info");
                setMessageStatus("received");
                try {
                    await fetch(`/api/orders/mark-success?id=${encodeURIComponent(id)}`, { method: "POST" });
                } catch (e) {
                    console.warn("[handleGetMessage] mark-success failed for", id, e);
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
            } else if (res?.status === "success" || res?.value === "html_response") {
                setMessageStatus("received");
                try {
                    await fetch(`/api/orders/mark-success?id=${encodeURIComponent(id)}`, { method: "POST" });
                } catch (e) {
                    console.warn("[handleGetMessage] mark-success failed for", id, e);
                }
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

    const openPreviewHtml = async (id: string) => {
        try {
            const res = await fetch(`/api/email/getmessage?id=${encodeURIComponent(id)}&preview=1`);
            if (!res.ok) {
                setError(`Preview fetch failed: ${res.status}`);
                return;
            }
            const text = await res.text();
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
            if (!res.ok) {
                setError(`Preview fetch failed: ${res.status}`);
                return;
            }
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
            const blob = new Blob([lastRawResponse], { type: "text/html" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "raw-response.html";
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch (e) {
            showToast("Failed to download raw response", "error");
        }
    };

    const openLastResponse = () => {
        if (!lastRawResponse) return;
        const blob = new Blob([lastRawResponse], { type: "text/html" });
        const url = URL.createObjectURL(blob);
        window.open(url, "_blank");
    };

    return (
        <div className="flex h-dvh flex-col">
            <div className="flex gap-4 p-4">
                <div className="flex items-center gap-2">
                    <div className="text-sm">
                        Site: <strong className="ml-1">{FIXED_SITE}</strong>
                    </div>
                    <div className="text-sm">
                        Domain: <strong className="ml-1">{FIXED_DOMAIN}</strong>
                    </div>
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
                    <ButtonUtility onClick={() => fetchStoredOrders()} size="sm" color="secondary">
                        Refresh Orders
                    </ButtonUtility>
                </div>
            </div>

            {statusMsg && <div className="p-2 text-sm text-success">{statusMsg}</div>}
            {orderingProgress !== null && (
                <div className="p-2 text-sm">
                    Ordering {orderingProgress} / {Math.max(1, Math.min(50, Math.floor(Number(countInput || 1))))}
                </div>
            )}

            {/* Orders take full page now */}
            <div className="flex-1 overflow-auto rounded border p-4">
                <h3 className="text-sm font-semibold">Orders</h3>
                {orders.length === 0 && <div className="text-sm text-tertiary">No orders yet</div>}
                <ul className="mt-2 space-y-0">
                    {orders.map((o, idx) => (
                        <li key={o.id} className="flex items-start justify-between gap-2 py-3">
                            <div className="pr-4">
                                <div className="text-sm font-medium">{o.email ?? o.id}</div>
                                <div className="text-xs text-tertiary">
                                    {o.site ?? FIXED_SITE} · {o.status ?? "pending"}
                                    {o.updatedAt ? ` · ${new Date(o.updatedAt).toLocaleString()}` : ""}
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
                                    title="Cancel this activation/order"
                                    onClick={() => handleCancel(o.id)}
                                    className="rounded border px-2 py-1 text-xs text-danger"
                                >
                                    Cancel
                                </button>

                                <button
                                    title="Create a new order using this id as template"
                                    onClick={() => handleReorder(o.id)}
                                    className="rounded border px-2 py-1 text-xs"
                                >
                                    Reorder
                                </button>
                            </div>

                            {/* separator between items */}
                            {idx < orders.length - 1 && <div className="w-full border-t mt-3" />}
                        </li>
                    ))}
                </ul>
            </div>

            {/* toasts */}
            <div aria-live="polite" className="fixed right-4 bottom-4 z-50 flex flex-col-reverse gap-2">
                {toasts.map((t) => (
                    <div
                        key={t.id}
                        className={`max-w-xs w-full rounded p-2 shadow ${t.variant === "success" ? "bg-success-50 text-success" : t.variant === "error" ? "bg-error-50 text-error" : t.variant === "warning" ? "bg-warning-50 text-warning" : "bg-brand-50 text-brand-700"
                        }`}
                    >
                        <div className="flex items-center justify-between gap-2">
                            <div className="text-sm">{t.message}</div>
                            <button onClick={() => removeToast(t.id)} className="text-xs underline">
                                Close
                            </button>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};

export default EmailGenerator;
