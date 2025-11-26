// javascript
import { forward, updateOrderStatus } from '../_shared.js';

// Helper to set a header on the response in a runtime-agnostic way
function setResHeader(res, name, value) {
    try {
        if (!res) return;
        if (typeof res.set === 'function') return res.set(name, value);
        if (typeof res.setHeader === 'function') return res.setHeader(name, value);
        if (res.headers && typeof res.headers.set === 'function') return res.headers.set(name, value);
        if (!res.headers) res.headers = {};
        res.headers[name] = value;
    } catch (e) {
        console.warn('[setResHeader] failed to set header', name, e?.message ?? e);
    }
}

export default async function handler(req, res) {
    try {
        const r = await forward('/email/getmessage', req.query);
        const isPreview = req.query.preview === '1' || req.url?.includes('preview=1');

        console.log('[api/email/getmessage] query=', { id: req.query.id, preview: req.query.preview }, 'isPreview=', isPreview);
        console.log('[api/email/getmessage] upstream status=', r?.status, 'headers=', r?.headers ? Object.keys(r.headers) : 'no-headers', 'bodyType=', getBodyType(r?.body));

        // Update DB using the requested id when a message is detected (non-preview)
        if (!isPreview) {
            const requestedId = req.query.id;
            try {
                if (requestedId) {
                    let detected = false;

                    // raw string body -> treat as message
                    if (typeof r?.body === 'string' && r.body.trim().length > 0) {
                        detected = true;
                    }

                    // buffer/stream -> treat as message
                    if (!detected && (Buffer.isBuffer?.(r?.body) || (r?.body && typeof r.body.pipe === 'function'))) {
                        detected = true;
                    }

                    // object body -> various heuristics
                    if (!detected && r?.body && typeof r.body === 'object') {
                        // direct success indicator
                        if (r.body.status === 'success') detected = true;
                        // upstream JSON with message field
                        if (!detected && (r.body.message || r.body.result || r.body.value)) detected = true;
                        // forward may return html_response marker
                        if (!detected && r.body.value === 'html_response') detected = true;
                    }

                    if (detected) {
                        await updateOrderStatus(requestedId, 'success');
                        console.log('[api/email/getmessage] updating order status ->', requestedId, 'to success (detected response)');
                    } else {
                        console.log('[api/email/getmessage] will not update order status; no message detected', r?.body);
                    }
                } else {
                    console.log('[api/email/getmessage] no id in request query; skipping status update');
                }
            } catch (e) {
                console.error('Failed to update order status after getmessage:', e);
            }
        }

        // Forward content-type if provided
        const upstreamContentType = r?.headers?.['content-type'] || r?.headers?.['Content-Type'];
        if (upstreamContentType) setResHeader(res, 'Content-Type', upstreamContentType);

        // Preview: return raw HTML/stream/buffer
        if (isPreview) {
            if (r?.body && typeof r?.body.pipe === 'function') {
                res.status(r.status);
                r.body.pipe(res);
                return;
            }
            if (Buffer.isBuffer(r?.body) || typeof r?.body === 'string') {
                if (!upstreamContentType && typeof r.body === 'string') setResHeader(res, 'Content-Type', 'text/html; charset=utf-8');
                return res.status(r.status).send(r.body);
            }
            return res.status(r.status).json(r.body);
        }

        // Non-preview: forward whatever body the upstream returned
        if (r?.body && typeof r?.body.pipe === 'function') {
            res.status(r.status);
            r.body.pipe(res);
        } else if (typeof r?.body === 'string' || Buffer.isBuffer(r?.body)) {
            if (!upstreamContentType && typeof r.body === 'string') setResHeader(res, 'Content-Type', 'text/plain; charset=utf-8');
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
