
async function load() {
  const { cacheItems = [] } = await chrome.storage.local.get(["cacheItems"]);
  const list = document.getElementById("list");
  list.innerHTML = "";
  if (cacheItems.length === 0) {
    list.innerHTML = `<div class="empty">아직 저장된 공고가 없습니다.<br/>오른쪽 상단의 '새로고침'을 눌러 수동으로 확인할 수 있어요.</div>`;
    return;
  }
  for (const it of cacheItems.slice(0, 15)) {
    const div = document.createElement("div");
    div.className = "item";
    const date = it.date ? `등록일 ${it.date}` : "";
    const period = it.period ? `기간 ${it.period}` : "";
    const ts = new Date(it.ts || Date.now());
    const time = ts.toLocaleString();
    div.innerHTML = `
      <h3>${it.title}</h3>
      <div class="meta">${[date, period, time].filter(Boolean).join(" · ")}</div>
      <div class="summary">${(it.summary || "").replace(/</g, "&lt;")}</div>
      <a class="link" href="${it.url}" target="_blank" rel="noopener">원문 열기</a>
    `;
    list.appendChild(div);
  }
}

document.getElementById("refresh").addEventListener("click", async () => {
  const btn = document.getElementById("refresh");
  const old = btn.textContent;
  btn.textContent = "확인 중…";
  btn.disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: "manual-check" });
  } catch (e) {
    console.error(e);
  } finally {
    await load();
    btn.textContent = old;
    btn.disabled = false;
  }
});

load();
