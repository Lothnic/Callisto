/* ============================================================
   Callisto — interaction layer
   Ticker pacing · walkthrough transport · stepper · copy buttons
   ============================================================ */
(() => {
  'use strict';

  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const prefersReduced = () => motionQuery.matches;
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

  /* ----------------------------------------------------------
     Ticker — derive duration from the real strip width so the
     loop speed stays constant across viewports.
     ---------------------------------------------------------- */
  function paceTicker() {
    const inner = document.querySelector('.hero-ticker-inner');
    const group = document.querySelector('.hero-ticker-group');
    if (!inner || !group) return;
    const width = group.getBoundingClientRect().width;
    if (!width) return;
    // ~70px per second, floored so short strips don't sprint.
    const seconds = Math.max(26, Math.round(width / 70));
    inner.style.setProperty('--ticker-duration', `${seconds}s`);
  }

  /* ----------------------------------------------------------
     Walkthrough — step markers, transport, terminal reveal and
     chat scene switching share one index.
     ---------------------------------------------------------- */
  function initWalkthrough() {
    const root = document.getElementById('walkthrough');
    if (!root) return;

    const markers = Array.from(root.querySelectorAll('[data-go]'));
    const copies = Array.from(root.querySelectorAll('[data-copy]'));
    const scenes = Array.from(root.querySelectorAll('[data-scene]'));
    const reveals = Array.from(root.querySelectorAll('[data-reveal]'));
    const thread = root.querySelector('.chat-thread');
    const playBtn = root.querySelector('[data-play]');
    const prevBtn = root.querySelector('[data-prev]');
    const nextBtn = root.querySelector('[data-next]');
    const total = Math.max(copies.length, scenes.length, 1);
    const STEP_MS = 4600;

    let step = 0;
    let timer = null;

    function setPlaying(on) {
      root.dataset.playing = on ? 'true' : 'false';
      if (playBtn) {
        playBtn.setAttribute('aria-label', on ? 'Pause walkthrough' : 'Play walkthrough');
        playBtn.innerHTML = on
          ? 'Pause <span aria-hidden="true">❚❚</span>'
          : 'Play <span aria-hidden="true">▶</span>';
      }
    }

    function stop() {
      if (timer) window.clearInterval(timer);
      timer = null;
      setPlaying(false);
    }

    function render(next, { scroll = true } = {}) {
      step = ((next % total) + total) % total;
      root.dataset.step = String(step);

      markers.forEach((marker, i) => {
        if (i === step) marker.setAttribute('aria-current', 'step');
        else marker.removeAttribute('aria-current');
      });

      copies.forEach((copy, i) => {
        copy.setAttribute('aria-hidden', i === step ? 'false' : 'true');
      });

      scenes.forEach((scene, i) => {
        scene.hidden = i !== step;
      });

      reveals.forEach((node) => {
        const at = Number(node.dataset.reveal || 0);
        node.classList.toggle('is-visible', at <= step);
      });

      if (scroll && thread) {
        window.requestAnimationFrame(() => {
          thread.scrollTo({ top: thread.scrollHeight, behavior: prefersReduced() ? 'auto' : 'smooth' });
        });
      }
    }

    function play() {
      if (prefersReduced()) return;
      if (step >= total - 1) render(0, { scroll: false });
      setPlaying(true);
      if (timer) window.clearInterval(timer);
      timer = window.setInterval(() => {
        if (step >= total - 1) {
          stop();
          return;
        }
        render(step + 1);
      }, STEP_MS);
    }

    markers.forEach((marker) => {
      marker.addEventListener('click', () => {
        stop();
        render(Number(marker.dataset.go || 0));
      });
    });

    prevBtn?.addEventListener('click', () => {
      stop();
      render(step - 1);
    });

    nextBtn?.addEventListener('click', () => {
      stop();
      render(step + 1);
    });

    playBtn?.addEventListener('click', () => {
      if (timer) stop();
      else play();
    });

    // Pause the autoplay while the reader is inspecting the demo.
    root.addEventListener('pointerenter', () => {
      if (timer) stop();
    });

    // Keyboard: left/right moves through the loop when the demo has focus.
    root.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      stop();
      render(step + (event.key === 'ArrowRight' ? 1 : -1));
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden && timer) stop();
    });

    render(0, { scroll: false });
    setPlaying(false);

    // Kick off only once the walkthrough is actually on screen.
    if ('IntersectionObserver' in window && !prefersReduced()) {
      let started = false;
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting && !started) {
              started = true;
              play();
              observer.disconnect();
            }
          }
        },
        { threshold: 0.35 }
      );
      observer.observe(root);
    }
  }

  /* ----------------------------------------------------------
     How-it-works stepper — mirrors the 6s progress animation
     and highlights the matching schematic node.
     ---------------------------------------------------------- */
  function initStepper() {
    const root = document.getElementById('stepper');
    if (!root) return;

    const steps = Array.from(root.querySelectorAll('.how-step'));
    const nodes = Array.from(root.querySelectorAll('.workflow-step'));
    if (!steps.length) return;

    const DURATION = 6000;
    let current = 0;
    let timer = null;
    let inView = false;
    let paused = false;

    function activate(index) {
      current = ((index % steps.length) + steps.length) % steps.length;

      steps.forEach((step, i) => {
        const on = i === current;
        step.classList.toggle('active', on);
        step.setAttribute('aria-expanded', on ? 'true' : 'false');
        if (on) {
          const fill = step.querySelector('.how-step-progress-fill');
          if (fill) {
            fill.style.animation = 'none';
            void fill.offsetWidth;
            fill.style.animation = '';
          }
        }
      });

      nodes.forEach((node, i) => node.classList.toggle('is-active', i === current));
    }

    function tick() {
      if (timer) window.clearInterval(timer);
      timer = null;
      if (!inView || paused || prefersReduced()) return;
      timer = window.setInterval(() => {
        if (paused || !inView) return;
        activate(current + 1);
      }, DURATION);
    }

    steps.forEach((step, i) => {
      step.addEventListener('click', () => {
        activate(i);
        tick();
      });
      step.addEventListener('focus', () => {
        paused = true;
        if (timer) window.clearInterval(timer);
        timer = null;
      });
      step.addEventListener('blur', () => {
        paused = false;
        tick();
      });
    });

    root.addEventListener('pointerenter', () => {
      paused = true;
      if (timer) window.clearInterval(timer);
      timer = null;
    });
    root.addEventListener('pointerleave', () => {
      paused = false;
      tick();
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (timer) window.clearInterval(timer);
        timer = null;
      } else {
        tick();
      }
    });

    activate(0);

    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            inView = entry.isIntersecting;
            if (inView) {
              activate(current);
              tick();
            } else if (timer) {
              window.clearInterval(timer);
              timer = null;
            }
          }
        },
        { threshold: 0.2 }
      );
      observer.observe(root);
    } else {
      inView = true;
      tick();
    }
  }

  /* ----------------------------------------------------------
     Copy buttons — clipboard with a legacy fallback.
     ---------------------------------------------------------- */
  function initCopyButtons() {
    const buttons = Array.from(document.querySelectorAll('.copy-btn[data-copy]'));
    if (!buttons.length) return;

    async function write(text) {
      if (navigator.clipboard && window.isSecureContext) {
        try {
          await navigator.clipboard.writeText(text);
          return true;
        } catch {
          /* fall through */
        }
      }
      const field = document.createElement('textarea');
      field.value = text;
      field.setAttribute('readonly', '');
      field.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
      document.body.appendChild(field);
      field.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      field.remove();
      return ok;
    }

    buttons.forEach((button) => {
      const label = button.textContent;
      button.addEventListener('click', async () => {
        const ok = await write(button.dataset.copy || '');
        button.textContent = ok ? 'Copied' : 'Select';
        button.classList.toggle('copied', ok);
        if (!ok) {
          const code = button.parentElement?.querySelector('code');
          if (code) {
            const range = document.createRange();
            range.selectNodeContents(code);
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
          }
        }
        window.clearTimeout(button._resetTimer);
        button._resetTimer = window.setTimeout(() => {
          button.textContent = label;
          button.classList.remove('copied');
        }, 1800);
      });
    });
  }

  /* ----------------------------------------------------------
     Boot
     ---------------------------------------------------------- */
  function boot() {
    paceTicker();
    initWalkthrough();
    initStepper();
    initCopyButtons();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  let resizeFrame = 0;
  window.addEventListener('resize', () => {
    if (resizeFrame) return;
    resizeFrame = window.requestAnimationFrame(() => {
      resizeFrame = 0;
      paceTicker();
    });
  });

  motionQuery.addEventListener?.('change', () => {
    paceTicker();
  });
})();
