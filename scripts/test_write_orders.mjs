import { readStoredOrders, writeStoredOrders } from '../api/_shared.js';
import fs from 'fs/promises';
import path from 'path';

async function run() {
  console.log('Starting test write...');
  try {
    const existing = await readStoredOrders();
    console.log('Read existing count:', (existing && existing.length) || 0);
    const testOrder = { id: `test-${Date.now()}`, email: `test+${Date.now()}@example.com`, site: 'unit-test', status: 'pending', createdAt: new Date().toISOString() };
    existing.unshift(testOrder);
    const ok = await writeStoredOrders(existing);
    console.log('writeStoredOrders returned:', ok);
    const filePath = path.join(process.cwd(), 'server_data', 'orders.json');
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      console.log('File content after write (first 400 chars):\n', raw.slice(0,400));
    } catch (e) {
      console.warn('Could not read ORDERS_PATH after write:', e.message);
    }
  } catch (e) {
    console.error('Test failed:', e);
  }
}

run().catch((e)=>{console.error(e);process.exit(1) });

