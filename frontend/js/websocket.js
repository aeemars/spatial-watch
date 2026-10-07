/* ═══════════════════════════════════════════════════════════
   SPATIAL WATCH — WebSocket Client
   Real-time communication with reconnect support
   ═══════════════════════════════════════════════════════════ */

const WS = (() => {
  let socket = null;
  let roomCode = '';
  let participantId = '';
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let intentionalClose = false;
  const MAX_RECONNECT = 10;
  const listeners = {};

  function getWSUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws?roomCode=${encodeURIComponent(roomCode)}`;
  }

  function connect() {
    if (!roomCode) {
      console.warn('[ws] connect aborted: missing roomCode');
      return;
    }

    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    intentionalClose = false;
    emit('status', { state: 'connecting' });

    socket = new WebSocket(getWSUrl());

    socket.onopen = () => {
      reconnectAttempts = 0;
      emit('status', { state: 'connected' });

      // Request full room state sync
      send({ type: 'request_sync' });

      // Start ping interval
      startPing();
    };

    socket.onmessage = (event) => {
      // Handle batched messages (newline-separated)
      const messages = event.data.split('\n');
      for (const msg of messages) {
        if (!msg.trim()) continue;
        try {
          const data = JSON.parse(msg);
          emit(data.type, data);
        } catch (e) {
          console.warn('[ws] failed to parse:', msg);
        }
      }
    };

    socket.onclose = (event) => {
      stopPing();
      if (intentionalClose) {
        emit('status', { state: 'disconnected' });
        return;
      }

      emit('status', { state: 'reconnecting', attempt: reconnectAttempts + 1 });
      scheduleReconnect();
    };

    socket.onerror = (err) => {
      console.error('[ws] error:', err);
    };
  }

  function scheduleReconnect() {
    if (reconnectAttempts >= MAX_RECONNECT) {
      emit('status', { state: 'failed' });
      return;
    }

    // Exponential backoff: 1s, 2s, 4s, 8s... max 30s
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
    reconnectAttempts++;

    reconnectTimer = setTimeout(() => {
      connect();
    }, delay);
  }

  let pingInterval = null;

  function startPing() {
    stopPing();
    pingInterval = setInterval(() => {
      send({ type: 'ping' });
    }, 30000);
  }

  function stopPing() {
    if (pingInterval) {
      clearInterval(pingInterval);
      pingInterval = null;
    }
  }

  function send(data) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(data));
    }
  }

  function on(event, callback) {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(callback);
  }

  function off(event, callback) {
    if (!listeners[event]) return;
    listeners[event] = listeners[event].filter(cb => cb !== callback);
  }

  function emit(event, data) {
    if (!listeners[event]) return;
    for (const cb of listeners[event]) {
      try {
        cb(data);
      } catch (e) {
        console.error(`[ws] listener error for ${event}:`, e);
      }
    }
  }

  return {
    /** Initialize and connect */
    init(code) {
      if (!code) {
        console.error('[ws] cannot initialize with empty roomCode');
        return;
      }
      this.disconnect();
      roomCode = code.trim().toUpperCase();
      intentionalClose = false;
      connect();
    },

    /** Send a message */
    send,

    /** Register event listener */
    on,

    /** Remove event listener */
    off,

    /** Disconnect intentionally */
    disconnect() {
      intentionalClose = true;
      stopPing();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      reconnectAttempts = 0;
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        try {
          socket.close(1000, 'Intentional disconnect');
        } catch (e) {}
        socket = null;
      }
      emit('status', { state: 'disconnected' });
    },

    /** Check if connected */
    isConnected() {
      return socket && socket.readyState === WebSocket.OPEN;
    },

    /** Send playback event (host only) */
    sendPlayback(action, position) {
      send({
        type: 'playback',
        payload: { action, position },
      });
    },

    /** Send reaction */
    sendReaction(reactionType) {
      send({
        type: 'reaction',
        payload: { reactionType },
      });
    },

    /** Toggle Director's Cut */
    sendDirectorCut(enabled) {
      send({
        type: 'director_cut',
        payload: { enabled },
      });
    },
  };
})();
