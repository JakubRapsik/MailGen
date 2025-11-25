import { readStoredOrders } from './_shared.js';

export default async function handler(req, res) {
  try {
    const list = await readStoredOrders();
    res.setHeader('Content-Type', 'application/json');
    res.status(200).send(list);
  } catch (err) {
    console.error('api/stored-orders error:', err);
    res.status(500).json({ status: 'error', message: String(err) });
  }
}
