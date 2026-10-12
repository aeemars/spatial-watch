/**
 * Cloudflare Pages Functions — WebSocket Reverse Proxy
 * Automatically proxies /ws WebSocket upgrade requests to your PXXL Go backend.
 * Uses Cloudflare Environment Variable: BACKEND_URL
 * Defaults to: https://spatial-watch.pxxlspace.cv
 */
export async function onRequest(context) {
  const { request, env } = context;
  const backendBase = (env && env.BACKEND_URL ? env.BACKEND_URL : 'https://spatial-watch.pxxlspace.cv').trim().replace(/\/+$/, '');

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
