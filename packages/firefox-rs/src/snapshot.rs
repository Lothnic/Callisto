// DOM-derived accessibility snapshot.
//
// WebDriver BiDi has no accessibility-tree module, so the tree is built by
// walking the DOM in the page. The shape deliberately mirrors Chromium's
// accessibility tree closely enough that the existing pruning, ref allocation
// and formatting rules apply unchanged.
use anyhow::{anyhow, Result};
use serde::Deserialize;

pub const SNAPSHOT_JS: &str = r#"(() => {
  const KEY = "__callisto";
  const st = globalThis[KEY] || (globalThis[KEY] = { ids: new WeakMap(), next: 1, byId: new Map() });
  st.byId = new Map();
  const out = [];
  const warnings = [];
  const skip = new Set(["SCRIPT","STYLE","HEAD","META","LINK","TITLE","TEMPLATE","NOSCRIPT","BR"]);
  const interactive = new Set(["button","link","textbox","searchbox","checkbox","radio","combobox","listbox","option","menuitem","menuitemcheckbox","menuitemradio","tab","switch","slider","spinbutton","scrollbar","dialog","alertdialog"]);
  const clickable = new Set(["button","link","checkbox","radio","tab","menuitem","menuitemcheckbox","menuitemradio","option","switch","combobox","textbox","searchbox","slider","spinbutton"]);
  const idOf = (el) => {
    let id = st.ids.get(el);
    if (id === undefined) { id = st.next++; st.ids.set(el, id); }
    st.byId.set(id, el);
    return id;
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute && el.getAttribute("role");
    if (explicit) { const first = explicit.trim().split(/\s+/)[0]; if (first) return first; }
    const tag = el.tagName;
    const type = (el.getAttribute("type") || "").toLowerCase();
    switch (tag) {
      case "A": return el.hasAttribute("href") ? "link" : "generic";
      case "BUTTON": return "button";
      case "INPUT":
        if (type === "hidden") return "none";
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "range") return "slider";
        if (type === "number") return "spinbutton";
        if (type === "search") return "searchbox";
        if (type === "submit" || type === "button" || type === "reset" || type === "image") return "button";
        return "textbox";
      case "TEXTAREA": return "textbox";
      case "SELECT": return el.multiple ? "listbox" : "combobox";
      case "OPTION": return "option";
      case "H1": case "H2": case "H3": case "H4": case "H5": case "H6": return "heading";
      case "IMG": return "img";
      case "UL": case "OL": return "list";
      case "LI": return "listitem";
      case "TABLE": return "table";
      case "THEAD": case "TBODY": case "TFOOT": return "rowgroup";
      case "TR": return "row";
      case "TD": return "cell";
      case "TH": return "columnheader";
      case "NAV": return "navigation";
      case "MAIN": return "main";
      case "HEADER": return "banner";
      case "FOOTER": return "contentinfo";
      case "ASIDE": return "complementary";
      case "FORM": return "form";
      case "DIALOG": return "dialog";
      case "FIGURE": return "figure";
      case "BLOCKQUOTE": return "blockquote";
      case "P": return "paragraph";
      default: return "generic";
    }
  };
  const textOf = (el) => (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  const labelsOf = (el) => {
    try { if (el.labels && el.labels.length) return Array.from(el.labels).map(textOf).join(" ").trim(); } catch (e) {}
    return "";
  };
  const nameOf = (el, role) => {
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const parts = labelledby.split(/\s+/).map((id) => {
        const ref = el.ownerDocument.getElementById(id);
        return ref ? textOf(ref) : "";
      }).filter(Boolean);
      if (parts.length) return parts.join(" ");
    }
    if (el.tagName === "IMG" || el.tagName === "AREA") {
      const alt = el.getAttribute("alt");
      if (alt && alt.trim()) return alt.trim();
    }
    if (el.tagName === "INPUT") {
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (type === "submit" || type === "button" || type === "reset") return (el.value || "").trim();
      if (type === "image") return (el.getAttribute("alt") || "").trim();
      const labels = labelsOf(el);
      if (labels) return labels;
      if (el.getAttribute("placeholder")) return el.getAttribute("placeholder").trim();
    }
    if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
      const labels = labelsOf(el);
      if (labels) return labels;
    }
    if (interactive.has(role) || role === "heading" || role === "cell" || role === "columnheader" || role === "rowheader") {
      const text = textOf(el);
      if (text) return text;
    }
    const title = el.getAttribute("title");
    if (title && title.trim()) return title.trim();
    return "";
  };
  const valueOf = (el, role) => {
    if (role === "textbox" || role === "searchbox" || role === "spinbutton") {
      if ((el.getAttribute("type") || "").toLowerCase() === "password") return "[REDACTED]";
      return el.value == null ? "" : String(el.value);
    }
    if (role === "combobox" || role === "listbox") {
      try { return Array.from(el.selectedOptions || []).map((o) => textOf(o)).join(", "); } catch (e) { return ""; }
    }
    if (role === "slider") return el.value == null ? "" : String(el.value);
    return "";
  };
  const stateOf = (el, role) => {
    const s = [];
    if (el.disabled === true || el.getAttribute("aria-disabled") === "true") s.push("disabled");
    if (el.checked === true || el.getAttribute("aria-checked") === "true") s.push("checked");
    if (el.getAttribute("aria-checked") === "mixed") s.push("mixed");
    if (el.getAttribute("aria-expanded") === "true") s.push("expanded");
    if (el.getAttribute("aria-selected") === "true" || (el.tagName === "OPTION" && el.selected)) s.push("selected");
    if (el.required === true || el.getAttribute("aria-required") === "true") s.push("required");
    if (el.readOnly === true || el.getAttribute("aria-readonly") === "true") s.push("readonly");
    if (el.ownerDocument.activeElement === el) s.push("focused");
    if (el.getAttribute("aria-pressed") === "true") s.push("pressed");
    if (el.getAttribute("aria-invalid") === "true") s.push("invalid");
    if (clickable.has(role)) s.push("clickable");
    return s;
  };
  const hidden = (el) => {
    if (el.hasAttribute("hidden")) return true;
    const cs = getComputedStyle(el);
    return cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse";
  };
  const push = (node) => { const index = out.length; out.push(node); return index; };
  const walk = (node, parent, frameId) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.nodeValue || "").replace(/\s+/g, " ").trim();
      if (!text) return;
      push({ id: -1, role: "StaticText", name: text, description: "", value: "", state: [], parent, frameId });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node;
    const tag = el.tagName;
    if (skip.has(tag)) return;
    if (hidden(el)) return;
    if (tag === "IFRAME" || tag === "FRAME") {
      let doc = null;
      try { doc = el.contentDocument; } catch (e) { doc = null; }
      if (!doc) { warnings.push("cross-origin iframe omitted"); return; }
      const childFrame = frameId + "/" + out.length;
      const body = doc.body || doc.documentElement;
      if (body) for (const child of body.childNodes) walk(child, parent, childFrame);
      return;
    }
    const role = roleOf(el);
    if (role === "none" || role === "presentation") {
      for (const child of el.childNodes) walk(child, parent, frameId);
      return;
    }
    const id = idOf(el);
    const state = stateOf(el, role);
    if (el.getAttribute("aria-hidden") === "true") state.push("ignored");
    const index = push({
      id, role,
      name: nameOf(el, role),
      description: el.getAttribute("aria-description") || "",
      value: valueOf(el, role),
      state,
      parent,
      frameId
    });
    for (const child of el.childNodes) walk(child, index, frameId);
  };
  const root = push({ id: -1, role: "RootWebArea", name: document.title || "", description: "", value: "", state: [], parent: -1, frameId: "main" });
  const rootEl = document.body || document.documentElement;
  if (rootEl) for (const child of rootEl.childNodes) walk(child, root, "main");
  return JSON.stringify({ url: location.href, title: document.title || "", nodes: out, warnings });
})()"#;

