import { updateOrderStatus } from './_shared.js';

export default async function handler(req, res) {
  const { id, status } = req.query;
  if (!id || !status) return res.status(400).send({ status: 'error', message: 'id and status required' });
  try {
    await updateOrderStatus(id, status);
    res.send({ status: 'success' });
  } catch (e) {
    res.status(500).send({ status: 'error', message: String(e) });
  }
}

