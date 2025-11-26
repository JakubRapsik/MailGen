import { readStoredOrders } from './_shared.js';

export default async function handler(req, res) {
  try {
    const data = await readStoredOrders();
    // Prevent caching at CDN/browser level so clients always get fresh data (avoid 304 without body)
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    console.log('[api/stored-orders] returning', Array.isArray(data) ? data.length : 'non-array', 'items');
    res.setHeader('Content-Type', 'application/json');
    res.status(200).send(data);
  } catch (err) {
    console.error('api/stored-orders error:', err);
    res.status(500).json({ status: 'error', message: String(err) });
  }
}
