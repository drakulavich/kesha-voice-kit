// Kesha Voice Kit — site interactions
(function () {
  'use strict';

  // --- Theme toggle (default = system pref, fall back to dark) -------------
  const root = document.documentElement;
  const toggle = document.querySelector('[data-theme-toggle]');

  const sunSVG =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M2 12h2M20 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>';
  const moonSVG =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

  function applyTheme(theme) {
    root.setAttribute('data-theme', theme);
    if (toggle) {
      toggle.innerHTML = theme === 'dark' ? sunSVG : moonSVG;
      toggle.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`);
    }
  }

  let theme = 'dark';
  try {
    if (window.matchMedia('(prefers-color-scheme: light)').matches) theme = 'light';
  } catch (e) {}
  applyTheme(theme);

  if (toggle) {
    toggle.addEventListener('click', () => {
      theme = theme === 'dark' ? 'light' : 'dark';
      applyTheme(theme);
    });
  }

  // --- Sticky header shadow on scroll --------------------------------------
  const header = document.getElementById('header');
  if (header) {
    const onScroll = () => {
      if (window.scrollY > 8) header.classList.add('is-scrolled');
      else header.classList.remove('is-scrolled');
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  // --- Year ---------------------------------------------------------------
  const yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  // --- Copy to clipboard --------------------------------------------------
  const toast = document.getElementById('toast');
  let toastTimer;
  function showToast(msg) {
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 1500);
  }

  document.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const text = btn.getAttribute('data-copy');
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          // fallback
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        }
        showToast('Copied to clipboard');
      } catch (e) {
        showToast('Copy failed');
      }
    });
  });

  // --- Tabs ---------------------------------------------------------------
  document.querySelectorAll('[data-tabs]').forEach((wrapper) => {
    const buttons = wrapper.querySelectorAll('[data-tab]');
    const panels = wrapper.querySelectorAll('[data-panel]');
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.getAttribute('data-tab');
        buttons.forEach((b) => b.classList.toggle('is-active', b === btn));
        panels.forEach((p) =>
          p.classList.toggle('is-active', p.getAttribute('data-panel') === target)
        );
      });
    });
  });

  // --- GitHub stars (best effort, ignore failure) -------------------------
  const starsEl = document.getElementById('github-stars');
  if (starsEl) {
    starsEl.setAttribute('data-loaded', 'false');
    fetch('https://api.github.com/repos/drakulavich/kesha-voice-kit')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && typeof d.stargazers_count === 'number') {
          starsEl.textContent = `★ ${d.stargazers_count.toLocaleString()}`;
          starsEl.setAttribute('data-loaded', 'true');
        }
      })
      .catch(() => {});
  }

  // --- Reveal on scroll (subtle) -----------------------------------------
  const io = 'IntersectionObserver' in window
    ? new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              entry.target.classList.add('is-revealed');
              io.unobserve(entry.target);
            }
          });
        },
        { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
      )
    : null;

  if (io) {
    document
      .querySelectorAll('.feature, .step, .integration-card, .bench-figure, .bench-copy')
      .forEach((el) => {
        el.classList.add('reveal');
        io.observe(el);
      });
    // Failsafe — reveal anything still hidden after a short window
    // (prevents content being invisible if IO never fires, e.g. headless screenshots)
    setTimeout(() => {
      document.querySelectorAll('.reveal:not(.is-revealed)').forEach((el) => {
        if (el.getBoundingClientRect().top < window.innerHeight + 200) {
          el.classList.add('is-revealed');
        }
      });
    }, 800);
  } else {
    // No IO support: skip the animation entirely
    document
      .querySelectorAll('.feature, .step, .integration-card, .bench-figure, .bench-copy')
      .forEach((el) => el.classList.add('is-revealed'));
  }
})();

/* ============================================================
   Audio players for the "Hear it" section
   - Lightweight, framework-free
   - Only one track plays at a time
   - Falls back to "missing" state if the asset 404s
   ============================================================ */
(function () {
  const players = Array.from(document.querySelectorAll('.audio-player'));
  if (!players.length) return;

  const PLAY_ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
  const PAUSE_ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';

  function fmt(t) {
    if (!isFinite(t)) return '0:00';
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  const all = [];

  players.forEach((el) => {
    const src = el.getAttribute('data-src');
    const label = el.getAttribute('data-label') || 'Audio sample';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'audio-player__btn';
    btn.setAttribute('aria-label', `Play ${label}`);
    btn.innerHTML = PLAY_ICON;

    const track = document.createElement('div');
    track.className = 'audio-player__track';
    const bar = document.createElement('div');
    bar.className = 'audio-player__bar';
    const fill = document.createElement('div');
    fill.className = 'audio-player__fill';
    bar.appendChild(fill);
    track.appendChild(bar);

    const time = document.createElement('span');
    time.className = 'audio-player__time';
    time.textContent = '0:00';

    el.appendChild(btn);
    el.appendChild(track);
    el.appendChild(time);

    const audio = new Audio();
    audio.preload = 'none';
    audio.src = src;

    let dur = 0;
    let ready = false;

    function setMissing() {
      el.setAttribute('data-state', 'missing');
      btn.disabled = true;
      btn.setAttribute('aria-label', `${label} not available`);
      time.textContent = '—';
    }

    audio.addEventListener('error', setMissing);
    audio.addEventListener('loadedmetadata', () => {
      ready = true;
      dur = audio.duration;
      time.textContent = fmt(dur);
    });
    audio.addEventListener('timeupdate', () => {
      const pct = dur ? (audio.currentTime / dur) * 100 : 0;
      fill.style.width = pct + '%';
      time.textContent = fmt(dur - audio.currentTime);
    });
    audio.addEventListener('ended', () => {
      el.setAttribute('data-state', 'idle');
      btn.innerHTML = PLAY_ICON;
      btn.setAttribute('aria-label', `Play ${label}`);
      fill.style.width = '0%';
      time.textContent = fmt(dur);
    });

    btn.addEventListener('click', () => {
      if (audio.paused) {
        all.forEach((p) => {
          if (p.audio !== audio && !p.audio.paused) p.pause();
        });
        if (!ready) {
          audio.load();
        }
        audio.play().catch(setMissing);
        el.setAttribute('data-state', 'playing');
        btn.innerHTML = PAUSE_ICON;
        btn.setAttribute('aria-label', `Pause ${label}`);
      } else {
        audio.pause();
        el.setAttribute('data-state', 'idle');
        btn.innerHTML = PLAY_ICON;
        btn.setAttribute('aria-label', `Play ${label}`);
      }
    });

    track.addEventListener('click', (e) => {
      if (!ready || !dur) return;
      const rect = bar.getBoundingClientRect();
      const x = Math.min(Math.max(e.clientX - rect.left, 0), rect.width);
      audio.currentTime = (x / rect.width) * dur;
    });

    // Probe for asset presence (HEAD). If 404, mark missing immediately.
    fetch(src, { method: 'HEAD' }).then((r) => {
      if (!r.ok) setMissing();
    }).catch(() => {
      // Network error — leave state idle; the <audio> error handler will catch
      // it if the user tries to play.
    });

    all.push({ audio, pause: () => audio.pause() });
  });
})();
