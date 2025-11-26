import { forward } from '../_shared.js';

export default async function handler(req, res) {
  try {
    const r = await forward('/user/balance', req.query);
    res.status(r.status).send(r.body);
  } catch (e) {
    res.status(500).send({ status: 'error', message: String(e) });
  }
}

