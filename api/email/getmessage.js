// javascript
import { forward, updateOrderStatus } from '../_shared.js';

export default async function handler(req, res) {
    try {
        const r = await forward('/email/getmessage', req.query);
        const isPreview = req.query.preview === '1' || req.url?.includes('preview=1');

        console.log('[api/email/getmessage] query=', { id: req.query.id, preview: req.query.preview }, 'isPreview=', isPreview);
        console.log('[api/email/getmessage] upstream status=', r?.status, 'headers=', r?.headers ? Object.keys(r.headers) : 'no-headers', 'bodyType=', getBodyType(r?.body));

        try {
            if (!isPreview) {
                if (r && r.body && typeof r.body === 'object' && r.body.status === 'success' && r.body.id) {
                    const updateId = r.body.id;
                    console.log('[api/email/getmessage] updating order status ->', updateId, 'to success');
                    await updateOrderStatus(updateId, 'success');
                } else {
                    console.log('[api/email/getmessage] will not update order status; upstream did not return success+id', r && r.body);
                }
            }
        } catch (e) {
            console.error('Failed to update order status after getmessage:', e);
        }

        // If upstream provided content-type header, forward it
        const upstreamContentType = r?.headers?.['content-type'] || r?.headers?.['Content-Type'];
        if (upstreamContentType) res.set('Content-Type', upstreamContentType);

        // For preview mode we want to return raw HTML/stream/buffer
        if (isPreview) {
            // If body is a stream, pipe it directly
            if (r?.body && typeof r.body.pipe === 'function') {
                res.status(r.status);
                r.body.pipe(res);
                return;
            }

            // If body is Buffer or string, ensure appropriate content-type and send
            if (Buffer.isBuffer(r?.body) || typeof r?.body === 'string') {
                if (!upstreamContentType && typeof r.body === 'string') res.set('Content-Type', 'text/html; charset=utf-8');
                return res.status(r.status).send(r.body);
            }

            // JSON fallback for preview if upstream returned object
            return res.status(r.status).json(r.body);
        }

        // Non-preview: forward whatever body the upstream returned (JSON or text)
        if (r?.body && typeof r.body.pipe === 'function') {
            res.status(r.status);
            r.body.pipe(res);
        } else if (typeof r?.body === 'string' || Buffer.isBuffer(r?.body)) {
            if (!upstreamContentType && typeof r.body === 'string') res.set('Content-Type', 'text/plain; charset=utf-8');
            res.status(r.status).send(r.body);
        } else {
            res.status(r.status).send(r.body);
        }
    } catch (e) {
        console.error('[api/email/getmessage] handler error:', e);
        res.status(500).send({ status: 'error', message: String(e) });
    }
}

function getBodyType(body) {
    if (!body) return 'null';
    if (typeof body === 'string') return 'string';
    if (Buffer.isBuffer(body)) return 'buffer';
    if (typeof body.pipe === 'function') return 'stream';
    if (typeof body === 'object') return 'object';
    return typeof body;
}
