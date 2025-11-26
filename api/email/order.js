import { forward, readStoredOrders, writeStoredOrders } from '../_shared.js';

export default async function handler(req, res) {
  try {
    const r = await forward('/email/order', req.query);
    try {
      if (r?.body && typeof r.body === 'object' && r.body.status === 'success' && r.body.id && r.body.email) {
        console.log('[order] persisted order result received id=', r.body.id, 'email=', r.body.email);
        const existing = await readStoredOrders();
        const exists = existing.find((it) => String(it.id) === String(r.body.id));
        if (!exists) {
          existing.unshift({ id: r.body.id, email: r.body.email, site: req.query.site || null, status: 'pending', createdAt: new Date().toISOString() });
          await writeStoredOrders(existing);
        }
      }
    } catch (e) {
      console.error('Failed to persist order result:', e);
    }
    res.status(r.status).send(r.body);
  } catch (e) {
    res.status(500).send({ status: 'error', message: String(e) });
  }
}
