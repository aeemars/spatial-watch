/**
 * Cloudflare Pages Functions — API Reverse Proxy
 * Automatically proxies /api/* requests from Cloudflare Pages edge to your PXXL Go backend.
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
        hint: 'Set BACKEND_URL=https://<your-service>.pxxl.app in Pages Settings > Environment Variables, or set window.ENV_API_URL in frontend/js/config.js for direct access.',
      }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const url = new URL(request.url);
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

  return await fetch(targetUrl, fetchOptions);
}
