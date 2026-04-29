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
