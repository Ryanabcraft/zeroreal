// SPDX-License-Identifier: GPL-3.0-or-later
// providers/oxalpha.js - the Ox Alpha (oxalpha.com/chat) provider.
// Exports the same ZSProvider interface as providers/deepseek.js; the core
// (core/main.js) is provider-agnostic. To DISABLE Ox Alpha support, remove this
// file from manifest.json (and its URL from background.js PROVIDER_URLS).
//
// Ox Alpha DOM notes (validated from live fetch 2026-08, /chat):
//  - Chat list is `.messages-wrap > .messages-col > .msg` with modifiers
//    `.msg-user` and `.msg-assistant`. User bubble = `.msg-user .msg-bubble`
//    (pre-wrap), assistant body = `.msg-assistant .prose` (marked.js -> HTML,
//    code = `pre>code` + .code-block-header). Text rendered via React div.prose
//    with dangerouslySetInnerHTML (marked.parse -> DOMPurify -> hljs.highlightElement).
//  - Composer: two variants - `.empty-input-box` (empty state) and `.input-box`
//    (normal, inside `.input-area > .input-col`). Both hold a real <textarea>.
//    Send = `.send-btn`, stop = `.stop-btn` (swap). Typing = `.typing-dots`.
//  - Phase signal: `window.__oxPhase` = idle|connecting|queued|thinking|answering|verifying
//    plus network tap `providers/oxalpha-net.js` (MAIN world) which captures
//    the raw /api/chat SSE `choices[0].delta.content` verbatim into #zs-oxalpha-net.
//    That tap is authoritative for command JSON - DOM post-markdown can truncate.
//  - Images: up to 2 per message (window.__CHAT_IMAGES__.max=2, 5MB). Pending
//    strip = `.ox-attach-strip` inside `.input-box` with `<img src="data:...">`.
//  - Conversation: URL stays `/chat`; id via `window.__oxActiveChatId()` (sidebar
//    active -> localStorage chattest_chats). Fresh chat has no id.
//
// eslint-disable-next-line no-unused-vars
const ZSProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let diag = () => {};

  const S = {
    anyItem: ".msg",
    userItem: ".msg-user",
    assistantItem: ".msg-assistant",
    prose: ".prose",
    msgContent: ".msg-content",
    editor: ".input-box textarea, .empty-input-box textarea",
    composerArea: ".input-area",
    composerCol: ".input-col",
    composerBox: ".input-box, .empty-input-box",
    sendBtn: ".send-btn",
    stopBtn: ".stop-btn",
    typing: ".typing-dots",
    codeWrap: "pre",
    codeHeader: ".code-block-header",
    errorSurfaces: '.msg-error, [role="alert"], [class*="toast"], [class*="error"], [class*="alert"]',
    attachStrip: ".ox-attach-strip",
    attachInput: '.ox-attach input[type="file"]',
    attachImg: ".ox-attach-strip img",
  };

  const RE = {
    contextLimit: new RegExp(
      [
        "conversation.{0,20}(too long|trop long)",
        "context.{0,20}(limit|exceeded|d\\u00e9pass\\u00e9)",
        "please.{0,30}(start|cr\\u00e9er).{0,20}(new|nouveau).{0,20}(chat|conversation)",
        "(token|context).{0,10}limit",
        "maximum.{0,20}context",
        "this conversation has reached",
      ].join("|"),
      "i"
    ),
    tooLong: /conversation .{0,20}(too long|getting too long|trop longue)/i,
    busy: /server is busy|serveur est occup|please try again|réessayer plus tard|system is currently busy|overloaded|temporarily unavailable/i,
  };

  const timings = {
    GEN_IDLE_MS: 2000,
    REASON_IDLE_MS: 12000,
    WARMUP_MS: 45000,
    REASON_NOREPLY_MS: 90000,
    STABLE_MS: 9000,
    RESPONSE_TIMEOUT_MS: 300000,
  };

  // ── Network tap (authoritative raw markdown) ────────────────────────────
  // providers/oxalpha-net.js (MAIN world) publishes { rid, text, done, t } into
  // #zs-oxalpha-net. netLatest() reads it. This is verbatim before marked/highlight.
  function netLatest() {
    try {
      const n = document.getElementById("zs-oxalpha-net");
      if (!n || !n.textContent) return null;
      const o = JSON.parse(n.textContent);
      return o && typeof o.text === "string" ? o : null;
    } catch { return null; }
  }
  let _sentRid = null;
  function rememberSentResponse() {
    const net = netLatest();
    if (net && net.rid != null) _sentRid = net.rid;
  }
  function netCurrent() {
    const net = netLatest();
    if (!net || !net.text) return null;
    if (_sentRid != null && net.rid === _sentRid) return null; // stale
    return net;
  }
  function netReplyFor(item) {
    if (item !== lastAssistant()) return null;
    const net = netCurrent();
    return net ? net.text : null;
  }
  function netGenState() {
    const net = netCurrent();
    if (!net) return null;
    if (net.done) return "done";
    return "streaming";
  }

  // ── Turn classification ───────────────────────────────────────────────
  const isUserItem = (item) => !!item && item.classList && item.classList.contains("msg-user");
  const isAssistantItem = (item) => !!item && item.classList && item.classList.contains("msg-assistant");

  function textWithout(root, excludeSel) {
    if (!root) return "";
    const skip = ".zs-chip" + (excludeSel ? ", " + excludeSel : "");
    let t = "";
    const walk = (n) => {
      if (n.nodeType === 3) { t += n.nodeValue; return; }
      if (n.nodeType !== 1) return;
      if (n.matches && n.matches(skip)) return;
      if (n.tagName === "PRE") {
        const code = n.querySelector("code");
        if (code) { t += "\n" + (code.textContent || ""); return; }
      }
      for (const c of n.childNodes) walk(c);
    };
    walk(root);
    return t;
  }

  function bodyEl(item) {
    if (!item) return null;
    if (isAssistantItem(item)) {
      return item.querySelector(S.prose) || item.querySelector(S.msgContent) || item;
    }
    return item.querySelector(".msg-bubble") || item;
  }

  function itemText(item) {
    if (!item) return "";
    if (isAssistantItem(item)) {
      // Latest turn: authoritative net text if available
      if (item === lastAssistant()) {
        const net = netReplyFor(item);
        if (net != null) return net;
      }
      const bd = bodyEl(item);
      return bd ? textWithout(bd) : textWithout(item);
    }
    return textWithout(item);
  }
  function classifyText(item, excludeSel) {
    if (!item) return "";
    if (isAssistantItem(item)) {
      if (item === lastAssistant()) {
        const net = netReplyFor(item);
        if (net != null) return net;
      }
      const bd = bodyEl(item);
      if (bd) return textWithout(bd, excludeSel);
      return textWithout(item, excludeSel);
    }
    return textWithout(item, excludeSel);
  }

  // ── DOM primitives ────────────────────────────────────────────────────
  const allItems = () => [...document.querySelectorAll(S.anyItem)];
  const assistantItems = () => allItems().filter(isAssistantItem);
  const assistantCount = () => assistantItems().length;
  const userCount = () => allItems().filter(isUserItem).length;

  const getEditor = () => {
    const candidates = [...document.querySelectorAll(S.editor)].filter((e) => !e.closest("#zs-root"));
    if (!candidates.length) {
      const any = [...document.querySelectorAll("textarea")].filter((e) => !e.closest("#zs-root"));
      return any.find((e) => e.offsetParent !== null && e.getBoundingClientRect().width > 0) || any[0] || null;
    }
    const visible = candidates.find((e) => e.offsetParent !== null && e.getBoundingClientRect().height > 0);
    return visible || candidates[0] || null;
  };
  const editorText = () => {
    const e = getEditor();
    if (!e) return "";
    return e.value != null ? e.value : e.textContent || "";
  };

  const lastAssistant = () => {
    const it = assistantItems();
    return it.length ? it[it.length - 1] : null;
  };

  const _idMap = new WeakMap();
  let _idSeq = 0;
  function lastAssistantId() {
    const it = lastAssistant();
    if (!it) return null;
    let id = _idMap.get(it);
    if (!id) { id = ++_idSeq; _idMap.set(it, id); }
    return id;
  }
  function itemKey(item) {
    if (!item) return null;
    let id = _idMap.get(item);
    if (!id) { id = ++_idSeq; _idMap.set(item, id); }
    return String(id);
  }

  const chatIsEmpty = () => allItems().length === 0;
  const isFreshChat = () => chatIsEmpty() && !!getEditor();

  const composerFrame = () => {
    const ed = getEditor();
    if (!ed) return document.querySelector(S.composerArea) || document.querySelector(S.composerCol);
    return ed.closest(S.composerArea) || ed.closest(S.composerCol) || ed.closest(S.composerBox) || ed.parentElement;
  };
  function barAnchor() {
    return document.querySelector(S.composerArea) || document.querySelector(S.composerCol) ||
           (getEditor() && getEditor().closest(S.composerBox)) || null;
  }
  function coverTarget() {
    const ed = getEditor();
    if (!ed) return null;
    let box = ed.closest(S.composerBox);
    return box || ed;
  }

  // ── Input lock ────────────────────────────────────────────────────────
  function setInputLock(on) {
    const ed = getEditor();
    if (!ed) return;
    if (on) {
      if (!ed.dataset.zsPlaceholder) ed.dataset.zsPlaceholder = ed.getAttribute("placeholder") || "";
      ed.setAttribute("readonly", "");
      ed.setAttribute("placeholder", "⏳ Agent working… please wait");
    } else {
      ed.removeAttribute("readonly");
      if (ed.dataset.zsPlaceholder != null) ed.setAttribute("placeholder", ed.dataset.zsPlaceholder);
    }
  }

  // ── Buttons / generation detection ────────────────────────────────────
  const sendButton = () => {
    for (const b of document.querySelectorAll(S.sendBtn)) {
      if (b.closest("#zs-root")) continue;
      if (b.offsetParent !== null) return b;
    }
    const ed = getEditor();
    const scope = ed ? (ed.closest(S.composerBox) || ed.closest(S.composerArea) || document) : document;
    const fallback = scope.querySelector('button:not([disabled])');
    return fallback || null;
  };
  const stopButton = () => {
    for (const b of document.querySelectorAll(S.stopBtn)) {
      if (b.closest("#zs-root")) continue;
      if (b.offsetParent !== null) return b;
    }
    return null;
  };
  const typingVisible = () => {
    const t = document.querySelector(S.typing);
    return !!(t && t.offsetParent !== null && t.getBoundingClientRect().width > 0);
  };

  function streamText(item) {
    if (item === lastAssistant()) {
      const net = netReplyFor(item);
      if (net != null) return net;
    }
    const bd = bodyEl(item);
    return bd ? textWithout(bd, ".zs-chip") : "";
  }
  const streamLen = (item) => streamText(item === undefined ? lastAssistant() : item).length;

  let _streamMax = -1, _streamAt = 0, _streamItem = null;
  function sampleStream() {
    const item = lastAssistant();
    const len = streamText(item).length;
    const now = Date.now();
    if (item !== _streamItem || len < _streamMax - 400) {
      _streamItem = item; _streamMax = len; _streamAt = now; return;
    }
    if (len > _streamMax) { _streamMax = len; _streamAt = now; }
  }
  const grewWithin = (ms) => _streamMax > 1 && Date.now() - _streamAt < ms;

  function genActive() {
    sampleStream();
    // Network tap is authoritative: if it says streaming, we are generating
    const ng = netGenState();
    if (ng === "streaming") return true;
    // DOM stop/typing are hard signals for the whole generation
    if (stopButton()) return true;
    if (typingVisible()) return true;
    // If network says done but DOM still shows stop/typing, trust DOM (lingering)
    if (ng === "done") return false;
    try {
      const ph = window.__oxPhase;
      if (ph && ph !== "idle" && ph !== "verifying") return true;
      if (ph === "verifying") return false;
    } catch {}
    // Fallback: growth. While a tool block is open, be extra patient.
    const hasBlock = typeof ZSParse !== "undefined" && ZSParse.hasOpenToolBlock(streamText(lastAssistant()));
    const idle = hasBlock ? 8000 : timings.GEN_IDLE_MS;
    return grewWithin(idle);
  }
  const isGenerating = genActive;
  const isBusyNow = genActive;
  const isHardGenerating = () => !!stopButton() || typingVisible() || netGenState() === "streaming";

  // Core hook: while the latest turn's net is still streaming, DOM may look settled.
  // Tell waitForResponse to hold off on any "unclosed" verdict.
  function replyUnsettled(item) {
    if (item !== lastAssistant()) return false;
    const net = netCurrent();
    return !!(net && !net.done);
  }

  const turnHalted = () => false;
  const findContinueBtn = () => {
    // Ox Alpha's own continue bar for length-limit
    const ox = document.querySelector(".ox-continue-btn");
    if (ox && ox.offsetParent !== null) return ox;
    for (const b of document.querySelectorAll("button")) {
      if (b.offsetParent === null) continue;
      if (b.closest("#zs-root")) continue;
      const txt = (b.textContent || "").trim();
      if (/^(continue|continuer|continue exactly|fortfahren)$/i.test(txt)) return b;
      if (/continue/i.test(txt) && txt.length < 40) return b;
    }
    return null;
  };
  const clickContinueBtn = () => {
    const b = findContinueBtn();
    if (!b) return false;
    try { b.click(); return true; } catch { return false; }
  };

  function snapshot() {
    try {
      const it = lastAssistant();
      if (!it) return { th: 0, rp: 0 };
      // Prefer net length for rp if available
      const rp = streamText(it).length;
      return { th: 0, rp };
    } catch { return {}; }
  }

  function readAssistant() {
    const item = lastAssistant();
    if (!item) return { present: false, reply: "", thinking: "", item: null };
    // Prefer net text for latest turn
    const net = netReplyFor(item);
    if (net != null) {
      return { present: true, reply: net.trim(), thinking: "", item };
    }
    const bd = bodyEl(item);
    return {
      present: true,
      reply: bd ? textWithout(bd, ".zs-chip").trim() : "",
      thinking: "",
      item,
    };
  }

  async function waitFor(pred, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (pred()) return true;
      await sleep(120);
    }
    return false;
  }

  // ── Sending ───────────────────────────────────────────────────────────
  function setTextareaValue(el, v) {
    const proto = window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype;
    const setter = proto && Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(el, v);
    else el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function typeAndSend(text, images) {
    const editor = getEditor();
    if (!editor) throw new Error("Ox Alpha input box not found");
    // Mark current net response as consumed so the tap doesn't return stale text for the next turn
    try { rememberSentResponse(); } catch {}
    editor.focus();
    setTextareaValue(editor, text);
    if (images && images.length && !hasPendingAttachment()) {
      try { await attachImages(images); } catch {}
    }
    await waitFor(() => {
      const b = sendButton();
      return !!(b && !b.disabled && b.getAttribute("aria-disabled") !== "true");
    }, 6000);
    const btn = sendButton();
    if (btn && !btn.disabled) {
      btn.click();
      return;
    }
    const o = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    editor.dispatchEvent(new KeyboardEvent("keydown", o));
    editor.dispatchEvent(new KeyboardEvent("keyup", o));
  }

  function stopGeneration() {
    const b = stopButton();
    if (b) try { b.click(); } catch {}
  }

  function enforceComposer() { return { ready: !!getEditor() }; }
  async function ensureComposerReady(reason) {
    diag("mode_ready", { reason, provider: "oxalpha" });
    return { ready: !!getEditor() };
  }

  // ── Error / limit detection ───────────────────────────────────────────
  function scanError() {
    try {
      for (const el of document.querySelectorAll(S.errorSurfaces)) {
        if (el.offsetParent === null) continue;
        if (el.closest(S.anyItem)) continue;
        const t = (el.innerText || "").trim();
        if (t.length > 8 && t.length < 600 && RE.contextLimit.test(t)) return t.slice(0, 240);
      }
    } catch {}
    if (!getEditor()) return "The input box disappeared (session ended?).";
    return null;
  }
  const isTooLongMsg = (text) => RE.tooLong.test(text);
  const isBusyMsg = (text) => RE.busy.test(text);

  // ── Image attachment ──────────────────────────────────────────────────
  function fileFromImage(img, i) {
    const mime = img.mimeType || "image/jpeg";
    const bin = atob(img.data);
    const arr = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j);
    const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
    return new File([arr], `zeroscript_${Date.now()}_${i}.${ext}`, { type: mime });
  }
  const hasPendingAttachment = () => {
    const box = document.querySelector(S.composerBox);
    if (box && box.querySelector(S.attachImg)) return true;
    return !!document.querySelector(S.attachStrip + " img");
  };
  const fileInputEl = () => document.querySelector(S.attachInput) || document.querySelector('input[type="file"]');

  async function attachImages(images) {
    if (!images || !images.length) return false;
    const inp = fileInputEl();
    if (!inp) {
      const ed = getEditor();
      if (!ed) return false;
      const dt = new DataTransfer();
      images.forEach((img, i) => { try { dt.items.add(fileFromImage(img, i)); } catch {} });
      if (!dt.items.length) return false;
      ed.focus();
      ed.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      diag("attach.paste", { count: dt.items.length });
      return await waitFor(hasPendingAttachment, 12000);
    }
    const dt = new DataTransfer();
    images.forEach((img, i) => { try { dt.items.add(fileFromImage(img, i)); } catch {} });
    if (!dt.items.length) return false;
    try {
      inp.files = dt.files;
      inp.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (e) { diag("attach.setFilesThrew", { msg: String(e && e.message || e) }); return false; }
    diag("attach.setFiles", { count: dt.items.length });
    const ok = await waitFor(hasPendingAttachment, 12000);
    diag("attach.preview", { ok });
    return ok;
  }
  function clearAttachments() {
    try {
      document.querySelectorAll(S.attachStrip + " button").forEach((b) => { try { b.click(); } catch {} });
      document.querySelectorAll(".ox-chip button, .ox-fchip button").forEach((b) => {
        if (b.closest(S.attachStrip)) try { b.click(); } catch {}
      });
    } catch {}
  }

  const conversationKey = () => {
    try {
      if (typeof window.__oxActiveChatId === "function") {
        const id = window.__oxActiveChatId();
        if (id) return `ox:${id}`;
      }
    } catch {}
    try {
      const active = document.querySelector(".sidebar .chat-item.active");
      if (active) {
        const title = (active.querySelector(".chat-item-title")?.textContent || "").trim();
        if (title) return `ox:title:${title.slice(0, 60)}`;
      }
    } catch {}
    if (chatIsEmpty()) return "";
    return location.pathname + location.search;
  };

  // ── User-send interception ────────────────────────────────────────────
  function installSendHooks(handlers) {
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
        const ed = getEditor();
        if (!ed || !ed.contains(e.target)) return;
        if (editorText().trim() === "") return;
        if (handlers.isBlocked()) return;
        if (!handlers.isStarted()) {
          if (!chatIsEmpty()) return;
          handlers.onBlockedAttempt();
          return;
        }
        handlers.onUserMessage(assistantCount());
      },
      true
    );
    document.addEventListener(
      "click",
      (e) => {
        if (!getEditor()) return;
        const t = e.target;
        const stop = t && t.closest && t.closest(S.stopBtn);
        if (stop && stop.offsetParent !== null) { handlers.onNativeStop(); return; }
        const oxCont = t && t.closest && t.closest(".ox-continue-btn");
        if (oxCont) { handlers.onNativeContinue(); return; }
        const btn = t && t.closest && t.closest(S.sendBtn);
        if (!btn) return;
        if (btn.disabled || btn.getAttribute("aria-disabled") === "true") return;
        if (handlers.isBlocked()) return;
        if (!handlers.isStarted()) {
          if (!chatIsEmpty()) return;
          handlers.onBlockedAttempt();
          return;
        }
        handlers.onUserMessage(assistantCount());
      },
      true
    );
  }

  // ── Tool-block camouflage ─────────────────────────────────────────────
  const CMD_SHAPE = /"(?:command|tool)"\s*:\s*"|###\s*lua|###mcp_tool###/i;
  function findToolBlockSpot(item, chip) {
    if (!item) return null;
    const prose = item.querySelector(S.prose) || item;
    let hidAny = null;
    const netText = item === lastAssistant() ? netReplyFor(item) : null;
    const isToolTurn = !!chip || (netText && CMD_SHAPE.test(netText)) || CMD_SHAPE.test(prose.textContent || "");
    prose.querySelectorAll(S.codeWrap).forEach((cw) => {
      if (cw.closest(".zs-chip")) return;
      const text = (cw.textContent || "");
      const check = netText || text;
      // Hide if it looks like a command, OR if this turn already has a chip (means
      // the raw JSON is the tool call - hide every pre in a chipped turn so the
      // collapsed "\n" literal view never leaks, as seen with multi_edit)
      const shouldHide = CMD_SHAPE.test(check) || CMD_SHAPE.test(text) || (isToolTurn && text.length > 100);
      if (shouldHide) {
        cw.classList.add("zs-tool-hide");
        item.classList.add("zs-cmd-mask");
        const hdr = cw.previousElementSibling;
        if (hdr && hdr.matches && hdr.matches(S.codeHeader)) hdr.classList.add("zs-tool-hide");
        // Also hide the whole code-block wrapper div that Ox Alpha injects
        const wrap = cw.closest("div");
        if (wrap && wrap.classList.contains("code-block-header")) wrap.classList.add("zs-tool-hide");
        hidAny = hidAny || { parent: cw.parentElement, ref: cw };
      }
    });
    [...prose.children].forEach((el) => {
      if (el.classList.contains("zs-chip") || el.querySelector(S.codeWrap)) return;
      const t = el.textContent || "";
      if ((t.length < 800 && CMD_SHAPE.test(t)) || (isToolTurn && CMD_SHAPE.test(t))) {
        el.classList.add("zs-tool-hide");
        item.classList.add("zs-cmd-mask");
        hidAny = hidAny || { parent: el.parentElement, ref: el };
      }
    });
    // Fallback: if turn has a chip but we hid nothing (e.g. code split across nodes),
    // hide any remaining pre in this prose so the "\n" literal collapsed view disappears
    if (!hidAny && isToolTurn) {
      const anyPre = prose.querySelector(S.codeWrap);
      if (anyPre) {
        anyPre.classList.add("zs-tool-hide");
        item.classList.add("zs-cmd-mask");
        const hdr = anyPre.previousElementSibling;
        if (hdr && hdr.matches && hdr.matches(S.codeHeader)) hdr.classList.add("zs-tool-hide");
        hidAny = { parent: anyPre.parentElement, ref: anyPre };
      }
    }
    return hidAny;
  }

  return {
    id: "oxalpha",
    displayName: "Ox Alpha",
    supportsVision: true,
    timings,
    thinkingSel: null,
    chipAtItemLevel: true,
    chipAnchor(item) {
      return item.querySelector(S.prose)?.parentElement || item.querySelector(".msg-content") || item;
    },
    chipAppend: true,
    reliableCounts: true,
    init({ diag: d } = {}) { if (d) diag = d; },
    allItems, isUserItem, isAssistantItem, itemText, classifyText,
    assistantCount, userCount, lastAssistant, lastAssistantId, itemKey, readAssistant,
    streamLen, snapshot,
    getEditor, editorText, chatIsEmpty, isFreshChat, composerFrame, barAnchor, coverTarget,
    setInputLock, typeAndSend, stopGeneration,
    isGenerating, isBusyNow, isHardGenerating, replyUnsettled,
    enforceComposer, ensureComposerReady,
    turnHalted, findContinueBtn, clickContinueBtn,
    scanError, isTooLongMsg, isBusyMsg,
    attachImages, clearAttachments, conversationKey,
    installSendHooks, findToolBlockSpot,
  };
})();
