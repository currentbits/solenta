// Run from the repo root: node work/check-thread-concept.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const html = fs.readFileSync(require('node:path').join(__dirname, 'solenta-thread-concept.html'), 'utf8');
let animations = 0;
const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  beforeParse(window) {
    window.matchMedia = () => ({ matches: false });
    window.Element.prototype.animate = () => { animations++; };
  },
});
const { document } = dom.window;
const q = (selector) => document.querySelector(selector);
assert(q('#st-workers').hidden);
q('#st-disclose').click();
assert(!q('#st-workers').hidden);
assert.equal(q('#st-disclose').getAttribute('aria-expanded'), 'true');
assert.equal(animations, 0, 'keyboard-style clicks stay immediate');
q('#st-roster-toggle').click();
assert(!q('#st-roster').hidden);
q('[data-open="lifecycle"]').click();
assert.equal(q('#st-title').textContent, 'Worker lifecycle');
assert.match(q('#st-subtitle').textContent, /Needs input/);
q('#st-finish').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, detail: 1 }));
assert.equal(animations, 1);
assert.equal(q('#st-summary').textContent, '2 ready · 1 needs you');
assert.equal(q('#st-roster-motion').textContent, 'Ready for review');
assert.equal(q('.st-completed summary').textContent, 'Completed (1)', 'finishing does not integrate work');
q('[data-open="motion"]').click();
assert.match(q('#st-copy').textContent, /Verification is pending/);
dom.window.matchMedia = () => ({ matches: true });
q('#st-finish').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, detail: 1 }));
assert.equal(animations, 1, 'reduced motion skips animation');
q('[data-open="root"]').click();
assert.equal(q('#st-breadcrumb').textContent, 'Overview');
const ids = [...document.querySelectorAll('[id]')].map(el => el.id);
assert.equal(new Set(ids).size, ids.length);
for (const el of document.querySelectorAll('[aria-controls]')) assert(document.getElementById(el.getAttribute('aria-controls')));
dom.window.close();
console.log('Concept checks passed: disclosure, navigation, completion, motion, reduced motion, ARIA targets.');
