const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || process.env.KV_URL || process.env.REDIS_URL || null;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || process.env.KV_REST_API_READ_ONLY_TOKEN || null;

function upstashCommandsUrl() {
  if (!UPSTASH_URL) return null;
  if (UPSTASH_URL.includes('/commands')) return UPSTASH_URL.replace(/\/+$/, '');
  return UPSTASH_URL.replace(/\/+$/, '') + '/commands';
}

export default async function handler(req, res) {
  const commandsUrl = upstashCommandsUrl();
  const redacted = commandsUrl ? commandsUrl.replace(/([?&]token=)[^&]+/, '$1***REDACTED***') : null;
  res.status(200).json({ commandsUrl: redacted, tokenLoaded: !!UPSTASH_TOKEN });
}
