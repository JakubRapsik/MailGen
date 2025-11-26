import { getUpstashClient } from '../api/_shared.js';

(async function main() {
  try {
    const client = getUpstashClient();
    console.log('[test-upstash] client available:', !!client);
    if (!client) {
      console.error('[test-upstash] No Upstash SDK client available (missing env or SDK).');
      process.exit(2);
    }

    try {
      const val = await client.get('orders');
      console.log('[test-upstash] GET orders ->', val);
    } catch (e) {
      console.error('[test-upstash] GET orders failed:', e);
    }

    // Try a safe write if token permits
    try {
      const setRes = await client.set('test-sdk-key', JSON.stringify({ now: Date.now() }));
      console.log('[test-upstash] SET test-sdk-key ->', setRes);
      const getRes = await client.get('test-sdk-key');
      console.log('[test-upstash] GET test-sdk-key ->', getRes);
    } catch (e) {
      console.warn('[test-upstash] SET/GET test-sdk-key failed (token may be read-only):', e?.message ?? e);
    }

    process.exit(0);
  } catch (e) {
    console.error('[test-upstash] unexpected error:', e);
    process.exit(1);
  }
})();

