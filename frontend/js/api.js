/* ═══════════════════════════════════════════════════════════
   SPATIAL WATCH — API Client
   HTTP communication with credentialed session support
   ═══════════════════════════════════════════════════════════ */

const API = (() => {
  const BASE = window.location.origin;
  let sessionPromise = null;

  async function request(method, path, body, isRetry = false) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include', // Ensure sw_session cookie is sent on all requests
    };
    if (body !== undefined) opts.body = JSON.stringify(body);

    const res = await fetch(`${BASE}${path}`, opts);

    if (res.status === 204) {
      return null;
    }

    // Auto-recovery on 401: if unauthorized on a non-auth endpoint, refresh session and retry once
    if (res.status === 401 && !isRetry && !path.startsWith('/api/auth/')) {
      try {
        await getSession();
        return await request(method, path, body, true);
      } catch (authErr) {
        console.warn('[api] session auto-recovery failed:', authErr);
      }
    }

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new Error(data.error || `Request failed: ${res.status}`);
    }
    return data;
  }

  function getSession() {
    if (!sessionPromise) {
      sessionPromise = request('GET', '/api/auth/session').finally(() => {
        sessionPromise = null;
      });
    }
    return sessionPromise;
  }

  return {
    /** Get or create authenticated guest session (deduplicated) */
    getSession,

    /** Update guest profile display name */
    updateProfile(displayName) {
      return request('PATCH', '/api/auth/profile', { displayName });
    },

    /** Invalidate session and clear session cookie */
    logout() {
      return request('POST', '/api/auth/logout');
    },

    /** Get curated demo films catalog */
    getMediaAssets() {
      return request('GET', '/api/media-assets');
    },

    /** Create a new room (host bound to authenticated session) */
    createRoom(roomName, displayName, options = {}) {
      const payload = { roomName, displayName };
      if (typeof options === 'string') {
        // Backwards compatibility if old callers pass mediaUrl as 3rd arg
        payload.mediaUrl = options;
      } else if (options && typeof options === 'object') {
        if (options.mediaAssetId) payload.mediaAssetId = options.mediaAssetId;
        if (options.mediaUrl) payload.mediaUrl = options.mediaUrl;
        if (options.mediaTitle) payload.mediaTitle = options.mediaTitle;
      }
      return request('POST', '/api/rooms', payload);
    },

    /** Join an existing room (participant bound to authenticated session) */
    joinRoom(roomCode, displayName) {
      return request('POST', '/api/rooms/join', { roomCode, displayName });
    },

    /** Get user room records (created and joined rooms for continued access) */
    getUserRooms() {
      return request('GET', '/api/user/rooms');
    },

    /** Host shuts down / deletes a room */
    shutdownRoom(roomCode) {
      return request('DELETE', `/api/rooms/${encodeURIComponent(roomCode)}`);
    },

    /** Guest leaves a joined room session, removing it from joined records */
    leaveRoomSession(roomCode) {
      return request('POST', `/api/rooms/${encodeURIComponent(roomCode)}/leave`);
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
