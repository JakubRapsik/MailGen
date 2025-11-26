// javascript
// File: `untitled-ui/api/orders/mark-success.js`
import { updateOrderStatus } from '../_shared.js';

export default async function handler(req, res) {
    try {
        // accept either query param or JSON body
        const id = (req.query && req.query.id) || (req.body && req.body.id);
        if (!id) {
            return res.status(400).json({ status: 'error', message: 'missing id' });
        }

        await updateOrderStatus(id, 'success');
        return res.status(200).json({ status: 'success', id });
    } catch (e) {
        console.error('[api/orders/mark-success] error:', e);
        return res.status(500).json({ status: 'error', message: String(e) });
    }
}

// javascript
// File: `untitled-ui/src/pages/email-generator.tsx`
// --- only the modified snippets are shown; integrate into your existing file ---

// inside the scanOnce loop where you detect message arrival:
if (isRawString || isObjectMsg) {
    if (isRawString) setLastRawResponse(res);
    if (selectedMessageId === o.id) setMessageStatus('received');

    // Signal server to mark this order as success immediately
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

// inside handleGetMessage after you determine message was received (both raw string and res?.status === 'success')
if (typeof res === "string" || res?.status === "success") {
    // existing UI updates
    if (typeof res === "string") {
        setLastRawResponse(res);
        showToast('Message returned as raw HTML — open or download to view', 'info');
    }
    setMessageStatus("received");

    // ensure server marks status as success
    try {
        await fetch(`/api/orders/mark-success?id=${encodeURIComponent(id)}`, { method: 'POST' });
    } catch (e) {
        console.warn('[handleGetMessage] mark-success failed for', id, e);
    }

    // refresh stored orders to update list
    await fetchStoredOrders();
}
