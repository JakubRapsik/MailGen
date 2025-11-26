
import fs from 'fs/promises';
import path from 'path';

export default async function handler(req, res) {
  try {
    const filePath = path.join(process.cwd(), 'server_data', 'orders.json');
    const raw = await fs.readFile(filePath, 'utf-8');
    // In case there are accidental // comments in the JSON file, remove them before parsing
    const cleaned = raw.replace(/^\s*\/\/.*$/gm, '').trim();
    const data = cleaned ? JSON.parse(cleaned) : [];
    res.setHeader('Content-Type', 'application/json');
    res.status(200).send(data);
  } catch (err) {
    console.error('api/stored-orders error:', err);
    res.status(500).json({ status: 'error', message: String(err) });
  }
}