import { put } from '@vercel/blob';

export default async function handler(req, res) {
  try {
    // For Pages API routes, you should pass `req` directly; for this project structure, request body should be readable
    const filename = (req.query && req.query.filename) || req.url && new URL(req.url, 'http://localhost').searchParams.get('filename');
    if (!filename) return res.status(400).json({ status: 'error', message: 'filename query param required' });

    // req.body should be the raw file stream
    const blob = await put(filename, req, { access: 'public' });
    res.status(200).json(blob);
  } catch (e) {
    console.error('blob upload error:', e);
    res.status(500).json({ status: 'error', message: String(e) });
  }
}

