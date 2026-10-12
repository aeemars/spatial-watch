/* ═══════════════════════════════════════════════════════════
   SPATIAL WATCH — Client Runtime Environment Configuration
   ═══════════════════════════════════════════════════════════
   When hosting Frontend on Cloudflare Pages and Backend on PXXL:

   • OPTION A (Pages Functions Proxy - Zero CORS, Same-Origin):
     Leave ENV_API_URL and ENV_WS_URL empty ('').
     Cloudflare Pages Functions in frontend/functions/ will
     seamlessly proxy /api and /ws requests to your PXXL backend.

   • OPTION B (Direct Cross-Origin to PXXL):
     Set ENV_API_URL to your PXXL service URL:
       window.ENV_API_URL = 'https://<your-service>.pxxl.app';
     The WebSocket URL will automatically be derived (wss://<your-service>.pxxl.app),
     or you can specify it explicitly:
       window.ENV_WS_URL = 'wss://<your-service>.pxxl.app';

   • OPTION C (Custom Subdomain on Cloudflare DNS):
     e.g., Frontend on https://spatialwatch.com and Backend on https://api.spatialwatch.com
       window.ENV_API_URL = 'https://api.spatialwatch.com';
   ═══════════════════════════════════════════════════════════ */

window.ENV_API_URL = 'https://spatial-watch.pxxlspace.cv';
window.ENV_WS_URL = 'wss://spatial-watch.pxxlspace.cv';
