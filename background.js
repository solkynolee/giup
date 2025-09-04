
const LIST_URL = "https://www.bizinfo.go.kr/web/lay1/bbs/S1T122C128/AS/74/list.do";

/** --------------------
 *  HTML helpers (no DOMParser)
 *  -------------------- */
function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function getTitleFromHTML(html) {
  // Try <title>
  const mTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (mTitle && mTitle[1]) return stripTags(mTitle[1]);
  // Try h1/h2
  const mH = html.match(/<(h1|h2)[^>]*>([\s\S]*?)<\/\1>/i);
  if (mH && mH[2]) return stripTags(mH[2]);
  // Fallback
  return "새 공고";
}

// Extract list items by just scanning anchors
function extractListItemsFromHTML(html) {
  const items = [];
  const seen = new Set();
  // find anchors with href to view.do?pblancId=
  const regex = /<a[^>]*href="([^"]*view\.do\?[^"]*pblancId=[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const href = match[1];
    const url = new URL(href, LIST_URL).toString();
    const idm = url.match(/pblancId=([A-Za-z0-9_\-]+)/);
    if (!idm) continue;
    const id = idm[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const title = stripTags(match[2]);
    // Try to capture nearby date by looking at a small window around the match index
    const windowStart = Math.max(0, match.index - 400);
    const windowEnd = Math.min(html.length, regex.lastIndex + 400);
    const window = stripTags(html.slice(windowStart, windowEnd));
    const dm = window.match(/\d{4}[.\-]\d{2}[.\-]\d{2}/);
    const date = dm ? dm[0].replace(/\./g, "-") : "";
    items.push({ id, url, title, date });
  }
  return items;
}

async function fetchText(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, credentials: "omit", cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(id);
  }
}

// Build a compact summary from detail HTML (no DOMParser)
function summarizeDetailFromHTML(html) {
  const plain = stripTags(html);

  // Try to focus on "사업개요" section by slicing between markers
  let snippet = "";
  const startIdx = plain.indexOf("사업개요");
  if (startIdx !== -1) {
    snippet = plain.slice(startIdx + "사업개요".length);
    const stops = ["사업신청", "신청기간", "문의처", "첨부파일", "본문출력파일", "정보에 만족하셨나요?"];
    let cut = snippet.length;
    for (const s of stops) {
      const i = snippet.indexOf(s);
      if (i !== -1 && i < cut) cut = i;
    }
    snippet = snippet.slice(0, cut).trim();
  } else {
    // fallback: take the first part of the body
    snippet = plain.slice(0, 800);
  }

  const sentences = snippet
    .split(/(?<=[\.!\?])\s+|[\n\r]+|[•·ㆍ]\s*/)
    .map(s => s.trim())
    .filter(s => s.length > 0 && s.length < 280);

  const KW = ["지원", "모집", "대상", "기간", "금액", "한도", "자금", "보조", "융자", "창업", "수행", "조건"];
  let picked = [];
  if (sentences.length) {
    const scored = sentences.map(s => ({
      s,
      score: KW.reduce((acc, k) => acc + (s.includes(k) ? 2 : 0), 0) + Math.min(1, s.length / 80)
    }));
    scored.sort((a, b) => b.score - a.score);
    picked = scored.slice(0, 3).map(o => o.s);
  } else {
    picked = [snippet.slice(0, 180)];
  }
  let summary = "• " + picked.join("\n• ");
  if (summary.length > 500) summary = summary.slice(0, 500) + "…";
  return summary;
}

function extractPeriodFromHTML(html) {
  const plain = stripTags(html);
  const pm = plain.match(/(\d{4}[.\-]\d{2}[.\-]\d{2})\s*[~\-–]\s*(\d{4}[.\-]\d{2}[.\-]\d{2})/);
  if (pm) return pm[1].replace(/\./g, "-") + " ~ " + pm[2].replace(/\./g, "-");
  return "";
}

async function fetchAndSummarize(url) {
  const html = await fetchText(url);
  const title = getTitleFromHTML(html);
  const summary = summarizeDetailFromHTML(html);
  const period = extractPeriodFromHTML(html);
  return { title, summary, period };
}

async function checkForUpdates(showToastIfNone = false) {
  try {
    const listHTML = await fetchText(LIST_URL);
    const items = extractListItemsFromHTML(listHTML);
    if (items.length === 0) throw new Error("목록 추출 실패");

    const { lastSeenIds = [], cacheItems = [] } = await chrome.storage.local.get(["lastSeenIds", "cacheItems"]);
    const known = new Set(lastSeenIds);
    const fresh = items.filter(it => !known.has(it.id));

    if (fresh.length === 0) {
      if (showToastIfNone) {
        chrome.action.setBadgeText({ text: "" });
      }
      return;
    }

    for (const it of fresh) {
      const detail = await fetchAndSummarize(it.url);
      const record = {
        id: it.id,
        title: it.title || detail.title,
        url: it.url,
        date: it.date || "",
        period: detail.period || "",
        summary: detail.summary,
        ts: Date.now()
      };

      const message = (record.period ? `[기간] ${record.period}\n` : "") + (record.summary || "");
      chrome.notifications.create(it.id, {
        type: "basic",
        title: record.title,
        message: message.slice(0, 900),
        iconUrl: "icons/icon128.png",
        priority: 2
      }, () => void chrome.runtime.lastError);

      cacheItems.unshift(record);
    }

    const trimmed = cacheItems.slice(0, 50);
    const newIds = items.map(x => x.id).slice(0, 100);
    await chrome.storage.local.set({ lastSeenIds: newIds, cacheItems: trimmed });

    chrome.action.setBadgeBackgroundColor({ color: "#FF5A00" });
    chrome.action.setBadgeText({ text: String(fresh.length) });
  } catch (e) {
    console.error("checkForUpdates failed:", e);
    chrome.action.setBadgeBackgroundColor({ color: "#d00" });
    chrome.action.setBadgeText({ text: "!" });
  }
}

// Set up alarms
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("poll", { periodInMinutes: 15 });
  checkForUpdates();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("poll", { periodInMinutes: 15 });
  checkForUpdates();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "poll") checkForUpdates();
});

chrome.notifications.onClicked.addListener((id) => {
  chrome.storage.local.get(["cacheItems"]).then(({ cacheItems = [] }) => {
    const item = cacheItems.find(x => x.id === id);
    if (item) chrome.tabs.create({ url: item.url });
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "manual-check") {
    checkForUpdates(true).then(() => sendResponse({ ok: true })).catch(err => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
});
