/* ═══════════════════════════════════════════════════════════
   SPATIAL WATCH — App Orchestration
   Screen management, modal logic, WS event handling,
   and desktop cinema controls
   ═══════════════════════════════════════════════════════════ */

const App = (() => {
  // State
  let currentScreen = 'landing';
  let roomCode = '';
  let participantId = '';
  let displayName = '';
  let isHost = false;
  let participants = [];
  let controlHideTimer = null;

  // ─── Initialization ───────────────────────────────
  function init() {
    // Check WebXR support
    XR.checkSupport();

    // Bind landing buttons
    document.getElementById('btn-create-room').addEventListener('click', () => openModal('modal-create'));
    document.getElementById('btn-join-room').addEventListener('click', () => openModal('modal-join'));

    // Bind modal close buttons
    document.getElementById('modal-create-close').addEventListener('click', () => closeModal('modal-create'));
    document.getElementById('modal-join-close').addEventListener('click', () => closeModal('modal-join'));

    // Click overlay to close modal
    document.getElementById('modal-create').addEventListener('click', (e) => {
      if (e.target.classList.contains('modal-overlay')) closeModal('modal-create');
    });
    document.getElementById('modal-join').addEventListener('click', (e) => {
      if (e.target.classList.contains('modal-overlay')) closeModal('modal-join');
    });

    // Escape key closes modals
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeModal('modal-create');
        closeModal('modal-join');
      }
    });

    // Create room form
    document.getElementById('btn-create-submit').addEventListener('click', handleCreateRoom);
    document.getElementById('create-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleCreateRoom();
    });

    // Join room form
    document.getElementById('btn-join-submit').addEventListener('click', handleJoinRoom);
    document.getElementById('join-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleJoinRoom();
    });

    // Room code auto-formatting
    document.getElementById('join-code').addEventListener('input', (e) => {
      let val = e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '');
      // Auto-insert dash after SW
      if (val.length === 2 && !val.includes('-')) {
        val = val + '-';
      }
      e.target.value = val;
    });

    // Lobby buttons
    document.getElementById('btn-enter-cinema').addEventListener('click', handleEnterCinema);
    document.getElementById('btn-leave-lobby').addEventListener('click', leaveRoom);

    // Cinema controls
    document.getElementById('btn-play-pause').addEventListener('click', handlePlayPause);
    document.getElementById('btn-seek-back').addEventListener('click', () => handleSeek(-10));
    document.getElementById('btn-seek-forward').addEventListener('click', () => handleSeek(10));
    document.getElementById('btn-cinema-dc').addEventListener('click', handleToggleDirectorCut);
    document.getElementById('btn-cinema-exit').addEventListener('click', leaveRoom);
    document.getElementById('btn-enter-vr').addEventListener('click', () => XR.enterVR());

    // Progress bar
    const progressBar = document.getElementById('cinema-progress');
    progressBar.addEventListener('input', handleProgressSeek);

    // Reaction buttons
    document.querySelectorAll('.reaction-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        Reactions.send(btn.dataset.reaction);
      });
    });

    // Cinema controls auto-hide
    setupControlsAutoHide();

    // WS event handlers
    setupWSHandlers();

    // Initialize sub-modules
    Reactions.init();
    DirectorsCut.init();
  }

  // ─── Modal Management ─────────────────────────────

  function openModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.hidden = false;
    // Force reflow for transition
    modal.offsetHeight;
    modal.classList.add('is-visible');

    // Focus first input
    const input = modal.querySelector('input');
    if (input) setTimeout(() => input.focus(), 100);
  }

  function closeModal(id) {
    const modal = document.getElementById(id);
    if (!modal || modal.hidden) return;
    modal.classList.remove('is-visible');
    setTimeout(() => {
      modal.hidden = true;
    }, 300);
  }

  // ─── Room Creation ────────────────────────────────

  async function handleCreateRoom() {
    const nameInput = document.getElementById('create-name');
    const nameError = document.getElementById('create-name-error');
    const submitBtn = document.getElementById('btn-create-submit');
    const name = nameInput.value.trim();

    // Validate
    if (!name || name.length < 1) {
      nameError.textContent = 'Please enter your display name';
      nameError.hidden = false;
      nameInput.classList.add('input--error');
      return;
    }

    nameError.hidden = true;
    nameInput.classList.remove('input--error');

    // Loading state
    submitBtn.classList.add('btn--loading');
    submitBtn.disabled = true;

    try {
      const data = await API.createRoom(name);
      roomCode = data.roomCode;
      participantId = data.participantId;
      displayName = name;
      isHost = data.isHost;

      closeModal('modal-create');
      enterLobby();
      showToast(`Room ${roomCode} created`, 'success');
    } catch (e) {
      nameError.textContent = e.message || 'Failed to create room';
      nameError.hidden = false;
      nameInput.classList.add('input--error');
    } finally {
      submitBtn.classList.remove('btn--loading');
      submitBtn.disabled = false;
    }
  }

  // ─── Room Joining ─────────────────────────────────

  async function handleJoinRoom() {
    const codeInput = document.getElementById('join-code');
    const nameInput = document.getElementById('join-name');
    const codeError = document.getElementById('join-code-error');
    const nameError = document.getElementById('join-name-error');
    const submitBtn = document.getElementById('btn-join-submit');

    const code = codeInput.value.trim().toUpperCase();
    const name = nameInput.value.trim();

    // Validate
    let valid = true;
    if (!code || code.length < 4) {
      codeError.textContent = 'Enter a valid room code';
      codeError.hidden = false;
      codeInput.classList.add('input--error');
      valid = false;
    } else {
      codeError.hidden = true;
      codeInput.classList.remove('input--error');
    }

    if (!name || name.length < 1) {
      nameError.textContent = 'Please enter your display name';
      nameError.hidden = false;
      nameInput.classList.add('input--error');
      valid = false;
    } else {
      nameError.hidden = true;
      nameInput.classList.remove('input--error');
    }

    if (!valid) return;

    submitBtn.classList.add('btn--loading');
    submitBtn.disabled = true;

    try {
      const data = await API.joinRoom(code, name);
      roomCode = data.roomCode;
      participantId = data.participantId;
      displayName = name;
      isHost = data.isHost;

      closeModal('modal-join');
      enterLobby();
      showToast(`Joined room ${roomCode}`, 'success');
    } catch (e) {
      codeError.textContent = e.message || 'Room not found';
      codeError.hidden = false;
      codeInput.classList.add('input--error');
    } finally {
      submitBtn.classList.remove('btn--loading');
      submitBtn.disabled = false;
    }
  }

  // ─── Lobby ────────────────────────────────────────

  function enterLobby() {
    showScreen('lobby');

    // Update lobby UI
    document.getElementById('lobby-room-code').textContent = roomCode;

    // Connect WebSocket
    WS.init(roomCode, participantId);

    // Load commentary cues
    DirectorsCut.loadCues(roomCode);

    // Poll room info
    refreshLobby();
  }

  async function refreshLobby() {
    try {
      const data = await API.getRoom(roomCode);
      const room = data.room;
      participants = data.participants || [];

      // Update screening card
      document.getElementById('lobby-media-title').textContent = extractMediaTitle(room.mediaUrl);
      document.getElementById('lobby-dc-badge').hidden = !room.directorCutEnabled;

      // Update participant list
      updateParticipantList(participants);
    } catch (e) {
      console.warn('[app] failed to refresh lobby:', e);
    }
  }

  function updateParticipantList(parts) {
    const listEl = document.getElementById('lobby-participant-list');
    const countEl = document.getElementById('lobby-participant-count');

    countEl.textContent = parts.length;
    listEl.innerHTML = '';

    parts.forEach((p) => {
      const li = document.createElement('li');
      li.className = 'participant-item';
      li.innerHTML = `
        <div class="avatar">${p.displayName.charAt(0).toUpperCase()}</div>
        <span class="participant-item__name">${escapeHtml(p.displayName)}</span>
        <div class="participant-item__badges">
          ${p.participantId === participantId ? '<span class="chip chip--presence chip--sm">You</span>' : ''}
          ${isParticipantHost(p.participantId) ? '<span class="badge badge--host">Host</span>' : ''}
        </div>
      `;
      listEl.appendChild(li);
    });
  }

  function isParticipantHost(pid) {
    // This is checked against room state from WS
    return false; // Will be updated by room_state event
  }

  let hostParticipantId = '';

  // ─── Cinema ───────────────────────────────────────

  function handleEnterCinema() {
    showScreen('cinema');

    // Get current room state for media URL
    API.getRoom(roomCode).then(data => {
      const room = data.room;
      hostParticipantId = room.hostParticipantId;
      isHost = room.hostParticipantId === participantId;

      Cinema.init(room.mediaUrl, isHost);

      // Update cinema UI
      document.getElementById('cinema-room-code').textContent = roomCode;
      document.getElementById('cinema-participant-badge').textContent = (data.participants || []).length;

      // Sync playback state
      if (!room.isPaused) {
        const elapsed = (Date.now() - new Date(room.updatedAt).getTime()) / 1000;
        Cinema.seek(room.playbackPositionSeconds + elapsed);
        Cinema.play();
      } else {
        Cinema.seek(room.playbackPositionSeconds);
      }

      // Director's Cut state
      DirectorsCut.setEnabled(room.directorCutEnabled);
      DirectorsCut.startChecking(() => Cinema.getCurrentTime());

      // Add seat markers for existing participants
      (data.participants || []).forEach((p, i) => {
        if (p.participantId !== participantId) {
          Cinema.addSeatMarker(p.participantId, p.displayName, i);
        }
      });

      // Update video time display
      startTimeUpdater();
    }).catch(e => {
      showToast('Failed to load cinema', 'error');
      showScreen('lobby');
    });
  }

  // ─── Playback Controls ────────────────────────────

  function handlePlayPause() {
    if (Cinema.isPlaying()) {
      Cinema.pause();
      if (isHost) WS.sendPlayback('pause', Cinema.getCurrentTime());
    } else {
      Cinema.play();
      if (isHost) WS.sendPlayback('play', Cinema.getCurrentTime());
    }
  }

  function handleSeek(delta) {
    const newPos = Math.max(0, Cinema.getCurrentTime() + delta);
    Cinema.seek(newPos);
    if (isHost) WS.sendPlayback('seek', newPos);
  }

  function handleProgressSeek(e) {
    const duration = Cinema.getDuration();
    if (!duration) return;
    const newPos = (e.target.value / 100) * duration;
    Cinema.seek(newPos);
    if (isHost) WS.sendPlayback('seek', newPos);
  }

  function handleToggleDirectorCut() {
    if (!isHost) {
      showToast('Only the host can toggle Director\'s Cut', 'error');
      return;
    }
    const newState = !DirectorsCut.isEnabled();
    DirectorsCut.setEnabled(newState);
    WS.sendDirectorCut(newState);
    showToast(newState ? 'Director\'s Cut enabled' : 'Director\'s Cut disabled', 'success');
  }

  // ─── Time Display Updater ─────────────────────────

  let timeUpdaterInterval = null;

  function startTimeUpdater() {
    stopTimeUpdater();
    timeUpdaterInterval = setInterval(() => {
      const current = Cinema.getCurrentTime();
      const duration = Cinema.getDuration();

      document.getElementById('cinema-time-current').textContent = formatTime(current);
      document.getElementById('cinema-time-duration').textContent = formatTime(duration);

      const progressBar = document.getElementById('cinema-progress');
      if (duration > 0) {
        progressBar.value = (current / duration) * 100;
      }
    }, 250);
  }

  function stopTimeUpdater() {
    if (timeUpdaterInterval) {
      clearInterval(timeUpdaterInterval);
      timeUpdaterInterval = null;
    }
  }

  // ─── Controls Auto-Hide ───────────────────────────

  function setupControlsAutoHide() {
    const controls = document.getElementById('cinema-controls');
    if (!controls) return;

    function showControls() {
      controls.classList.remove('is-hidden');
      clearTimeout(controlHideTimer);
      controlHideTimer = setTimeout(() => {
        // Don't hide if controls have focus or modal is open
        if (controls.matches(':focus-within')) return;
        controls.classList.add('is-hidden');
      }, 4000);
    }

    // Show on mouse movement
    document.addEventListener('mousemove', () => {
      if (currentScreen === 'cinema') showControls();
    });

    // Show on keyboard
    document.addEventListener('keydown', (e) => {
      if (currentScreen !== 'cinema') return;
      showControls();

      // Keyboard shortcuts
      if (e.target.tagName === 'INPUT') return;
      switch (e.key) {
        case ' ':
        case 'k':
          e.preventDefault();
          handlePlayPause();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          handleSeek(-10);
          break;
        case 'ArrowRight':
          e.preventDefault();
          handleSeek(10);
          break;
      }
    });

    // Show on touch
    document.addEventListener('touchstart', () => {
      if (currentScreen === 'cinema') showControls();
    }, { passive: true });
  }

  // ─── WebSocket Event Handlers ─────────────────────

  function setupWSHandlers() {
    WS.on('status', (data) => {
      updateConnectionStatus(data.state);
    });

    WS.on('room_state', (data) => {
      const payload = data.payload || {};
      hostParticipantId = payload.hostParticipantId;
      isHost = payload.hostParticipantId === participantId;
      participants = payload.participants || [];

      if (currentScreen === 'lobby') {
        updateParticipantList(participants);
        document.getElementById('lobby-dc-badge').hidden = !payload.directorCutEnabled;
      }

      if (currentScreen === 'cinema') {
        document.getElementById('cinema-participant-badge').textContent = participants.length;

        // Sync playback
        if (payload.isPaused) {
          Cinema.pause();
          Cinema.seek(payload.position);
        } else {
          const drift = (Date.now() - payload.serverTime) / 1000;
          Cinema.seek(payload.position + drift);
          Cinema.play();
        }

        DirectorsCut.setEnabled(payload.directorCutEnabled);
      }
    });

    WS.on('playback', (data) => {
      if (data.participantId === participantId) return; // Don't re-apply own actions
      const payload = data.payload || {};
      const drift = (Date.now() - payload.serverTime) / 1000;

      switch (payload.action) {
        case 'play':
          Cinema.seek(payload.position + drift);
          Cinema.play();
          break;
        case 'pause':
          Cinema.pause();
          Cinema.seek(payload.position);
          break;
        case 'seek':
          Cinema.seek(payload.position);
          break;
      }
    });

    WS.on('participant_joined', (data) => {
      showToast(`${data.displayName} joined`, 'success');
      refreshLobby();
      if (currentScreen === 'cinema') {
        const idx = Object.keys(Cinema).length; // approximate seat index
        Cinema.addSeatMarker(data.participantId, data.displayName, participants.length);
      }
    });

    WS.on('participant_left', (data) => {
      showToast(`${data.displayName} left`);
      refreshLobby();
      Cinema.removeSeatMarker(data.participantId);
    });

    WS.on('director_cut', (data) => {
      const payload = data.payload || {};
      DirectorsCut.setEnabled(payload.enabled);
      showToast(payload.enabled ? 'Director\'s Cut enabled by host' : 'Director\'s Cut disabled', 'success');
    });

    WS.on('error', (data) => {
      const payload = data.payload || {};
      showToast(payload.message || 'An error occurred', 'error');
    });
  }

  // ─── Connection Status ────────────────────────────

  function updateConnectionStatus(state) {
    const statusEl = document.getElementById('lobby-connection-status');
    if (!statusEl) return;

    const dot = statusEl.querySelector('.connection-status__dot');
    const text = statusEl.querySelector('.connection-status__text');

    // Remove all state classes
    dot.className = 'connection-status__dot';

    switch (state) {
      case 'connected':
        dot.classList.add('connection-status__dot--connected');
        text.textContent = 'Connected';
        break;
      case 'connecting':
        dot.classList.add('connection-status__dot--connecting');
        text.textContent = 'Connecting…';
        break;
      case 'reconnecting':
        dot.classList.add('connection-status__dot--connecting');
        text.textContent = 'Reconnecting…';
        break;
      case 'disconnected':
      case 'failed':
        dot.classList.add('connection-status__dot--disconnected');
        text.textContent = 'Disconnected';
        break;
    }
  }

  // ─── Screen Management ────────────────────────────

  function showScreen(name) {
    currentScreen = name;
    document.querySelectorAll('.screen').forEach(s => {
      s.hidden = !s.id.endsWith(name);
    });
  }

  // ─── Leave Room ───────────────────────────────────

  function leaveRoom() {
    WS.disconnect();
    stopTimeUpdater();
    DirectorsCut.stopChecking();
    Cinema.destroy();

    roomCode = '';
    participantId = '';
    isHost = false;
    participants = [];

    showScreen('landing');
    showToast('Left room');
  }

  // ─── Toast Notifications ──────────────────────────

  function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type === 'error' ? 'toast--error' : type === 'success' ? 'toast--success' : ''}`;
    toast.textContent = message;

    container.appendChild(toast);

    // Trigger transition
    requestAnimationFrame(() => {
      toast.classList.add('is-visible');
    });

    // Remove after 3.5 seconds
    setTimeout(() => {
      toast.classList.remove('is-visible');
      setTimeout(() => toast.remove(), 250);
    }, 3500);
  }

  // ─── Utilities ────────────────────────────────────

  function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function extractMediaTitle(url) {
    if (!url) return 'Unknown';
    try {
      const pathname = new URL(url).pathname;
      const filename = pathname.split('/').pop();
      return filename
        .replace(/\.[^/.]+$/, '')
        .replace(/([A-Z])/g, ' $1')
        .replace(/[_-]/g, ' ')
        .trim() || 'Demo Film';
    } catch {
      return 'Demo Film';
    }
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ─── Public API ───────────────────────────────────

  return {
    init,
    showToast,
    leaveRoom,
    showScreen,
  };
})();

// ─── Bootstrap ──────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  App.init();
});
