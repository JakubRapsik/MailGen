// javascript
import { readStoredOrders, writeStoredOrders } from './_shared.js';

export default async function handler(req, res) {
    try {
        if (req.method === 'GET') {
            const list = await readStoredOrders();
            res.setHeader('Content-Type', 'application/json');
            res.status(200).send(list);
            return;
        }

        if (req.method === 'POST') {
            // Lightweight debug logging: record method, content-type and a safe preview of the body
            try {
                const contentType = req.headers && (req.headers['content-type'] || req.headers['Content-Type']);
                const bodyPreview = typeof req.body === 'string'
                    ? req.body
                    : (req.body && typeof req.body === 'object' ? JSON.stringify(req.body).slice(0, 100) : String(req.body));
                // log essential info
                console.warn('api/stored-orders: POST headers.content-type=', contentType, ' bodyType=', typeof req.body, ' preview=', bodyPreview);
                // also log full headers (stringified) for debugging (avoid logging huge bodies)
                try { console.warn('api/stored-orders: headers=', JSON.stringify(req.headers)); } catch (e) { /* ignore */ }
            } catch (e) {
                console.warn('api/stored-orders: failed to preview body for logging', e);
            }

            // Normalize body: if it's a string try to parse it as JSON,
            // otherwise use as-is.
            const rawBody = req.body;
            let body = rawBody;

            // Helpful special-case warning: if the raw body is literally the word "token",
            // that's a common symptom of a client accidentally sending the token string as the request body.
            if (typeof rawBody === 'string' && rawBody.trim() === 'token') {
                console.warn('api/stored-orders: received raw string "token" as body - check that your client/webhook is sending JSON (Content-Type: application/json) and using JSON.stringify() on the payload. Also verify Vercel env/webhook configuration.');
            }

            if (typeof rawBody === 'string') {
                try {
                    body = JSON.parse(rawBody);
                } catch (err) {
                    console.warn('api/stored-orders: received raw string body:', rawBody);
                    res.status(400).json({ status: 'error', value: rawBody, message: 'expected JSON body' });
                    return;
                }
            }

            // Replace whole list: POST { orders: [...] } or POST [...]
            const maybeOrders = Array.isArray(body)
                ? body
                : Array.isArray(body && body.orders)
                    ? body.orders
                    : null;

            if (maybeOrders) {
                await writeStoredOrders(maybeOrders);
                res.status(200).json({ status: 'ok', action: 'replace', length: maybeOrders.length });
                return;
            }

            // Append a single order: POST { order: {...} } or POST { id: '...', email: '...' }
            const maybeOrder = body && (body.order || (body.id ? body : null));
            if (maybeOrder && typeof maybeOrder === 'object') {
                const existing = await readStoredOrders();
                const exists = existing.find((it) => String(it.id) === String(maybeOrder.id));
                if (!exists) {
                    const toInsert = {
                        ...maybeOrder,
                        status: maybeOrder.status || 'pending',
                        createdAt: maybeOrder.createdAt || new Date().toISOString(),
                    };
                    existing.unshift(toInsert);
                    await writeStoredOrders(existing);
                }
                res.status(200).json({ status: 'ok', action: 'append' });
                return;
            }

            res.status(400).json({ status: 'error', message: 'invalid body: expected { order } or { orders }' });
            return;
        }

        res.setHeader('Allow', 'GET, POST');
        res.status(405).json({ status: 'error', message: 'Method not allowed' });
    } catch (err) {
        console.error('api/stored-orders error:', err);
        res.status(500).json({ status: 'error', message: String(err) });
    }
}
