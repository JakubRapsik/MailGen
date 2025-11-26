import { forward, updateOrderStatus } from '../_shared.js';

export default async function handler(req, res) {
  try {
    const r = await forward('/email/getmessage', req.query);
    const isPreview = req.query.preview === '1' || req.url?.includes('preview=1');

    const messageId = req.query.id;
    console.log('[api/email/getmessage] query=', { id: messageId, preview: req.query.preview }, 'isPreview=', isPreview);
    console.log('[api/email/getmessage] upstream response status=', r?.status, 'bodyType=', typeof r?.body);

    try {
      if (!isPreview) {
        // Only update stored order status when upstream explicitly returned a success object with an id.
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
