/**
 * Cloudflare Pages Functions — API Reverse Proxy
 * Automatically proxies /api/* requests from Cloudflare Pages edge to your PXXL Go backend.
 * Uses Cloudflare Environment Variable: BACKEND_URL
 * Defaults to: https://spatial-watch.pxxlspace.cv
 */
export async function onRequest(context) {
  const { request, env } = context;
  const backendBase = (env && env.BACKEND_URL ? env.BACKEND_URL : 'https://spatial-watch.pxxlspace.cv').trim().replace(/\/+$/, '');

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
