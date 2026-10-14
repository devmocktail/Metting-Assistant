// Assembles the live caption stream into the single string the ChatGPT composer
// should show: all finalized phrases ("committed") plus the phrase currently being
// recognized ("live"), so the box updates with the same immediacy as the Captions
// tab instead of only when a phrase finalizes. Pure + framework-free so it is unit
// tested in Node and reused in the renderer.
(function (global) {
  'use strict';

  function createFeedAssembler(opts) {
    const maxIds = (opts && opts.maxIds) || 2000;
    let committed = '';
    const appended = new Set();
    let liveId = null;
    let liveText = '';

    function commit(id, text) {
      if (!text || appended.has(id)) return;
      committed += (committed ? ' ' : '') + text;
      appended.add(id);
      if (appended.size > maxIds) appended.delete(appended.values().next().value);
    }

    function desired() {
      return committed + (liveText ? (committed ? ' ' : '') + liveText : '');
    }

    // event: { id, text, type: 'partial'|'final', revision }
    function update(event) {
      if (!event || !event.text) return desired();
      const { id, text, type, revision } = event;
      if (type === 'final') {
        if (!revision) commit(id, text);
        if (id === liveId) { liveId = null; liveText = ''; }
      } else {
        // A new phrase started before the previous one finalized: keep the old
        // one by committing its last partial so it is not lost.
        if (liveId !== null && liveId !== id && !appended.has(liveId) && liveText) {
          commit(liveId, liveText);
        }
        liveId = id;
        liveText = text;
      }
      return desired();
    }

    function reset() {
      committed = '';
      appended.clear();
      liveId = null;
      liveText = '';
    }

    return { update, desired, reset };
  }

  global.createFeedAssembler = createFeedAssembler;
  if (typeof module !== 'undefined' && module.exports) module.exports = { createFeedAssembler };
})(typeof window !== 'undefined' ? window : globalThis);
