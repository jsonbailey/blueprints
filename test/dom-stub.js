"use strict";
/* A minimal, hand-rolled DOM/SVG stub — not a real DOM (no layout, no CSS,
   no real querySelector matching, no visual rendering). It exists so the
   app's plain <script>-tag files (written for a real browser, with no
   module system) can be *loaded and executed* in Node without throwing, and
   so pure-logic functions (geometry, data model, persistence) can be
   exercised with real assertions.

   What this catches: syntax errors, wrong script load order, a reference to
   something that doesn't exist yet, wrong logic in a pure function.
   What this does NOT catch: rendering correctness, layout/CSS, real pointer-
   event/focus quirks, cross-browser behavior, anything visual. Don't treat a
   passing test run here as "verified in a browser" — it isn't. */

function makeElement(tag) {
  const el = {
    tagName: (tag || "DIV").toUpperCase(),
    style: {},
    classList: {
      _set: new Set(),
      add(...cls) { cls.forEach(c => this._set.add(c)); },
      remove(...cls) { cls.forEach(c => this._set.delete(c)); },
      contains(c) { return this._set.has(c); },
      toggle(c, force) {
        const has = this._set.has(c);
        const on = force === undefined ? !has : force;
        if (on) this._set.add(c); else this._set.delete(c);
        return on;
      },
    },
    dataset: {},
    attributes: {},
    children: [],
    parentNode: null,
    _listeners: {},
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { this.children = this.children.filter(x => x !== c); return c; },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; },
    removeAttribute(k) { delete this.attributes[k]; },
    addEventListener(type, fn, opts) {
      (this._listeners[type] = this._listeners[type] || []).push({ fn, opts });
    },
    removeEventListener(type, fn) {
      if (!this._listeners[type]) return;
      this._listeners[type] = this._listeners[type].filter(l => l.fn !== fn);
    },
    dispatchEvent(evt) {
      (this._listeners[evt.type] || []).forEach(l => l.fn(evt));
      return true;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    contains() { return false; },
    focus() { this._focused = true; },
    blur() { this._focused = false; },
    select() {},
    click() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }; },
    setPointerCapture() {},
    releasePointerCapture() {},
    get innerHTML() { return this._html || ""; },
    set innerHTML(v) { this._html = v; this.children = []; },
    get textContent() {
      if (this._text !== undefined) return this._text;
      return this.children.map(c => c.textContent || "").join("");
    },
    set textContent(v) { this._text = v; this.children = []; },
    get value() { return this._value || ""; },
    set value(v) { this._value = v; },
    get hidden() { return !!this._hidden; },
    set hidden(v) { this._hidden = v; },
    get contentEditable() { return this._contentEditable || "inherit"; },
    set contentEditable(v) { this._contentEditable = v; },
    get isContentEditable() { return this._contentEditable === "true" || this._contentEditable === true; },
  };
  return el;
}

/* Build a fresh {document, window} pair. `byId` lets a test pre-register
   specific named elements (e.g. the #plan svg) that code under test expects
   to find by id; anything not pre-registered is created on demand and
   cached, so repeated getElementById(id) calls return the same node. */
function createDomStub() {
  const registry = new Map();
  const svgEl = makeElement("svg");
  svgEl.clientWidth = 800;
  svgEl.clientHeight = 600;
  registry.set("plan", svgEl);

  const document = {
    _registry: registry,
    getElementById(id) {
      if (!registry.has(id)) registry.set(id, makeElement("div"));
      return registry.get(id);
    },
    createElement(tag) { return makeElement(tag); },
    createElementNS(_ns, tag) { return makeElement(tag); },
    createRange() { return { selectNodeContents() {} }; },
    addEventListener() {},
    removeEventListener() {},
    querySelectorAll() { return []; },
    body: makeElement("body"),
  };

  const window = {
    addEventListener() {},
    removeEventListener() {},
    devicePixelRatio: 1,
    getSelection() { return { removeAllRanges() {}, addRange() {} }; },
  };

  return { document, window, svgEl, makeElement };
}

module.exports = { createDomStub, makeElement };
