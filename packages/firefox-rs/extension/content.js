'use strict';
(() => {
  // executeScript may be invoked again when the person re-shares this tab.
  if (globalThis.__callistoTabBridge) return;
  globalThis.__callistoTabBridge = true;
  const nodeRefs = new WeakMap();
  let current = new Map();
  let enabled = true;
  function newRef() {
    const bits = crypto.getRandomValues(new Uint32Array(2));
    return `ax-${(BigInt(bits[0]) * 4294967296n + BigInt(bits[1])).toString()}`;
  }
  function reference(el) {
    let ref = nodeRefs.get(el);
    if (!ref) { ref = newRef(); nodeRefs.set(el, ref); }
    current.set(ref, el);
    return ref;
  }
  function role(el) {
    const explicit = el.getAttribute('role')?.trim().split(/\s+/)[0];
    if (explicit) return explicit;
    if (el.tagName === 'BUTTON') return 'button';
    if (el.tagName === 'A' && el.hasAttribute('href')) return 'link';
    if (el.tagName === 'TEXTAREA') return 'textbox';
    if (el.tagName === 'SELECT') return 'combobox';
    if (el.tagName === 'INPUT') {
      const type = (el.type || '').toLowerCase();
      if (type === 'hidden') return '';
      if (['checkbox','radio'].includes(type)) return type;
      if (['button','submit','reset'].includes(type)) return 'button';
      return type === 'search' ? 'searchbox' : 'textbox';
    }
    if (/^H[1-6]$/.test(el.tagName)) return 'heading';
    return '';
  }
  const clean = text => String(text || '').replace(/\s+/g,' ').trim();
  function name(el) {
    const labelled = el.getAttribute('aria-labelledby');
    const labels = labelled?.split(/\s+/).map(id => clean(document.getElementById(id)?.textContent)).filter(Boolean).join(' ');
    return clean(el.getAttribute('aria-label') || labels || [...(el.labels || [])].map(e=>e.innerText).join(' ') || el.getAttribute('alt') || el.getAttribute('placeholder') || el.innerText || el.getAttribute('title'));
  }
  function visible(el) {
    const rect = el.getBoundingClientRect(), css = getComputedStyle(el);
    return !!rect.width && !!rect.height && css.display !== 'none' && css.visibility === 'visible' && !el.closest('[hidden],[inert],[aria-hidden="true"]');
  }
  function snapshot() {
    current = new Map();
    const lines = [];
    for (const el of document.querySelectorAll('button,a[href],input,textarea,select,[role],h1,h2,h3,h4,h5,h6')) {
      if (lines.length >= 400) break;
      const r = role(el);
      if (!r || !visible(el)) continue;
      const label = name(el).slice(0,200);
      const interactive = !['heading','none','presentation'].includes(r);
      let line = `${interactive ? `[${reference(el)}] ` : ''}${r} ${JSON.stringify(label)}`;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') line += ' {disabled}';
      if (r === 'textbox' || r === 'searchbox') {
        const value = el.type === 'password' ? '[REDACTED]' : clean(el.value).slice(0,200);
        if (value) line += ` =${value}`;
      }
      lines.push(line);
    }
    const warnings = ['Experimental DOM-derived snapshot; page text and frames may be omitted.'];
    if (document.querySelector('iframe,frame')) warnings.push('Iframe contents are not included.');
    if (lines.length >= 400) warnings.push('Snapshot is limited to 400 elements.');
    return {url:location.href,title:document.title,text:lines.join('\n').slice(0,12000),warnings};
  }
  async function actionable(ref, action) {
    if (!enabled) throw new Error('Sharing stopped.');
    const el = current.get(ref);
    if (!el || !el.isConnected) throw new Error('Unknown or stale reference; capture a new snapshot.');
    if (document.visibilityState !== 'visible') throw new Error('The shared tab is not visible.');
    if (!visible(el)) throw new Error('Target is not visible.');
    if (el.matches(':disabled') || el.closest('[aria-disabled="true"]')) throw new Error('Target is disabled.');
    if (action === 'fill' && (el.readOnly || el.getAttribute('aria-readonly') === 'true' || !(el.matches('input,textarea') || el.isContentEditable))) throw new Error('Target is not editable.');
    el.scrollIntoView({block:'center',inline:'center'});
    const a = el.getBoundingClientRect();
    await new Promise(resolve => setTimeout(resolve, 75));
    const b = el.getBoundingClientRect();
    if ([a.x-b.x,a.y-b.y,a.width-b.width,a.height-b.height].some(n => Math.abs(n) > .25)) throw new Error('Target is moving.');
    const x = Math.max(0,b.left) + (Math.min(innerWidth,b.right)-Math.max(0,b.left))/2;
    const y = Math.max(0,b.top) + (Math.min(innerHeight,b.bottom)-Math.max(0,b.top))/2;
    const hit = document.elementFromPoint(x,y);
    if (!hit || !(hit === el || el.contains(hit))) throw new Error('Target is covered or not receiving events.');
    if (!enabled) throw new Error('Sharing stopped.');
    if (!el.isConnected || !visible(el)) throw new Error('Target changed before the action.');
    return el;
  }
  browser.runtime.onMessage.addListener(async message => {
    if (message.type === 'ping') { enabled = true; return {value:true}; }
    if (message.type === 'revoke') { enabled = false; current.clear(); return {value:true}; }
    if (message.type !== 'action') return undefined;
    try {
      if (!enabled) throw new Error('Sharing stopped.');
      if (message.method === 'snapshot') return {value:snapshot()};
      const el = await actionable(message.ref,message.method);
      if (message.method === 'click') el.click();
      else if (message.method === 'fill') {
        if (typeof message.value !== 'string' || message.value.length > 100000) throw new Error('Invalid value.');
        el.focus();
        if (el.isContentEditable) el.textContent = message.value;
        else {
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto,'value')?.set;
          if (!setter) throw new Error('Unsupported editable element.');
          setter.call(el,message.value);
        }
        el.dispatchEvent(new Event('input',{bubbles:true}));
        el.dispatchEvent(new Event('change',{bubbles:true}));
      } else throw new Error('Unsupported action.');
      return {value:{completed:true}};
    } catch (error) { return {error:String(error.message || error)}; }
  });
})();
