/* ═══════════════════════════════════════════════════════════
   SPATIAL WATCH — Director's Cut
   Timed commentary cue system
   ═══════════════════════════════════════════════════════════ */

const DirectorsCut = (() => {
  let cues = [];
  let enabled = false;
  let shownCues = new Set();
  let dismissedCue = null;
  let currentCue = null;
  let checkInterval = null;

  // DOM elements
  const cardEl = document.getElementById('commentary-card');
  const titleEl = document.getElementById('commentary-title');
  const bodyEl = document.getElementById('commentary-body');
  const categoryEl = document.getElementById('commentary-category');
  const dismissBtn = document.getElementById('commentary-dismiss');

  function init() {
    if (dismissBtn) {
      dismissBtn.addEventListener('click', dismiss);
    }

    // Listen for Director's Cut toggle events
    WS.on('director_cut', (data) => {
      const payload = data.payload || {};
      setEnabled(payload.enabled);
    });
  }

  async function loadCues(roomCode) {
    try {
      const data = await API.getCommentary(roomCode);
      cues = (data.cues || []).sort((a, b) => a.timestampSeconds - b.timestampSeconds);
    } catch (e) {
      console.warn('[dc] failed to load cues:', e);
      cues = [];
    }
  }

  function setEnabled(state) {
    enabled = state;
    if (!enabled) {
      hideCard();
      shownCues.clear();
    }
    // Update UI indicator
    const dcBtn = document.getElementById('btn-cinema-dc');
    if (dcBtn) {
      dcBtn.classList.toggle('text--violet', enabled);
      dcBtn.style.color = enabled ? 'var(--violet)' : '';
    }
    const lobbyBadge = document.getElementById('lobby-dc-badge');
    if (lobbyBadge) {
      lobbyBadge.hidden = !enabled;
    }
  }

  function startChecking(getTime) {
    stopChecking();
    checkInterval = setInterval(() => {
      if (!enabled) return;
      const currentTime = getTime();
      check(currentTime);
    }, 500);
  }

  function stopChecking() {
    if (checkInterval) {
      clearInterval(checkInterval);
      checkInterval = null;
    }
  }

  function check(currentTime) {
    if (!enabled || cues.length === 0) return;

    // Find the most recent cue within a 3-second window
    for (const cue of cues) {
      const id = cue.timestampSeconds;
      if (shownCues.has(id)) continue;
      if (dismissedCue === id) continue;

      if (currentTime >= cue.timestampSeconds && currentTime <= cue.timestampSeconds + 3) {
        showCue(cue);
        shownCues.add(id);
        break;
      }
    }
  }

  function showCue(cue) {
    currentCue = cue;

    if (titleEl) titleEl.textContent = cue.title;
    if (bodyEl) bodyEl.textContent = cue.body;
    if (categoryEl) categoryEl.textContent = cue.category || 'Commentary';

    if (cardEl) {
      cardEl.hidden = false;
      // Force reflow before adding visible class for transition
      cardEl.offsetHeight;
      cardEl.classList.add('is-visible');
    }

    // Auto-dismiss after 12 seconds
    setTimeout(() => {
      if (currentCue === cue) {
        hideCard();
      }
    }, 12000);
  }

  function hideCard() {
    if (cardEl) {
      cardEl.classList.remove('is-visible');
      setTimeout(() => {
        cardEl.hidden = true;
      }, 250);
    }
    currentCue = null;
  }

  function dismiss() {
    if (currentCue) {
      dismissedCue = currentCue.timestampSeconds;
    }
    hideCard();
  }

  function resetShown() {
    shownCues.clear();
    dismissedCue = null;
  }

  return {
    init,
    loadCues,
    setEnabled,
    startChecking,
    stopChecking,
    check,
    resetShown,
    isEnabled: () => enabled,
  };
})();
