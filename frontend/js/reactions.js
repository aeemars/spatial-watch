/* ═══════════════════════════════════════════════════════════
   SPATIAL WATCH — Reactions
   Floating emoji reactions with broadcast support
   ═══════════════════════════════════════════════════════════ */

const Reactions = (() => {
  const EMOJI_MAP = {
    applause: '👏',
    laugh: '😂',
    heart: '❤️',
    surprised: '😮',
    wow: '🤩',
    popcorn: '🍿',
  };

  let container = null;

  function init() {
    container = document.getElementById('reaction-container');

    // Listen for incoming reactions
    WS.on('reaction', (data) => {
      const payload = data.payload || {};
      showFloat(payload.reactionType, data.displayName);
    });
  }

  function showFloat(type, displayName) {
    const emoji = EMOJI_MAP[type];
    if (!emoji || !container) return;

    const el = document.createElement('div');
    el.className = 'reaction-float';
    el.textContent = emoji;
    el.setAttribute('aria-hidden', 'true');

    // Randomize horizontal position
    const xOffset = (Math.random() - 0.5) * 200;
    el.style.left = `calc(50% + ${xOffset}px)`;
    el.style.bottom = '0';

    container.appendChild(el);

    // Remove after animation completes
    setTimeout(() => {
      el.remove();
    }, 2200);
  }

  function send(type) {
    if (!EMOJI_MAP[type]) return;
    WS.sendReaction(type);
    // Show own reaction immediately
    showFloat(type, 'You');
  }

  return { init, send, showFloat, EMOJI_MAP };
})();
