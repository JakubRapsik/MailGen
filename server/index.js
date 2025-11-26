import express from "express";
import dotenv from "dotenv";
import fetch from "node-fetch";

// Use shared storage helpers which prefer Vercel KV / Upstash SDK and fall back to filesystem
import { readStoredOrders, writeStoredOrders, updateOrderStatus } from '../api/_shared.js';

dotenv.config();

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.ANYMESSAGE_TOKEN;

if (TOKEN) {
    console.log("ANYMESSAGE_TOKEN loaded from environment (hidden)");
} else {
    console.warn("Warning: ANYMESSAGE_TOKEN is not set in environment. Proxy will forward requests without token.");
}

const API_BASE = "https://api.anymessage.shop";

const app = express();
app.use(express.json());

// Helper: forward request to AnyMessage API, attaching token from env if present
async function forward(path, query = {}) {
    const params = new URLSearchParams();
    // copy query object entries
    Object.entries(query).forEach(([k, v]) => {
        if (v !== undefined && v !== null) params.set(k, String(v));
    });
    // attach token from env if not provided by client
    if (!params.has("token") && TOKEN) {
        params.set("token", TOKEN);
    }

    const url = `${API_BASE}${path}?${params.toString()}`;
    const res = await fetch(url);
    const text = await res.text();
    // If upstream returned raw HTML (text starts with '<' or contains '<html') and this is NOT a preview getmessage call,
    // we should NOT forward the raw HTML to the frontend. Instead return a short JSON indicating an HTML response was returned.
    const looksLikeHtml = typeof text === 'string' && /<\/?html|<!doctype/i.test(text);
    const isGetMessagePreview = path === '/email/getmessage' && (params.get('preview') === '1');
    if (looksLikeHtml && !isGetMessagePreview) {
        return { status: res.status, body: { status: 'error', value: 'html_response', length: text.length } };
    }
    try {
        return { status: res.status, body: JSON.parse(text) };
    } catch (e) {
        return { status: res.status, body: text };
    }
}

// Endpoints
app.get("/api/user/balance", async (req, res) => {
    try {
        const r = await forward("/user/balance", req.query);
        res.status(r.status).send(r.body);
    } catch (e) {
        res.status(500).send({ status: "error", message: String(e) });
    }
});

app.get("/api/email/quantity", async (req, res) => {
    try {
        const r = await forward("/email/quantity", req.query);
        res.status(r.status).send(r.body);
    } catch (e) {
        res.status(500).send({ status: "error", message: String(e) });
    }
});

app.get("/api/email/order", async (req, res) => {
    try {
        const r = await forward("/email/order", req.query);
        // persist successful orders (if response contains { status: 'success', id, email })
        try {
            if (r?.body && typeof r.body === "object" && r.body.status === "success" && r.body.id && r.body.email) {
                const existing = await readStoredOrders();
                // avoid duplicates by id
                const exists = existing.find((it) => String(it.id) === String(r.body.id));
                if (!exists) {
                    // mark new order as pending; message arrival will flip to 'success'
                    existing.unshift({ id: r.body.id, email: r.body.email, site: req.query.site || null, status: 'pending', createdAt: new Date().toISOString() });
                    await writeStoredOrders(existing);
                }
            }
        } catch (e) {
            console.error("Failed to persist order result:", e);
        }
        res.status(r.status).send(r.body);
    } catch (e) {
        res.status(500).send({ status: "error", message: String(e) });
    }
});

app.get("/api/email/getmessage", async (req, res) => {
    try {
        const r = await forward("/email/getmessage", req.query);
        // If preview=1, AnyMessage returns raw HTML; we want to forward it as-is.
        const isPreview = req.query.preview === "1";
        // If this is not a preview and the response indicates a received message, mark order as success
        try {
            const messageId = req.query.id;
            if (!isPreview) {
                // r.body could be an object with { status: 'success', ... } when a message arrived
                if (r && r.body && typeof r.body === 'object' && r.body.status === 'success') {
                    await updateOrderStatus(messageId, 'success');
                }
                // also, if upstream returned a raw string (rare since forward masks HTML), treat it as message received
                if (r && typeof r.body === 'string') {
                    await updateOrderStatus(messageId, 'success');
                }
            }
        } catch (e) {
            console.error('Failed to update order status after getmessage:', e);
        }

        if (isPreview) {
            // r.body may be a string
            if (typeof r.body === "string") res.set("Content-Type", "text/html");
            res.status(r.status).send(r.body);
        } else {
            res.status(r.status).send(r.body);
        }
    } catch (e) {
        res.status(500).send({ status: "error", message: String(e) });
    }
});

