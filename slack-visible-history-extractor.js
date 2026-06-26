/*
Slack DM visible-history collector

How to use:
1. Open the Slack DM in a browser.
2. Open DevTools Console.
3. Paste this entire file and press Enter.
4. Scroll from the oldest message to the newest message.
5. Copy the growing text from the floating panel.

Slack only keeps nearby messages in the DOM, so this script collects messages
while you scroll instead of trying to read the whole conversation at once.
*/
(() => {
  if (window.__slackHistoryCollector?.stop) {
    window.__slackHistoryCollector.stop();
  }

  const monthNames = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11
  };

  const state = {
    rows: new Map(),
    paused: false,
    lastDateByTop: [],
    currentDate: "",
    observer: null,
    timer: null
  };

  const clean = (value) => (value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const pad = (value) => String(value).padStart(2, "0");

  const formatDate = (date) => (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  );

  const formatTime = (date) => {
    let hours = date.getHours();
    const minutes = pad(date.getMinutes());
    const suffix = hours >= 12 ? "PM" : "AM";
    hours %= 12;
    if (hours === 0) hours = 12;
    return `${hours}:${minutes} ${suffix}`;
  };

  const normalizeDateLabel = (label) => {
    const now = new Date();
    const text = clean(label).replace(/,$/, "");
    const lower = text.toLowerCase();

    if (lower === "today") return formatDate(now);
    if (lower === "yesterday") {
      const d = new Date(now);
      d.setDate(d.getDate() - 1);
      return formatDate(d);
    }

    const match = lower.match(/(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday),?\s+([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/i);
    if (!match) return text;

    const month = monthNames[match[1]];
    const day = Number(match[2]);
    const year = Number(match[3] || now.getFullYear());
    if (month == null || !day) return text;

    return formatDate(new Date(year, month, day));
  };

  const dateDividerPattern = /^(today|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday)(,?\s+|$)/i;
  const timePattern = /\b\d{1,2}:\d{2}\s?(AM|PM)\b/i;

  const getSlackTs = (el) => {
    const withTs = el.closest("[data-ts]") || el.querySelector("[data-ts]");
    const attrTs = withTs?.getAttribute("data-ts");
    if (attrTs && /^\d{10}\.\d{6}$/.test(attrTs)) return attrTs;

    const link = el.querySelector('a[href*="/archives/"][href*="/p"]');
    const href = link?.getAttribute("href") || "";
    const match = href.match(/\/p(\d{10})(\d{6})/);
    if (match) return `${match[1]}.${match[2]}`;

    return "";
  };

  const dateFromSlackTs = (ts) => {
    if (!ts) return null;
    const seconds = Number(ts.split(".")[0]);
    if (!Number.isFinite(seconds)) return null;
    const date = new Date(seconds * 1000);
    return { date: formatDate(date), time: formatTime(date), sort: seconds };
  };

  const isDateDivider = (el) => {
    const text = clean(el.innerText || el.getAttribute("aria-label"));
    return dateDividerPattern.test(text) && text.length < 80;
  };

  const likelyMessageElement = (el) => {
    const text = clean(el.innerText);
    if (!text || isDateDivider(el)) return false;
    if (getSlackTs(el)) return true;
    return Boolean(findNearestDate(el.getBoundingClientRect().top) || state.currentDate)
      && timePattern.test(text)
      && !/^(direct messages|files & links|message |find a dm|search )/i.test(text);
  };

  const getAuthor = (el, text) => {
    const authorSelectors = [
      '[data-qa="message_sender"]',
      ".c-message__sender",
      ".c-message_kit__sender",
      ".c-message_kit__sender_name"
    ];

    for (const selector of authorSelectors) {
      const found = el.querySelector(selector);
      const author = clean(found?.innerText || found?.getAttribute("aria-label"));
      if (author) return author;
    }

    const timeMatch = text.match(timePattern);
    if (!timeMatch) return "";
    const beforeTime = clean(text.slice(0, timeMatch.index));
    return beforeTime.split(" ").slice(0, 4).join(" ");
  };

  const getBody = (el, text, author, time) => {
    const contentSelectors = [
      '[data-qa="message-text"]',
      '[data-qa="message_content"]',
      ".c-message__body",
      ".c-message_kit__text",
      ".p-rich_text_section"
    ];

    for (const selector of contentSelectors) {
      const found = el.querySelector(selector);
      const body = clean(found?.innerText);
      if (body) return body;
    }

    let body = text;
    if (author) body = clean(body.replace(author, ""));
    if (time) body = clean(body.replace(time, ""));
    return body
      .replace(/\b(Edit|More actions|Add reaction|Reply in thread|Forward message|Save for later)\b/gi, "")
      .trim();
  };

  const candidateElements = () => {
    const root = document.querySelector([
      '[data-qa="message_pane"]',
      '[data-qa="channel_view"]',
      '[data-qa="virtual-list"]',
      '[role="main"]'
    ].join(",")) || document;

    const selectors = [
      '[data-ts]',
      'a[href*="/archives/"][href*="/p"]',
      '[data-qa*="message"]',
      ".c-message_kit__background",
      ".c-virtual_list__item"
    ];

    return [...root.querySelectorAll(selectors.join(","))]
      .filter((el) => clean(el.innerText || el.getAttribute("aria-label")))
      .filter((el, index, all) => {
        const firstContainer = all.findIndex((other) => other !== el && other.contains(el));
        return firstContainer === -1 || likelyMessageElement(el);
      })
      .map((el) => ({
        el,
        top: el.getBoundingClientRect().top,
        text: clean(el.innerText || el.getAttribute("aria-label"))
      }))
      .sort((a, b) => a.top - b.top);
  };

  const findNearestDate = (top) => {
    let current = "";
    for (const item of state.lastDateByTop) {
      if (item.top <= top) current = item.date;
    }
    return current;
  };

  const collect = () => {
    if (state.paused) return;

    const items = candidateElements();
    state.lastDateByTop = items
      .filter((item) => isDateDivider(item.el))
      .map((item) => ({ top: item.top, date: normalizeDateLabel(item.text) }));

    for (const item of items) {
      if (isDateDivider(item.el)) {
        state.currentDate = normalizeDateLabel(item.text);
        continue;
      }

      if (!likelyMessageElement(item.el)) continue;

      const ts = getSlackTs(item.el);
      const tsParts = dateFromSlackTs(ts);
      const time = tsParts?.time || item.text.match(timePattern)?.[0] || "";
      const date = tsParts?.date || findNearestDate(item.top) || "";
      if (!date) continue;
      state.currentDate = date;
      const sort = tsParts?.sort || Date.now() / 1000;
      const author = getAuthor(item.el, item.text);
      const body = getBody(item.el, item.text, author, time);
      if (!body) continue;

      const key = ts || `${date}|${time}|${author}|${body}`;
      state.rows.set(key, { date, time, author, body, sort, key });
    }

    render();
  };

  const buildOutput = () => [...state.rows.values()]
    .sort((a, b) => a.sort - b.sort || a.key.localeCompare(b.key))
    .map((row) => `[${row.date} ${row.time}] ${row.author ? `${row.author}: ` : ""}${row.body}`)
    .join("\n");

  const render = () => {
    const panel = document.getElementById("slack-history-collector");
    if (!panel) return;

    const rows = [...state.rows.values()].sort((a, b) => a.sort - b.sort || a.key.localeCompare(b.key));
    panel.querySelector("[data-count]").textContent = `${rows.length} messages`;
    panel.querySelector("textarea").value = buildOutput();
    panel.querySelector("[data-status]").textContent = state.paused ? "Paused" : "Collecting";
  };

  const makeButton = (label, onClick) => {
    const button = document.createElement("button");
    button.textContent = label;
    button.style.cssText = "border:1px solid #555;background:#2b2d31;color:white;border-radius:6px;padding:6px 8px;cursor:pointer;font:12px Arial;";
    button.addEventListener("click", onClick);
    return button;
  };

  const installPanel = () => {
    document.getElementById("slack-history-collector")?.remove();

    const panel = document.createElement("div");
    panel.id = "slack-history-collector";
    panel.style.cssText = [
      "position:fixed",
      "right:16px",
      "bottom:16px",
      "z-index:999999",
      "width:min(620px,calc(100vw - 32px))",
      "height:320px",
      "background:#1f2329",
      "color:white",
      "border:1px solid #555",
      "box-shadow:0 10px 40px rgba(0,0,0,.45)",
      "border-radius:8px",
      "font:12px Arial,sans-serif",
      "display:flex",
      "flex-direction:column",
      "overflow:hidden"
    ].join(";");

    const header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;gap:8px;padding:8px;border-bottom:1px solid #444;";

    const title = document.createElement("strong");
    title.textContent = "Slack DM collector";

    const count = document.createElement("span");
    count.setAttribute("data-count", "");
    count.textContent = "0 messages";
    count.style.cssText = "opacity:.8;margin-left:auto;";

    const status = document.createElement("span");
    status.setAttribute("data-status", "");
    status.textContent = "Collecting";
    status.style.cssText = "opacity:.8;";

    const textarea = document.createElement("textarea");
    textarea.readOnly = false;
    textarea.spellcheck = false;
    textarea.style.cssText = [
      "flex:1",
      "resize:none",
      "border:0",
      "outline:0",
      "padding:10px",
      "background:#111418",
      "color:#f2f2f2",
      "font:12px Consolas,monospace",
      "line-height:1.45"
    ].join(";");

    const footer = document.createElement("div");
    footer.style.cssText = "display:flex;gap:8px;padding:8px;border-top:1px solid #444;";

    footer.append(
      makeButton("Copy", async () => {
        textarea.select();
        await navigator.clipboard.writeText(textarea.value);
      }),
      makeButton("Pause/Resume", () => {
        state.paused = !state.paused;
        collect();
        render();
      }),
      makeButton("Clear", () => {
        state.rows.clear();
        render();
      }),
      makeButton("Close", () => {
        window.__slackHistoryCollector.stop();
      })
    );

    header.append(title, status, count);
    panel.append(header, textarea, footer);
    document.body.append(panel);
  };

  const start = () => {
    installPanel();
    collect();

    const schedule = () => {
      clearTimeout(state.timer);
      state.timer = setTimeout(collect, 250);
    };

    document.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);

    state.observer = new MutationObserver(schedule);
    state.observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    window.__slackHistoryCollector = {
      collect,
      output: buildOutput,
      rows: state.rows,
      stop: () => {
        document.removeEventListener("scroll", schedule, true);
        window.removeEventListener("resize", schedule);
        state.observer?.disconnect();
        clearTimeout(state.timer);
        document.getElementById("slack-history-collector")?.remove();
        delete window.__slackHistoryCollector;
      }
    };

    console.log("Slack DM collector is running. Scroll through the DM and copy from the floating panel.");
  };

  start();
})();
