import { forward, readStoredOrders, writeStoredOrders } from '../_shared.js';

export default async function handler(req, res) {
  try {
    const r = await forward('/email/reorder', req.query);
    try {
      if (r?.body && typeof r.body === 'object' && r.body.status === 'success' && r.body.id && r.body.email) {
        const existing = await readStoredOrders();
        const exists = existing.find((it) => String(it.id) === String(r.body.id));
        if (exists) {
          // If the order already exists (e.g., previously marked 'success'), mark it back to pending
          exists.status = 'pending';
          exists.email = r.body.email || exists.email;
          exists.site = req.query.site || exists.site;
          exists.updatedAt = new Date().toISOString();
          // move the updated item to the front so poller checks it sooner
          const filtered = existing.filter((it) => String(it.id) !== String(r.body.id));
          filtered.unshift(exists);
          await writeStoredOrders(filtered);
        } else {
          // mark reorders as pending initially (new entry)
          existing.unshift({ id: r.body.id, email: r.body.email, site: req.query.site || null, status: 'pending', createdAt: new Date().toISOString() });
          await writeStoredOrders(existing);
        }
      }
    } catch (e) {
      console.error('Failed to persist reorder result:', e);
    }
    res.status(r.status).send(r.body);
  } catch (e) {
    res.status(500).send({ status: 'error', message: String(e) });
  }
}
