import { forward, readStoredOrders, writeStoredOrders } from '../_shared.js';

export default async function handler(req, res) {
  try {
    const r = await forward('/email/cancel', req.query);
    try {
      if (r?.body && typeof r.body === 'object' && r.body.status === 'success') {
        const existing = await readStoredOrders();
        const idx = existing.findIndex((it) => String(it.id) === String(req.query.id));
        if (idx !== -1) {
          existing[idx].status = 'canceled';
          existing[idx].updatedAt = new Date().toISOString();
          await writeStoredOrders(existing);
        }
      }
    } catch (e) {
      console.error('Failed to update stored orders after cancel:', e);
    }
    res.status(r.status).send(r.body);
  } catch (e) {
    res.status(500).send({ status: 'error', message: String(e) });
  }
}

