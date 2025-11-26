// javascript
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
