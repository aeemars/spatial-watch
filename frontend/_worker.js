/**
 * Cloudflare Pages & Workers — Edge Reverse Proxy & Static Asset Handler
 * Routes /api/* and /ws to PXXL Go backend, and serves static assets for all other paths.
 * Configured via Cloudflare Environment Variable: BACKEND_URL
 * Defaults to: https://spatial-watch.pxxlspace.cv
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const backendBase = (env && env.BACKEND_URL ? env.BACKEND_URL : 'https://spatial-watch.pxxlspace.cv').trim().replace(/\/+$/, '');

    // 1. Reverse-proxy API calls to PXXL backend
    if (url.pathname.startsWith('/api/')) {
      const targetUrl = `${backendBase}${url.pathname}${url.search}`;
      const forwardHeaders = new Headers(request.headers);
      forwardHeaders.set('CF-Connecting-IP', request.headers.get('CF-Connecting-IP') || '');
      forwardHeaders.set('X-Forwarded-Host', url.host);
      forwardHeaders.set('X-Forwarded-Proto', url.protocol.replace(':', ''));

      const fetchOptions = {
        method: request.method,
        headers: forwardHeaders,
        body: (request.method !== 'GET' && request.method !== 'HEAD') ? request.body : undefined,
        redirect: 'manual',
      };

      try {
        return await fetch(targetUrl, fetchOptions);
      } catch (err) {
        return new Response(JSON.stringify({ error: 'Backend gateway error', details: err.message }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // 2. Reverse-proxy WebSocket connections to PXXL backend
    if (url.pathname === '/ws' || url.pathname.startsWith('/ws?') || url.pathname.startsWith('/ws/')) {
      const targetWsBase = backendBase.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://');
      const targetUrl = `${targetWsBase}${url.pathname}${url.search}`;

      const forwardHeaders = new Headers(request.headers);
      forwardHeaders.set('CF-Connecting-IP', request.headers.get('CF-Connecting-IP') || '');
      forwardHeaders.set('X-Forwarded-Host', url.host);

      try {
        return await fetch(targetUrl, {
          headers: forwardHeaders,
        });
      } catch (err) {
        return new Response('WebSocket gateway error', { status: 502 });
      }
    }

    // 3. Serve static assets
    if (env && env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
};