/// Resolve a ref to viewport coordinates after checking actionability.
/// Returns a JSON string so the result crosses BiDi as a primitive.
pub const ACTIONABLE_JS: &str = r#"function(id, action) {
  const st = globalThis.__callisto;
  const el = st && st.byId.get(id);
  if (!el) return JSON.stringify({ reason: "detached" });
  if (!el.isConnected) return JSON.stringify({ reason: "detached" });
  el.scrollIntoView({ block: "center", inline: "center" });
  const style = getComputedStyle(el), r = el.getBoundingClientRect();
  if (!r.width || !r.height || style.visibility !== "visible" || style.display === "none") return JSON.stringify({ reason: "not visible" });
  if (el.closest("[inert]")) return JSON.stringify({ reason: "inert" });
  if (action !== "hover" && (el.matches(":disabled") || el.closest('[aria-disabled="true"]'))) return JSON.stringify({ reason: "disabled" });
  if (action === "fill" && (el.matches("[readonly]") || el.getAttribute("aria-readonly") === "true" || !(el.matches("input,textarea") || el.isContentEditable))) return JSON.stringify({ reason: "not editable" });
  let view = el.ownerDocument.defaultView;
  // Zen headless reports innerWidth/innerHeight as 0 even though layout has a
  // size. Fall back to the document's client box, then to the element's own
  // edge, so the click still lands in the middle of the target.
  // A tab whose window was never rendered (Zen opens extra command-line URLs
  // in an unmapped window) has no layout viewport at all. Input cannot land
  // there, so report it instead of pretending the target is covered.
  if (!view.innerWidth && !view.document.documentElement.clientWidth) return JSON.stringify({ reason: "tab has no layout viewport" });
  const vw = view.innerWidth || view.document.documentElement.clientWidth || r.right;
  const vh = view.innerHeight || view.document.documentElement.clientHeight || r.bottom;
  let x = Math.max(0, r.left) + (Math.min(vw, r.right) - Math.max(0, r.left)) / 2;
  let y = Math.max(0, r.top) + (Math.min(vh, r.bottom) - Math.max(0, r.top)) / 2;
  const root = el.getRootNode();
  const hit = root.elementFromPoint ? root.elementFromPoint(x, y) : el.ownerDocument.elementFromPoint(x, y);
  if (!hit || !(el === hit || el.contains(hit))) return JSON.stringify({ reason: "covered or not receiving events", x, y, vw, vh, rect: [r.left, r.top, r.width, r.height], hit: hit ? hit.tagName : null, hitClass: hit ? String(hit.className) : null, vis: el.ownerDocument.visibilityState, inner: [view.innerWidth, view.innerHeight], client: [el.ownerDocument.documentElement.clientWidth, el.ownerDocument.documentElement.clientHeight], focus: el.ownerDocument.hasFocus() });
  while (view !== view.top) {
    let frame;
    try { frame = view.frameElement; } catch (e) { return JSON.stringify({ reason: "cross-origin iframe actionability unsupported" }); }
    if (!frame) return JSON.stringify({ reason: "cross-origin iframe actionability unsupported" });
    const fr = frame.getBoundingClientRect();
    if (Math.abs(fr.width - frame.offsetWidth) > 0.5 || Math.abs(fr.height - frame.offsetHeight) > 0.5 || getComputedStyle(frame).transform !== "none") return JSON.stringify({ reason: "transformed iframe actionability unsupported" });
    x += fr.left + frame.clientLeft;
    y += fr.top + frame.clientTop;
    const parent = frame.ownerDocument.defaultView;
    const parentHit = frame.ownerDocument.elementFromPoint(x, y);
    if (parentHit !== frame) return JSON.stringify({ reason: "iframe covered or not receiving events" });
    view = parent;
  }
  return JSON.stringify({ x, y, rect: [x, y, r.width, r.height] });
}"#;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawNode {
    pub id: i64,
    pub role: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub value: String,
    #[serde(default)]
    pub state: Vec<String>,
    pub parent: i64,
    #[serde(default)]
    pub frame_id: String,
}

#[derive(Debug, Deserialize)]
pub struct RawSnapshot {
    pub url: String,
    pub title: String,
    pub nodes: Vec<RawNode>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct Snapshot {
    pub url: String,
    pub title: String,
    pub text: String,
    pub warnings: Vec<String>,
}

pub fn parse(raw: &str) -> Result<RawSnapshot> {
    serde_json::from_str(raw).map_err(|error| anyhow!("could not parse page snapshot: {error}"))
}
