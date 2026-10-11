/**
 * Cloudflare Pages Functions — WebSocket Reverse Proxy
 * Automatically proxies /ws WebSocket upgrade requests to your PXXL Go backend.
 * Configure BACKEND_URL in Cloudflare Pages > Settings > Environment Variables
 * (e.g., BACKEND_URL = https://spatialwatch.pxxl.app)
 */
export async function onRequest(context) {
  const { request, env } = context;
  const backendBase = (env.BACKEND_URL || '').trim().replace(/\/+$/, '');

  if (!backendBase) {
    return new Response(
      JSON.stringify({
        error: 'BACKEND_URL environment variable is not configured in Cloudflare Pages dashboard.',
      }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const url = new URL(request.url);
  const targetWsBase = backendBase.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://');
  const targetUrl = `${targetWsBase}${url.pathname}${url.search}`;

  const forwardHeaders = new Headers(request.headers);
  forwardHeaders.set('CF-Connecting-IP', request.headers.get('CF-Connecting-IP') || '');
  forwardHeaders.set('X-Forwarded-Host', url.host);

  return await fetch(targetUrl, {
    headers: forwardHeaders,
  });
}
