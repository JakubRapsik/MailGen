const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

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

