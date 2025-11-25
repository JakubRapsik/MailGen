Proxy README

This project includes a small dev proxy server that forwards requests to https://api.anymessage.shop and automatically attaches your token from an environment variable. This is useful to keep your token hidden from client-side code and avoid CORS issues.

Setup

1. Copy `.env.example` to `.env` and set `ANYMESSAGE_TOKEN`:

   cp .env.example .env
   # edit .env and set ANYMESSAGE_TOKEN

2. Install dependencies:

   npm install

3. Run only the proxy server:

   npm run proxy

4. Run the Vite dev server in another terminal:

   npm run dev

Or run both together (requires concurrently):

   npm run dev:with-proxy

How it works

- The proxy lives at `server/index.js` and exposes endpoints under `/api/*`.
- Frontend calls `/api/email/order`, `/api/user/balance`, etc.
- The proxy attaches `token=process.env.ANYMESSAGE_TOKEN` if the client does not include it.
- The proxy forwards responses (including raw HTML for preview=1).

Security

- Keep your `.env` out of version control. `.env.example` is provided as a template.
- This proxy is intended for development only.

