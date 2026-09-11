// SPDX-License-Identifier: GPL-3.0-or-later
// providers/oxalpha-net.js - Ox Alpha network tap (runs in the MAIN world).
//
// WHY: Ox Alpha renders assistant replies via marked.js + highlight.js into
// .prose. The DOM textContent is post-markdown, post-highlight, and the site
// re-renders it on stream updates. A command's JSON can be momentarily partial
// or highlighted into spans, which the DOM read can see as truncated ("{" with
// no close). The streamed API response at /api/chat carries the raw markdown
// verbatim (choices[0].delta.content). This tap captures it and republishes it
// so providers/oxalpha.js can read commands from the authoritative source.
(() => {
  "use strict";
  if (window.__zsOxAlphaNet) return;
  window.__zsOxAlphaNet = true;

  const NODE_ID = "zs-oxalpha-net";
  const node = () => {
    let n = document.getElementById(NODE_ID);
    if (!n) {
      n = document.createElement("script");
      n.type = "application/json";
      n.id = NODE_ID;
      (document.body || document.documentElement).appendChild(n);
    }
    return n;
  };
  const publish = (obj) => { try { node().textContent = JSON.stringify(obj); } catch {} };

  let ridSeq = 0;

  async function consume(resp) {
    let reader;
    try { reader = resp.body.getReader(); } catch { return; }
    const dec = new TextDecoder();
    let buf = "";
    const acc = { rid: ++ridSeq, text: "", done: false };
    publish({ rid: acc.rid, text: acc.text, done: acc.done, t: Date.now() });
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          const s = line.trim();
          if (!s) continue;
          if (s.startsWith("event:")) continue;
          if (s.startsWith("data:")) {
            const js = s.slice(5).trim();
            if (!js || js === "[DONE]") { acc.done = true; continue; }
            let o;
            try { o = JSON.parse(js); } catch { continue; }
            // Ox Alpha: o.choices[0].delta.content is incremental token
            const d = o.choices && o.choices[0] && o.choices[0].delta;
            if (d && typeof d.content === "string") {
              acc.text += d.content;
            } else if (typeof o.content === "string") {
              // fallback for alternative shape
              acc.text += o.content;
            }
          }
        }
        publish({ rid: acc.rid, text: acc.text, done: acc.done, t: Date.now() });
      }
      if (buf.trim().startsWith("data:")) {
        const js = buf.trim().slice(5).trim();
        if (js && js !== "[DONE]") {
          try {
            const o = JSON.parse(js);
            const d = o.choices && o.choices[0] && o.choices[0].delta;
            if (d && typeof d.content === "string") acc.text += d.content;
          } catch {}
        }
      }
    } catch {}
    acc.done = true;
    publish({ rid: acc.rid, text: acc.text, done: acc.done, t: Date.now() });
  }

  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const url = (args[0] && args[0].url) || args[0];
    const p = origFetch.apply(this, args);
    try {
      if (typeof url === "string" && /\/api\/chat/.test(url)) {
        p.then((res) => {
          try { if (res && res.body) consume(res.clone()); } catch {}
        }).catch(()=>{});
      }
    } catch {}
    return p;
  };

  // Also hook XMLHttpRequest if the app ever uses it (defensive)
  try {
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      this._zsUrl = url;
      return origOpen.apply(this, arguments);
    };
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
      if (this._zsUrl && /\/api\/chat/.test(this._zsUrl)) {
        // XHR streaming for Ox Alpha is not expected (fetch is used), skip.
      }
      return origSend.apply(this, arguments);
    };
  } catch {}
})();
