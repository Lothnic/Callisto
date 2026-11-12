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

  /* A slowly moving wireframe beneath the final call to action. */
  function initCtaWave() {
    const canvas = document.querySelector('.cta-wave');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const section = canvas.closest('.cta-section');
    let width = 0, height = 0, frame = 0, lastPaint = 0;
    let inView = false;
    const particles = [
      { x: .13, row: 3, phase: 0 }, { x: .45, row: 10, phase: 2 },
      { x: .78, row: 6, phase: 4 }, { x: .93, row: 14, phase: 1 },
    ];

    function resize() {
      const rect = canvas.getBoundingClientRect();
      width = rect.width; height = rect.height;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      draw(0);
    }

    function point(x, row, time) {
      const depth = row / 19;
      const baseline = height * (.37 + depth * .55);
      const envelope = Math.sin(Math.PI * Math.min(1, Math.max(0, depth))) * .8 + .2;
      const wave = Math.sin(x * 6.3 + depth * 4.3 - time * .38)
        + .45 * Math.sin(x * 11 - depth * 3 + time * .22);
      return [x * width, baseline + wave * height * .13 * envelope];
    }

    function draw(time) {
      ctx.clearRect(0, 0, width, height);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(31, 126, 219, .65)';
      for (let row = 0; row < 20; row++) {
        ctx.beginPath();
        for (let step = 0; step <= 100; step++) {
          const [x, y] = point(step / 100, row, time);
          if (step === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(31, 126, 219, .48)';
      for (let col = 0; col <= 16; col++) {
        ctx.beginPath();
        for (let row = 0; row <= 19; row += .25) {
          const [x, y] = point(col / 16, row, time);
          if (row === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      for (const particle of particles) {
        const progress = (particle.x + time * .006) % 1;
        const [x, y] = point(progress, particle.row, time);
        ctx.beginPath();
        ctx.fillStyle = 'rgba(255, 191, 82, .85)';
        ctx.shadowColor = '#ffa62e'; ctx.shadowBlur = 11;
        ctx.arc(x, y, 2, 0, Math.PI * 2); ctx.fill();
      }
      ctx.shadowBlur = 0;
    }

    function tick(now) {
      if (!inView || prefersReduced()) { frame = 0; return; }
      if (now - lastPaint >= 32) { draw(now / 1000); lastPaint = now; }
      frame = window.requestAnimationFrame(tick);
    }
    function refresh() {
      if (prefersReduced()) {
        if (frame) window.cancelAnimationFrame(frame);
        frame = 0; draw(0);
      } else if (inView && !frame) frame = window.requestAnimationFrame(tick);
    }
    resize();
    window.addEventListener('resize', resize);
    motionQuery.addEventListener?.('change', refresh);
    if ('IntersectionObserver' in window && section) {
      new IntersectionObserver(entries => { inView = entries[0].isIntersecting; refresh(); }).observe(section);
    } else { inView = true; refresh(); }
  }

  /* ----------------------------------------------------------
     Boot
     ---------------------------------------------------------- */
  function boot() {
    paceTicker();
    initWalkthrough();
    initStepper();
    initCopyButtons();
    initCtaWave();
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
