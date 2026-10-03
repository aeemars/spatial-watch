/* ═══════════════════════════════════════════════════════════
   SPATIAL WATCH — API Client
   HTTP communication with the Go backend
   ═══════════════════════════════════════════════════════════ */

const API = (() => {
  const BASE = window.location.origin;

  async function request(method, path, body) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(`${BASE}${path}`, opts);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || `Request failed: ${res.status}`);
    }
    return data;
  }

  return {
    /** Create a new room */
    createRoom(displayName, mediaUrl) {
      return request('POST', '/api/rooms', { displayName, mediaUrl });
    },

    /** Join an existing room */
    joinRoom(roomCode, displayName) {
      return request('POST', '/api/rooms/join', { roomCode, displayName });
    },

    /** Get room info */
    getRoom(roomCode) {
      return request('GET', `/api/rooms/${encodeURIComponent(roomCode)}`);
    },

    /** Get commentary cues */
    getCommentary(roomCode) {
      return request('GET', `/api/rooms/${encodeURIComponent(roomCode)}/commentary`);
    },

    /** Health check */
    health() {
      return request('GET', '/health');
    },
  };
})();
