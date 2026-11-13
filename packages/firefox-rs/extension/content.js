'use strict';
(() => {
  // executeScript may be invoked again when the person re-shares this tab.
  if (globalThis.__callistoTabBridge) return;
  globalThis.__callistoTabBridge = true;
  const nodeRefs = new WeakMap();
  let current = new Map();
  let enabled = true;
  let handoff = null;
  function finishHandoff(error) {
    if (!handoff) return;
    const pending=handoff; handoff=null;
    clearTimeout(pending.timer); pending.banner.remove();
    pending.resolve(error ? {error} : {value:{confirmed:true}});
  }
  const titlePrefix = '[Callisto] ';
  const hasTitleMarker = title => title === titlePrefix.trimEnd() || title.startsWith(titlePrefix);
  const withoutTitleMarker = title => title === titlePrefix.trimEnd() ? '' : title.startsWith(titlePrefix) ? title.slice(titlePrefix.length) : title;
  let marked = false;
  const titleObserver = new MutationObserver(() => {
    if (marked && !hasTitleMarker(document.title)) document.title = titlePrefix + document.title;
  });
  function mark() {
    marked = true;
    if (!hasTitleMarker(document.title)) document.title = titlePrefix + document.title;
    titleObserver.observe(document.head,{childList:true,subtree:true,characterData:true});
  }
  function unmark() {
    marked = false; titleObserver.disconnect();
    document.title = withoutTitleMarker(document.title);
  }
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
  function composedClosest(el,selector) {
    for(let node=el;node;node=node.parentElement||node.getRootNode()?.host)if(node.matches(selector))return node;
    return null;
  }
  function name(el) {
    const labelled = el.getAttribute('aria-labelledby');
    const labels = labelled?.split(/\s+/).map(id => clean(document.getElementById(id)?.textContent)).filter(Boolean).join(' ');
    return clean(el.getAttribute('aria-label') || labels || [...(el.labels || [])].map(e=>e.innerText).join(' ') || el.getAttribute('alt') || el.getAttribute('placeholder') || el.innerText || el.getAttribute('title') || (el.matches('input[type=submit],button[type=submit]') ? (el.value || 'Submit') : ''));
  }
  function visible(el) {
    const rect = el.getBoundingClientRect(), css = getComputedStyle(el);
    return !!rect.width && !!rect.height && css.display !== 'none' && css.visibility === 'visible' && !composedClosest(el,'[hidden],[inert],[aria-hidden="true"]');
  }
  function* elements(root, selector) {
    for (const el of root.querySelectorAll('*')) {
      if (el.matches(selector)) yield el;
      if (el.shadowRoot) yield* elements(el.shadowRoot, selector);
    }
  }
  function snapshot() {
    current = new Map();
    const lines = [];
    for (const el of elements(document, 'button,a[href],input,textarea,select,[role],h1,h2,h3,h4,h5,h6')) {
      if (lines.length >= 400) break;
      const r = role(el);
      if (!r || !visible(el)) continue;
      const label = name(el).slice(0,200);
      const interactive = !['heading','none','presentation'].includes(r);
      let line = `${interactive ? `[${reference(el)}] ` : ''}${r} ${JSON.stringify(label)}`;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') line += ' {disabled}';
      if (r === 'textbox' || r === 'searchbox' || (r === 'combobox' && el.matches('input,textarea'))) {
        const value = el.type === 'password' ? '[REDACTED]' : clean(el.value).slice(0,200);
        if (value) line += ` =${value}`;
      }
      lines.push(line);
    }
    const warnings = ['Experimental DOM-derived snapshot; page text and frames may be omitted.'];
    if (document.querySelector('iframe,frame')) warnings.push('Iframe contents are not included.');
    if (lines.length >= 400) warnings.push('Snapshot is limited to 400 elements.');
    return {url:location.href,title:withoutTitleMarker(document.title),text:lines.join('\n').slice(0,12000),warnings};
  }
  async function actionable(ref, action) {
    if (!enabled) throw new Error('Sharing stopped.');
    const el = current.get(ref);
    if (!el || !el.isConnected) throw new Error('Unknown or stale reference; capture a new snapshot.');
    if (document.visibilityState !== 'visible') throw new Error('The shared tab is not visible.');
    if (!visible(el)) throw new Error('Target is not visible.');
    if (el.matches(':disabled') || composedClosest(el,'[aria-disabled="true"]')) throw new Error('Target is disabled.');
    if (action === 'fill' && (el.readOnly || el.getAttribute('aria-readonly') === 'true' || !(el.matches('input,textarea') || el.isContentEditable))) throw new Error('Target is not editable.');
    el.scrollIntoView({block:'center',inline:'center'});
    const frames=[];let view=window;
    while(view!==view.top) {
      let host;try{host=view.frameElement;}catch{}
      if(!host)throw new Error('Cross-origin frame input is unsupported; parent hit testing cannot be verified.');
      const parent=host.ownerDocument.defaultView;
      for(let ancestor=host;ancestor;ancestor=ancestor.parentElement||ancestor.getRootNode()?.host){
        const css=parent.getComputedStyle(ancestor);
        if(css.transform!=='none' || (css.zoom && !['1','normal'].includes(css.zoom)))throw new Error('Transformed frame input is unsupported.');
      }
      frames.push({host,parent,rect:host.getBoundingClientRect()});view=parent;
    }
    const a = el.getBoundingClientRect();
    await new Promise(resolve => setTimeout(resolve, 75));
    const b = el.getBoundingClientRect();
    if ([a.x-b.x,a.y-b.y,a.width-b.width,a.height-b.height].some(n => Math.abs(n) > .25)) throw new Error('Target is moving.');
    const x = Math.max(0,b.left) + (Math.min(innerWidth,b.right)-Math.max(0,b.left))/2;
    const y = Math.max(0,b.top) + (Math.min(innerHeight,b.bottom)-Math.max(0,b.top))/2;
    let hit = document.elementFromPoint(x,y);
    while (hit?.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x,y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    if (!hit || !(hit === el || el.contains(hit))) throw new Error('Target is covered or not receiving events.');
    let px=x,py=y;
    for(const {host,parent,rect} of frames) {
      const now=host.getBoundingClientRect();
      if(!host.isConnected || ['x','y','width','height'].some(key=>Math.abs(now[key]-rect[key])>.25))throw new Error('Frame is moving or detached.');
      px+=now.left+host.clientLeft;py+=now.top+host.clientTop;
      let covering=parent.document.elementFromPoint(px,py);
      while(covering?.shadowRoot){const inner=covering.shadowRoot.elementFromPoint(px,py);if(!inner || inner===covering)break;covering=inner;}
      if(covering!==host)throw new Error('Frame is covered or outside the parent viewport.');
    }
    if (!enabled) throw new Error('Sharing stopped.');
    if (!el.isConnected || !visible(el)) throw new Error('Target changed before the action.');
    return el;
  }
  // Structured extraction. Keep behaviour identical to extract.ts in the
  // Chromium backend; both are covered by the shared contract tests.
  function extractPage(spec) {
    if (!spec || typeof spec.selector !== 'string' || !spec.selector || spec.selector.length > 500) throw new Error('A row selector (1-500 characters) is required.');
    const entries = Object.entries(spec.fields || {});
    if (!entries.length || entries.length > 20) throw new Error('Provide 1-20 fields.');
    const cleanText = value => String(value ?? '').replace(/\s+/g, ' ').trim();
    let rows = [];
    try { rows = Array.from(document.querySelectorAll(spec.selector)); }
    catch { throw new Error('Invalid row selector.'); }
    const limit = Number.isInteger(spec.limit) ? Math.max(1, Math.min(spec.limit, 1000)) : 500;
    const out = [];
    for (const row of rows.slice(0, limit)) {
      const item = {};
      for (const [name, rawField] of entries) {
        if (typeof name !== 'string' || !name || name.length > 50) throw new Error('Invalid field name.');
        const field = typeof rawField === 'string' ? {selector: rawField} : rawField;
        if (!field || typeof field !== 'object') throw new Error('Invalid field specification.');
        let element = row;
        if (field.selector !== undefined) {
          if (typeof field.selector !== 'string' || !field.selector || field.selector.length > 500) throw new Error('Invalid field selector.');
          try { element = row.querySelector(field.selector); } catch { throw new Error('Invalid field selector.'); }
        }
        if (!element) { item[name] = null; continue; }
        const raw = field.attribute ? element.getAttribute(field.attribute) : element.textContent;
        const text = cleanText(raw);
        if (field.type === 'number') {
          const normalized = text.replace(/[^0-9.eE+-]/g, '');
          const number = normalized === '' ? NaN : Number(normalized);
          item[name] = Number.isFinite(number) ? number : null;
        } else item[name] = text.slice(0, 300);
      }
      if (spec.include_text) item._text = cleanText(row.innerText).slice(0, 500);
      out.push(item);
    }
    let has_next = false;
    if (spec.paginate) {
      let next = null;
      try { next = document.querySelector(spec.paginate.next); } catch { throw new Error('Invalid next-page selector.'); }
      const disabled = !next || next.hasAttribute('disabled') || next.getAttribute('aria-disabled') === 'true' || next.classList.contains('disabled');
      has_next = !disabled && (next.tagName !== 'A' || Boolean(next.getAttribute('href')));
    }
    return {rows: out, has_next};
  }
  browser.runtime.onMessage.addListener(async function handle(message) {
    if (message.type === 'ping') { enabled = true; mark(); return {value:true}; }
    if (message.type === 'revoke') { enabled = false; finishHandoff('Sharing stopped during human handoff.'); current.clear(); unmark(); return {value:true}; }
    if (message.type === 'handoff') {
      if (!enabled || handoff) return {error:'Sharing stopped or a handoff is already pending.'};
      if (typeof message.prompt!=='string' || !message.prompt.trim() || message.prompt.length>1000 || !Number.isInteger(message.timeout_ms) || message.timeout_ms<1000 || message.timeout_ms>120000) return {error:'Invalid handoff prompt or timeout.'};
      return new Promise(resolve=>{
        const banner=document.createElement('div');
        banner.setAttribute('data-callisto-handoff','');
        banner.setAttribute('role','status');
        banner.style.cssText='position:fixed;top:12px;right:12px;z-index:2147483647;max-width:360px;padding:16px;background:#102333;color:white;border:2px solid #55aaff;border-radius:8px;font:14px system-ui;box-shadow:0 4px 24px #0008';
        const title=document.createElement('strong'); title.textContent='Callisto needs your help';
        const prompt=document.createElement('p'); prompt.textContent=message.prompt;
        const button=document.createElement('button');button.textContent='Continue with agent';
        button.addEventListener('click',event=>{if(event.isTrusted)finishHandoff();});
        banner.append(title,prompt,button);document.documentElement.append(banner);
        handoff={banner,resolve,timer:setTimeout(()=>finishHandoff('Human handoff timed out; inspect the page before continuing.'),message.timeout_ms)};
      });
    }
    if (message.type !== 'action') return undefined;
    try {
      if (!enabled) throw new Error('Sharing stopped.');
      if (handoff && message.method !== 'snapshot') throw new Error('Human handoff is pending; wait for confirmation.');
      if (message.method === 'snapshot') return {value:snapshot()};
      if (message.method === 'page') {
        const args = JSON.parse(message.value);
        if (args.action === 'press') {
          if(typeof args.key!=='string' || args.key.length>40)throw new Error('Invalid key.');
          const parts=args.key.split('+'),key=parts.pop();
          const modifiers={Control:'ctrlKey',Alt:'altKey',Shift:'shiftKey',Meta:'metaKey'};
          if(!key || parts.some(part=>!modifiers[part]))throw new Error('Unsupported key chord.');
          let focused=document.activeElement;
          while(focused?.shadowRoot?.activeElement)focused=focused.shadowRoot.activeElement;
          if(!focused || focused===document.body)throw new Error('Focus a control with fill or click before pressing a key.');
          const target=await actionable(reference(focused),'press');
          const options={key,bubbles:true,cancelable:true,composed:true};
          for(const part of parts)options[modifiers[part]]=true;
          target.dispatchEvent(new KeyboardEvent('keydown',options));
          target.dispatchEvent(new KeyboardEvent('keyup',options));
          return {value:{completed:true,synthetic:true,defaultBrowserBehavior:false}};
        }
        if (args.action === 'text' || args.action === 'find') {
          const text = document.body.innerText;
          if (args.action === 'text') return {value:{text:text.slice(0,30000),totalChars:text.length,truncated:text.length>30000}};
          if (typeof args.query !== 'string' || !args.query || args.query.length>200) throw new Error('query is required (1–200 characters).');
          const matches = []; let offset = 0;
          while (matches.length < 10) {
            const index = text.toLowerCase().indexOf(args.query.toLowerCase(),offset);
            if (index < 0) break;
            matches.push({offset:index,text:text.slice(Math.max(0,index-120),index+args.query.length+120)});
            offset = index + args.query.length;
          }
          return {value:{matches}};
        }
        if (args.action === 'extract') return {value: extractPage(args.spec)};
        if (args.action === 'click_next') {
          if (typeof args.selector !== 'string' || !args.selector || args.selector.length > 500) throw new Error('A next-page selector is required.');
          let next;
          try { next = document.querySelector(args.selector); } catch { throw new Error('Invalid next-page selector.'); }
          if (!next) throw new Error('No next-page control matched the selector.');
          if (next.hasAttribute('disabled') || next.getAttribute('aria-disabled') === 'true' || next.classList.contains('disabled')) throw new Error('The next-page control is disabled.');
          next.scrollIntoView({block:'center'});
          next.click();
          return {value:{clicked:true}};
        }
        if (args.action === 'scroll') {
          const x = args.delta_x ?? 0, y = args.delta_y ?? 0;
          if (![x,y].every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n)<=100000)) throw new Error('Invalid scroll deltas.');
          window.scrollBy({left:x,top:y,behavior:'instant'}); return {value:{completed:true}};
        }
        if (['fill','click','submit'].includes(args.action)) {
          let target = args.ref;
          if (!target) {
            if (typeof args.role !== 'string' || typeof args.name !== 'string') throw new Error('ref or exact role and name are required.');
            const deadline=Date.now()+2000;
            while (!target) {
              if(!enabled)throw new Error('Sharing stopped.');
              const matches=[...elements(document,'button,a[href],input,textarea,select,[role]')].filter(el=>visible(el) && role(el)===args.role && name(el)===args.name);
              if(matches.length>1)throw new Error('Role locator must match exactly one visible element.');
              if(matches.length===1){target=reference(matches[0]);break;}
              if(Date.now()>=deadline)throw new Error('No visible element matched the exact role and name within 2 seconds.');
              await new Promise(resolve=>setTimeout(resolve,25));
            }
          }
          return handle({type:'action',method:args.action,ref:target,value:args.value});
        }
        const el = await actionable(args.ref,args.action);
        if (args.action === 'upload') {
          if (!el.matches('input[type=file]') || !Array.isArray(args.files) || !args.files.length || args.files.length>10) throw new Error('Expected file input and 1–10 files.');
          if (!el.multiple && args.files.length>1) throw new Error('This input accepts only one file.');
          const transfer = new DataTransfer(); let total=0;
          for (const file of args.files) {
            if (typeof file.name!=='string' || typeof file.data!=='string' || file.data.length>14000000) throw new Error('Invalid file.');
            const bytes=Uint8Array.from(atob(file.data),c=>c.charCodeAt(0)); total+=bytes.length;
            if(total>10*1024*1024)throw new Error('Uploads exceed 10 MiB.');
            transfer.items.add(new File([bytes],file.name,{type:'application/octet-stream'}));
          }
          el.files=transfer.files;
          el.dispatchEvent(new Event('input',{bubbles:true,composed:true}));
          el.dispatchEvent(new Event('change',{bubbles:true}));
        } else if (args.action === 'hover') {
          const r = el.getBoundingClientRect(), options = {bubbles:true,clientX:r.x+r.width/2,clientY:r.y+r.height/2};
          for (const type of ['pointerover','pointerenter','pointermove']) el.dispatchEvent(new PointerEvent(type,options));
          for (const type of ['mouseover','mouseenter','mousemove']) el.dispatchEvent(new MouseEvent(type,options));
        } else if (args.action === 'select') {
          if (!(el instanceof HTMLSelectElement) || ![...el.options].some(o=>o.value===args.value && !o.disabled)) throw new Error('No enabled option with that value.');
          el.value=args.value; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
        } else if (args.action === 'check') {
          if (!el.matches('input[type=checkbox]') || typeof args.checked !== 'boolean') throw new Error('Expected a checkbox and checked boolean.');
          if (el.checked !== args.checked) el.click();
          if (el.checked !== args.checked) throw new Error('The checkbox did not retain the requested state.');
        } else throw new Error('Unsupported page action.');
        return {value:{completed:true,synthetic:true}};
      }
      const el = await actionable(message.ref,message.method);
      if (message.method === 'submit') {
        const form = el.form;
        if (!(form instanceof HTMLFormElement)) throw new Error('Target is not associated with a form.');
        if (!HTMLFormElement.prototype.checkValidity.call(form)) throw new Error('Form validation failed; complete the required fields before submitting.');
        const submitter = el.matches('button[type=submit],input[type=submit],input[type=image]') ? el : [...form.elements].find(node=>node.matches('button[type=submit],button:not([type]),input[type=submit]') && !node.disabled);
        HTMLFormElement.prototype.requestSubmit.call(form,submitter);
      } else if (message.method === 'click') el.click();
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
