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
      // Expect JSON body. Accept either { order: {...} } to append a single order
      // or { orders: [...] } (or an array directly) to replace the whole list.
      const body = req.body;

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