app.get("/api/email/reorder", async (req, res) => {
    try {
        const r = await forward("/email/reorder", req.query);
        // persist reorder response if success
        try {
            if (r?.body && typeof r.body === "object" && r.body.status === "success" && r.body.id && r.body.email) {
                const existing = await readStoredOrders();
                const exists = existing.find((it) => String(it.id) === String(r.body.id));
                if (!exists) {
                    // mark reorders as pending initially
                    existing.unshift({ id: r.body.id, email: r.body.email, site: req.query.site || null, status: 'pending', createdAt: new Date().toISOString() });
                    await writeStoredOrders(existing);
                }
            }
        } catch (e) {
            console.error("Failed to persist reorder result:", e);
        }
        res.status(r.status).send(r.body);
    } catch (e) {
        res.status(500).send({ status: "error", message: String(e) });
    }
});

app.get("/api/email/cancel", async (req, res) => {
    try {
        const r = await forward("/email/cancel", req.query);
        // if cancel success, remove from stored orders
        try {
            if (r?.body && typeof r.body === "object" && r.body.status === "success") {
                const existing = await readStoredOrders();
                const idx = existing.findIndex((it) => String(it.id) === String(req.query.id));
                if (idx !== -1) {
                    // mark as canceled rather than removing to keep history
                    existing[idx].status = 'canceled';
                    existing[idx].updatedAt = new Date().toISOString();
                    await writeStoredOrders(existing);
                }
             }
         } catch (e) {
             console.error("Failed to update stored orders after cancel:", e);
         }
         res.status(r.status).send(r.body);
    } catch (e) {
        res.status(500).send({ status: "error", message: String(e) });
    }
});

// Expose stored orders for frontend to display
app.get("/api/stored-orders", async (req, res) => {
    try {
        const list = await readStoredOrders();
        res.send(list);
    } catch (e) {
        res.status(500).send({ status: "error", message: String(e) });
    }
});

// Safe debug endpoint: returns whether the token was loaded (true/false). Does NOT expose the token itself.
app.get("/api/_token_status", (req, res) => {
    res.send({ loaded: !!TOKEN });
});

// Debug: manually set order status (safe for local dev only)
app.get("/api/_mark_order_status", async (req, res) => {
    const { id, status } = req.query;
    if (!id || !status) return res.status(400).send({ status: 'error', message: 'id and status required' });
    try {
        await updateOrderStatus(id, status);
        res.send({ status: 'success' });
    } catch (e) {
        res.status(500).send({ status: 'error', message: String(e) });
    }
});

// Background poller: periodically check pending orders and update status when a message arrives
let polling = false;
async function pollPendingOrdersOnce() {
    if (polling) return;
    polling = true;
    try {
        // read stored orders (may come from Vercel KV, Upstash, or filesystem)
        const list = await readStoredOrders();
        if (!Array.isArray(list) || list.length === 0) return;
        const pending = list.filter((it) => it.status === 'pending');
        if (!pending.length) return;
        console.log(`Polling ${pending.length} pending orders for messages...`);

        // Check sequentially to avoid hammering upstream
        for (const order of pending) {
            try {
                // call getmessage for this id (no preview)
                const r = await forward('/email/getmessage', { id: order.id });
                if (r && r.body) {
                    // if the API indicates success or returned raw HTML/string, mark as success
                    if (typeof r.body === 'string') {
                        await updateOrderStatus(order.id, 'success');
                        console.log(`Order ${order.id} marked success (raw string response).`);
                    } else if (typeof r.body === 'object' && r.body.status === 'success') {
                        await updateOrderStatus(order.id, 'success');
                        console.log(`Order ${order.id} marked success (API success).`);
                    }
                }
            } catch (e) {
                console.warn(`Polling failed for order ${order.id}:`, e?.message ?? e);
                // continue with next
            }
        }
    } catch (e) {
        console.error('Error while polling pending orders:', e);
    } finally {
        polling = false;
    }
}

function startPollingPendingOrders() {
    const interval = parseInt(process.env.POLL_INTERVAL_MS || '5000', 10);
    // Run immediately and then at interval
    pollPendingOrdersOnce().catch((e) => console.error(e));
    setInterval(() => pollPendingOrdersOnce().catch((e) => console.error(e)), interval);
    console.log(`Started pending-orders poller (interval=${interval}ms)`);
}

app.listen(PORT, () => {
    console.log(`AnyMessage proxy listening on http://localhost:${PORT}`);
    // start background poller in development / local environments
    if (process.env.NODE_ENV !== 'test') {
        startPollingPendingOrders();
    }
 });
