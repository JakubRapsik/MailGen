import { TOKEN } from './_shared.js';

export default async function handler(req, res) {
  res.status(200).send({ loaded: !!TOKEN });
}

