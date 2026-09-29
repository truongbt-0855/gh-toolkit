// GitHub Sub-issue Navigator — content script
(() => {
  const PANEL_ID = "gsn-panel";
  const ISSUE_RE = /^\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/;
  const TREEITEM = '[role="treeitem"]';
  const CHEVRON = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z"/></svg>';
  const LOCATE = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">' +
    '<circle cx="8" cy="8" r="4.5"/><circle cx="8" cy="8" r="1" fill="currentColor"/><path d="M8 .75v2.5M8 12.75v2.5M.75 8h2.5M12.75 8h2.5"/></svg>';
  let lastKey = "";
  let collapsed = false;
  let pos = null;

  chrome.storage?.sync?.get(["gsnCollapsed", "gsnPos"], (v) => {
    collapsed = !!v.gsnCollapsed;
    pos = v.gsnPos || null;
    schedule();
  });

  const refKey = (r) => `${r.owner}/${r.repo}#${r.num}`.toLowerCase();
  const refParam = (r) => `${r.owner}|${r.repo}|${r.num}`;

  function parseIssueParam(v) {
    const [owner, repo, num] = (v || "").split("|");
    return owner && repo && /^\d+$/.test(num || "") ? { owner, repo, num } : null;
  }

  function parseIssueLink(a) {
    let u;
    try { u = new URL(a.getAttribute("href"), location.origin); } catch { return null; }
    if (u.origin !== location.origin) return null;
    const m = u.pathname.match(ISSUE_RE);
    return m ? { owner: m[1], repo: m[2], num: m[3] } : null;
  }

  // leading [...] groups minus the Japanese ones: "[Seed data] [CR][機能名] タイトル…" -> "[Seed data] [CR]"
  const GROUP_RE = /\s*(?:\[[^\]]+\]|【[^】]+】|［[^］]+］)/y;
  const JA_RE = /[぀-ヿ㐀-鿿豈-﫿ｦ-ﾟ]/; // kana, kanji, half-width kana
  function shortTitle(t) {
    let keep = "", m;
    GROUP_RE.lastIndex = 0;
    while ((m = GROUP_RE.exec(t))) if (!JA_RE.test(m[0])) keep += m[0];
    return keep.trim() || t;
  }

  // ---------- current issue detection ----------
  // mode "issue": /owner/repo/issues/N, `?issue=o|r|n` = sub-issue opened in GitHub's side panel
  // mode "pane":  project view, `?pane=issue&issue=o|r|n` = the issue shown in the project pane
  function currentIssue() {
    const url = new URL(location.href);
    const param = parseIssueParam(url.searchParams.get("issue"));
    const m = location.pathname.match(ISSUE_RE);
    if (m) return { owner: m[1], repo: m[2], num: m[3], mode: "issue", active: param };
    if (param) return { ...param, mode: "pane", active: null };
    return null;
  }

  // ---------- find the "Sub-issues" section in the DOM ----------
  // Issue number shown in the header of the issue viewer that contains `el`
  // (the page itself and the side panel each render their own viewer).
  function viewerIssueNum(el) {
    for (let n = el.parentElement; n; n = n.parentElement) {
      const h = n.querySelector('[data-testid="issue-header"]');
      if (!h) continue;
      const t = h.querySelector('[class*="issueNumberText"]')?.textContent || h.textContent || "";
      const all = [...t.matchAll(/#(\d+)/g)];
      return all.length ? all[all.length - 1][1] : null;
    }
    return null;
  }

  function findSubIssueSection(cur) {
    const conts = [...document.querySelectorAll('[data-testid="sub-issues-issue-container"]')];
    if (conts.length) {
      const nums = conts.map(viewerIssueNum);
      let i = nums.indexOf(cur.num);
      if (i < 0) i = nums.indexOf(null);
      return i >= 0 ? conts[i] : null;
    }

    // older markup: heading / button whose text starts with "Sub-issues".
    // Skip our own panel (its title is "Sub-issues của #…") and never climb up to a block that holds the
    // whole issue, otherwise links in the description get listed and the panel flickers.
    for (const el of document.querySelectorAll("h2, h3, h4, button, span")) {
      if (el.closest("#" + PANEL_ID)) continue;
      const t = (el.textContent || "").trim();
      if (!/^Sub-?issues\b/i.test(t) || t.length > 40) continue;
      let node = el;
      for (let i = 0; i < 8 && node; i++) {
        node = node.parentElement;
        if (!node || node === document.body || node.querySelector('[data-testid="issue-header"], [data-testid="issue-body"]')) break;
        if (node.querySelector('a[href*="/issues/"]')) return node;
      }
    }
    return null;
  }

  // ---------- read one row ----------
  // Elements of `row` that are not inside a nested row (boundary selector `b`).
  const own = (row, sel, b) =>
    [...row.querySelectorAll(sel)].filter((el) => {
      const c = el.closest(b);
      return !c || c === row || !row.contains(c);
    });

  function rowState(row, b) {
    for (const el of own(row, "svg, [data-status]", b)) {
      const cls = el.getAttribute("class") || "";
      const st = el.getAttribute("data-status") || "";
      const lab = el.tagName.toLowerCase() === "svg" ? el.getAttribute("aria-label") || "" : "";
      if (/octicon-skip\b/.test(cls) || /not.?planned/i.test(st + " " + lab)) return "skipped";
      if (/octicon-issue-closed\b/.test(cls) || /closed/i.test(st) || /^(closed|completed)/i.test(lab)) return "closed";
    }
    return "open";
  }

  // "1 of 2" badge GitHub shows on rows that have their own sub-issues
  function rowProgress(row, b) {
    for (const el of own(row, "span, div", b)) {
      const m = (el.textContent || "").trim().match(/^(\d+)\s*(?:of|\/)\s*(\d+)$/);
      if (m) return `${m[1]}/${m[2]}`;
    }
    return "";
  }

  // assignee avatars GitHub shows at the end of a row
  function rowAssignees(row, b) {
    const out = [];
    const seen = new Set();
    for (const img of own(row, "img", b)) {
      const hint = `${img.src} ${img.getAttribute("class") || ""} ${img.getAttribute("data-testid") || ""}`;
      if (!/avatar/i.test(hint)) continue;
      const link = img.closest("a[href]");
      const name = (img.getAttribute("alt") || img.getAttribute("title") || link?.getAttribute("aria-label") ||
        link?.getAttribute("href")?.split("/").pop() || "").replace(/^@/, "").trim();
      const k = name || img.src;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ src: img.src, name });
    }
    return out;
  }

  // GitHub's expand/collapse control of a TreeView row
  function nativeToggle(li) {
    const pick = (sel) => own(li, sel, TREEITEM)[0];
    return (
      pick('[class*="TreeViewItemToggle"], [class*="TreeView-item-toggle"]') ||
      pick("button[aria-expanded]:not([aria-haspopup])") ||
      pick("svg.octicon-chevron-down, svg.octicon-chevron-right, svg.octicon-triangle-down, svg.octicon-triangle-right")?.parentElement ||
      null
    );
  }

  // null = row has no sub-issues, otherwise whether its branch is open in GitHub's list.
  // aria-expanded alone is not enough: TreeView drops it while a collapsed branch hasn't loaded its children.
  function expandState(li, progress) {
    const ex = li.getAttribute("aria-expanded");
    if (ex !== null) return ex === "true";
    if (li.querySelector(TREEITEM)) return true;
    const tog = nativeToggle(li);
    if (tog) return !!tog.querySelector(".octicon-chevron-down, .octicon-triangle-down");
    return progress ? false : null;
  }

  function collectSubIssues(cur) {
    const sec = findSubIssueSection(cur);
    if (!sec) return null;
    const rootKey = refKey(cur);
    const seen = new Set();
    const out = [];
    const push = (ref, a, row, b, depth, isTree) => {
      const key = refKey(ref);
      if (seen.has(key) || key === rootKey) return;
      const title = (a.textContent || "").trim();
      if (!title) return;
      seen.add(key);
      const progress = rowProgress(row, b);
      out.push({ ...ref, key, title, depth, row, a, progress, state: rowState(row, b), assignees: rowAssignees(row, b),
        expanded: isTree ? expandState(row, progress) : null });
    };

    const rows = sec.querySelectorAll(TREEITEM);
    if (rows.length) {
      // TreeView markup: nesting comes from aria-level
      for (const li of rows) {
        // the title link is the longest one (a row may also link its "#123")
        let a = null, ref = null;
        for (const x of own(li, 'a[href*="/issues/"]', TREEITEM)) {
          const r = parseIssueLink(x);
          if (r && x.textContent.trim().length > (a ? a.textContent.trim().length : 0)) { a = x; ref = r; }
        }
        if (!a) continue;
        let depth = parseInt(li.getAttribute("aria-level"), 10) - 1;
        if (!(depth >= 0)) {
          depth = 0;
          for (let p = li.parentElement; p && p !== sec; p = p.parentElement) if (p.matches(TREEITEM)) depth++;
        }
        push(ref, a, li, TREEITEM, depth, true);
      }
    } else {
      // plain list markup: nesting = number of ancestor <li>
      for (const a of sec.querySelectorAll('a[href*="/issues/"]')) {
        const ref = parseIssueLink(a);
        if (!ref) continue;
        let depth = -1;
        for (let p = a.parentElement; p && p !== sec; p = p.parentElement) if (p.tagName === "LI") depth++;
        push(ref, a, a.closest("li") || a.parentElement, "li", Math.max(0, depth), false);
      }
    }

    const min = Math.min(...out.map((i) => i.depth));
    for (const i of out) i.depth -= min;
    return out;
  }

  // ---------- actions on GitHub's own list ----------
  function freshRow(cur, it) {
    return collectSubIssues(cur)?.find((x) => x.key === it.key) || null;
  }

  function toggleNative(cur, it) {
    const li = freshRow(cur, it)?.row;
    if (!li) return;
    const t = nativeToggle(li);
    if (t) {
      if (typeof t.click === "function") t.click();
      else t.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return;
    }
    // TreeView keyboard handling as last resort
    const key = li.getAttribute("aria-expanded") === "true" ? "ArrowLeft" : "ArrowRight";
    li.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  }

  function sidePanelShows(it) {
    const v = new URL(location.href).searchParams.get("issue") || "";
    return v.toLowerCase() === refParam(it).toLowerCase();
  }

  let openWatch = null;
  function openItem(cur, it) {
    const href = panelHref(cur, it);
    if (cur.mode !== "issue") { location.assign(href); return; } // project pane is a React app, pushState won't re-render
    // Clicking GitHub's own link opens the side panel without reloading the page.
    const a = freshRow(cur, it)?.a;
    if (!a?.isConnected) { location.assign(href); return; }
    const before = location.href;
    a.click();
    // Load the URL only if GitHub did nothing. Once the panel opened or the URL moved at all
    // (e.g. the user already closed the panel again) stop watching, or closing it would reload the page.
    clearInterval(openWatch);
    let ticks = 0;
    openWatch = setInterval(() => {
      if (sidePanelShows(it) || location.href !== before) { clearInterval(openWatch); return; }
      if (++ticks >= 15) { clearInterval(openWatch); location.assign(href); }
    }, 100);
  }

  // Smooth-scroll the page to GitHub's Sub-issues block, then flash it once the scroll has settled.
  function scrollToNative() {
    const cur = currentIssue();
    const sec = cur && findSubIssueSection(cur);
    if (!sec) return;
    sec.style.scrollMarginTop = "80px"; // clear GitHub's sticky issue header
    sec.scrollIntoView({ behavior: "smooth", block: "start" });
    let done = false;
    const flash = () => {
      if (done) return;
      done = true;
      document.removeEventListener("scrollend", flash, true);
      sec.classList.remove("gsn-flash");
      void sec.offsetWidth; // restart the animation on repeated clicks
      sec.classList.add("gsn-flash");
      setTimeout(() => sec.classList.remove("gsn-flash"), 1600);
    };
    document.addEventListener("scrollend", flash, true);
    setTimeout(flash, 1200); // already in view -> no scrollend
  }

  // ---------- link building ----------
  // A row's href (Ctrl/middle click -> new tab) is the issue itself; a left click opens it in a panel instead.
  const issueHref = (it) => `${location.origin}/${it.owner}/${it.repo}/issues/${it.num}`;

  function panelHref(cur, it) {
    if (cur.mode === "pane") {
      const u = new URL(location.href);
      u.searchParams.set("pane", "issue");
      u.searchParams.set("issue", refParam(it));
      u.searchParams.delete("itemId");
      return u.toString();
    }
    return `${location.origin}/${cur.owner}/${cur.repo}/issues/${cur.num}?issue=${encodeURIComponent(refParam(it))}`;
  }

  // ---------- panel ----------
  function ensurePanel() {
    let p = document.getElementById(PANEL_ID);
    if (p) return p;
    p = document.createElement("div");
    p.id = PANEL_ID;
    p.innerHTML = `
      <div class="gsn-head">
        <span class="gsn-title">Sub-issues</span>
        <span class="gsn-count"></span>
        <button class="gsn-btn gsn-locate" title="Cuộn tới Sub-issues trên trang">${LOCATE}</button>
        <button class="gsn-btn gsn-refresh" title="Quét lại">↻</button>
        <button class="gsn-btn gsn-toggle" title="Thu gọn / mở rộng">–</button>
      </div>
      <input class="gsn-search" placeholder="Lọc theo tiêu đề hoặc #số…" />
      <div class="gsn-body"></div>`;
    document.body.appendChild(p);

    p.querySelector(".gsn-toggle").onclick = (e) => {
      e.stopPropagation();
      collapsed = !collapsed;
      chrome.storage?.sync?.set({ gsnCollapsed: collapsed });
      applyCollapsed(p);
    };
    p.querySelector(".gsn-refresh").onclick = (e) => { e.stopPropagation(); pending.clear(); lastKey = ""; render(); };
    p.querySelector(".gsn-locate").onclick = (e) => { e.stopPropagation(); scrollToNative(); };
    p.querySelector(".gsn-search").oninput = () => applyFilter(p);

    const body = p.querySelector(".gsn-body");
    body.addEventListener("click", (e) => {
      const row = e.target.closest(".gsn-item");
      if (!row) return;
      const it = shown.get(row.dataset.key);
      const onCaret = !!e.target.closest(".gsn-caret") && it?.expanded != null;
      if (!it || it.loading || onCaret) {
        e.preventDefault();
        if (onCaret) toggleBranch(shownCur, it);
        return;
      }
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0) return; // browser opens the issue in a new tab
      e.preventDefault();
      openItem(shownCur, it);
    });
    body.addEventListener("auxclick", (e) => {
      if (e.target.closest(".gsn-caret:not(:empty), .gsn-placeholder")) e.preventDefault();
    });

    // drag by header
    const head = p.querySelector(".gsn-head");
    let drag = null;
    head.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      drag = { dx: e.clientX - p.offsetLeft, dy: e.clientY - p.offsetTop };
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!drag) return;
      p.style.left = Math.max(0, e.clientX - drag.dx) + "px";
      p.style.top = Math.max(0, e.clientY - drag.dy) + "px";
    });
    window.addEventListener("mouseup", () => {
      if (!drag) return;
      drag = null;
      pos = { left: p.style.left, top: p.style.top };
      chrome.storage?.sync?.set({ gsnPos: pos });
    });
    if (pos) { p.style.left = pos.left; p.style.top = pos.top; }
    applyCollapsed(p);
    return p;
  }

  function applyCollapsed(p) {
    p.classList.toggle("gsn-collapsed", collapsed);
    p.querySelector(".gsn-toggle").textContent = collapsed ? "+" : "–";
  }

  function applyFilter(p) {
    const q = p.querySelector(".gsn-search").value.trim().toLowerCase();
    p.querySelectorAll(".gsn-item").forEach((el) => {
      el.classList.toggle("gsn-hidden", !!q && !el.dataset.search.includes(q));
    });
  }

  // ---------- expand / collapse ----------
  // A caret click flips the branch in the panel at once (children last seen under that row, or a
  // "loading" row) while GitHub expands/collapses its own list; `pending` keeps that until GitHub agrees.
  const pending = new Map(); // row key -> { open, until }
  const kidsCache = new Map(); // row key -> descendants last seen, depth relative to the row

  function applyPending(items) {
    const now = Date.now();
    const out = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      let end = i + 1;
      while (end < items.length && items[end].depth > it.depth) end++;
      if (end > i + 1) kidsCache.set(it.key, items.slice(i + 1, end).map((k) => ({ ...k, depth: k.depth - it.depth })));

      let p = pending.get(it.key);
      if (p && (p.until < now || (p.open ? end > i + 1 : !it.expanded))) { pending.delete(it.key); p = null; }
      if (!p) { out.push(it); continue; }
      if (!p.open) { out.push({ ...it, expanded: false }); i = end - 1; continue; } // hide GitHub's rows now
      out.push({ ...it, expanded: true });
      const cached = kidsCache.get(it.key);
      if (cached) for (const k of cached) out.push({ ...k, depth: it.depth + k.depth });
      else out.push({ key: it.key + ":loading", depth: it.depth + 1, loading: true });
    }
    return out;
  }

  function toggleBranch(cur, it) {
    pending.set(it.key, { open: !it.expanded, until: Date.now() + 4000 });
    setTimeout(schedule, 4100);
    render();
    toggleNative(cur, it);
  }

  // ---------- rows ----------
  let shown = new Map(); // key -> item currently in the panel, for the click handler
  let shownCur = null;
  let shownRoot = "";

  const namesOf = (i) => (i.assignees || []).map((u) => u.name || u.src).join(", ");
  const rowSig = (i) => `${i.key}:${i.depth}:${i.state}:${i.expanded}:${i.progress}:${namesOf(i)}:${i.title}`;

  function createRow() {
    const a = document.createElement("a");
    a.className = "gsn-item";
    a.innerHTML = '<span class="gsn-indent"></span><span class="gsn-caret"></span><span class="gsn-dot"></span>' +
      '<span class="gsn-num"></span><span class="gsn-text"></span><span class="gsn-prog"></span><span class="gsn-avatars"></span>';
    return a;
  }

  function updateRow(el, it, activeKey) {
    const active = it.key === activeKey;
    const sig = rowSig(it) + (active ? ":active" : "");
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    el.dataset.key = it.key;
    const q = (s) => el.querySelector(s);
    q(".gsn-indent").innerHTML = '<span class="gsn-guide"></span>'.repeat(it.depth);
    if (it.loading) {
      el.classList.add("gsn-placeholder");
      el.dataset.search = "";
      q(".gsn-text").textContent = "Đang tải…";
      return;
    }
    el.href = issueHref(it);
    const names = (it.assignees || []).map((u) => u.name).filter(Boolean).join(", ");
    el.title = `${it.owner}/${it.repo}#${it.num}\n${it.title}` + (names ? `\nAssignee: ${names}` : "");
    el.dataset.search = `#${it.num} ${it.title} ${names}`.toLowerCase();
    el.classList.remove("gsn-open", "gsn-closed", "gsn-skipped");
    el.classList.add("gsn-" + it.state);
    el.classList.toggle("gsn-active", active);
    const c = q(".gsn-caret");
    if (it.expanded === null) {
      c.textContent = "";
      c.classList.remove("gsn-expanded");
      c.removeAttribute("title");
    } else {
      if (!c.firstChild) c.innerHTML = CHEVRON;
      c.classList.toggle("gsn-expanded", it.expanded); // same element -> the chevron rotates
      c.title = it.expanded ? "Thu gọn" : "Mở rộng";
    }
    q(".gsn-num").textContent = "#" + it.num;
    q(".gsn-text").textContent = shortTitle(it.title);
    q(".gsn-prog").textContent = it.progress;
    const av = q(".gsn-avatars");
    const avSig = namesOf(it);
    if (av.dataset.sig !== avSig) { // rebuild only when assignees change, so avatars don't reload
      av.dataset.sig = avSig;
      av.textContent = "";
      const list = it.assignees || [];
      for (const u of list.slice(0, 3)) {
        const img = document.createElement("img");
        img.src = u.src;
        img.alt = "";
        av.appendChild(img);
      }
      if (list.length > 3) av.insertAdjacentHTML("beforeend", `<span class="gsn-more">+${list.length - 3}</span>`);
    }
  }

  // Update the list in place (keyed by issue) so rows can slide in / out instead of being rebuilt.
  function reconcile(body, items, activeKey, animate) {
    const old = new Map();
    for (const el of body.children) if (!el.classList.contains("gsn-leave")) old.set(el.dataset.key, el);
    let prev = null;
    for (const it of items) {
      let el = old.get(it.key);
      if (el) old.delete(it.key);
      else {
        el = createRow();
        if (animate) {
          el.classList.add("gsn-enter");
          setTimeout(() => el.classList.remove("gsn-enter"), 250);
        }
      }
      updateRow(el, it, activeKey);
      let want = prev ? prev.nextSibling : body.firstChild;
      while (want && want.classList.contains("gsn-leave")) want = want.nextSibling; // leaving rows keep their spot
      if (el !== want) body.insertBefore(el, want);
      prev = el;
    }
    for (const el of old.values()) {
      if (!animate || el.classList.contains("gsn-placeholder")) { el.remove(); continue; }
      el.classList.add("gsn-leave");
      setTimeout(() => el.remove(), 200);
    }
  }

  function render() {
    const cur = currentIssue();
    const panel = document.getElementById(PANEL_ID);
    if (!cur) { panel?.remove(); lastKey = ""; shownRoot = ""; return; }
    const raw = collectSubIssues(cur);
    // only issues that have sub-issues get the panel
    if (!raw?.length) { panel?.classList.add("gsn-none"); lastKey = ""; return; }

    const items = applyPending(raw);
    const rootKey = refKey(cur);
    const activeKey = cur.active ? refKey(cur.active) : "";
    const key = [cur.mode, rootKey, activeKey, items.map(rowSig).join(",")].join("|");
    if (key === lastKey) return;
    lastKey = key;

    const p = ensurePanel();
    p.classList.remove("gsn-none");
    const body = p.querySelector(".gsn-body");
    const animate = shownRoot === rootKey; // no animation when a different issue is shown
    if (!animate) { shownRoot = rootKey; body.textContent = ""; }
    shownCur = cur;
    shown = new Map(items.map((i) => [i.key, i]));
    p.querySelector(".gsn-title").textContent = `Sub-issues của #${cur.num}`;
    // same as GitHub's "1 of 3": direct children only
    const top = raw.filter((i) => i.depth === 0);
    p.querySelector(".gsn-count").textContent = `${top.filter((i) => i.state !== "open").length}/${top.length} done`;
    reconcile(body, items, activeKey, animate);
    applyFilter(p);
  }

  // ---------- observe SPA navigation + lazy-loaded panel ----------
  // Throttle, not debounce: GitHub keeps mutating the page, a debounce kept postponing the update.
  let timer = null;
  function schedule() {
    if (!timer) timer = setTimeout(() => { timer = null; render(); }, 80);
  }
  // changes inside our own panel never need a re-scan
  new MutationObserver((recs) => {
    const p = document.getElementById(PANEL_ID);
    if (!p || recs.some((r) => !p.contains(r.target))) schedule();
  }).observe(document.documentElement, { childList: true, subtree: true });
  for (const ev of ["turbo:load", "turbo:render", "popstate", "hashchange"]) window.addEventListener(ev, schedule);
  const _ps = history.pushState, _rs = history.replaceState;
  history.pushState = function () { _ps.apply(this, arguments); schedule(); };
  history.replaceState = function () { _rs.apply(this, arguments); schedule(); };
  schedule();
})();
