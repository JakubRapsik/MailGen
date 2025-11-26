import { forward, updateOrderStatus } from '../_shared.js';

export default async function handler(req, res) {
  try {
    const r = await forward('/email/getmessage', req.query);
    const isPreview = req.query.preview === '1' || req.url?.includes('preview=1');
    try {
      const messageId = req.query.id;
      if (!isPreview) {
        if (r && r.body && typeof r.body === 'object' && r.body.status === 'success') {
          await updateOrderStatus(messageId, 'success');
        }
        if (r && typeof r.body === 'string') {
          await updateOrderStatus(messageId, 'success');
        }
      }
    } catch (e) {
      console.error('Failed to update order status after getmessage:', e);
    }

    if (isPreview) {
      if (typeof r.body === 'string') res.set('Content-Type', 'text/html');
      res.status(r.status).send(r.body);
    } else {
      res.status(r.status).send(r.body);
    }
  } catch (e) {
    res.status(500).send({ status: 'error', message: String(e) });
  }
}

