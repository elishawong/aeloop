// Conductor Work demo UI controller.
//
// On load (and on refresh) this fetches `/api/state` from server.mjs, which
// serves JSON produced by the real `EvidenceEventProjector` (or a clearly
// labelled static fallback if the projector build artifact isn't present —
// see README.md). If the fetch itself fails (network error, non-200, bad
// JSON), this falls back to the LOCAL_FALLBACK_STATE snapshot below so the
// page never renders blank/broken.
const LOCAL_FALLBACK_STATE = {
  run: { displayStatus: "WAITING FOR G1" },
  timeline: [
    { title: "Run started", detail: "Company Brain froze TaskContract company-demo-001", status: "done", time: "10:02:11" },
    { title: "Coder completed", detail: "2 claims · 1 artifact · 3,420 input tokens", status: "done", time: "10:02:38" },
    { title: "G1 waiting for approval", detail: "Send candidate change to independent Tester", status: "waiting", time: "10:02:39" },
    { title: "Tester pending", detail: "Will receive diff + claims + evidence only", status: "pending", time: "—" },
  ],
  requirements: [
    ["REQ-001", "Approved behavior is implemented", "test:behavior", "VERIFIED"],
    ["REQ-002", "No unrelated public API changes", "policy:path-scope", "VERIFIED"],
    ["REQ-003", "Performance target is proven", "No execution evidence", "NOT_PROVEN"],
  ],
  evidence: [
    ["Changed files", "4", "within allowed paths"],
    ["Tool executions", "7", "exit code captured"],
    ["Token saved", "−34%", "context compression"],
  ],
  usage: { totalTokens: 7820, totalBudget: 20000, cacheHitPct: 61, retryTokens: 0 },
};

let state = LOCAL_FALLBACK_STATE;

function render() {
  timeline.innerHTML = state.timeline
    .map((e) => `<div class="event ${e.status}"><span class="marker"></span><div><strong>${e.title}</strong><p>${e.detail}</p></div><time>${e.time}</time></div>`)
    .join("");
  requirements.innerHTML = state.requirements
    .map((r) => `<tr><td><code>${r[0]}</code></td><td>${r[1]}</td><td>${r[2]}</td><td class="${r[3] === "VERIFIED" ? "verified" : "unproven"}">${r[3]}</td></tr>`)
    .join("");
  evidence.innerHTML = state.evidence.map((e) => `<div><span>${e[0]}</span><strong>${e[1]}</strong><span>${e[2]}</span></div>`).join("");
  status.textContent = state.run?.displayStatus ?? status.textContent;
  renderTokenBudget();
}

// index.html's Token Budget card (3rd `.summary article`) has no element
// ids for its numbers — only server.mjs/app.js are in scope for this
// change, so this selects the existing static markup structurally rather
// than adding ids to index.html.
function renderTokenBudget() {
  const usage = state.usage;
  if (!usage) return;
  const card = document.querySelectorAll(".summary article")[2];
  if (!card) return;
  const totalEl = card.querySelector("strong");
  const barEl = card.querySelector(".bar i");
  const noteEl = card.querySelector("p");
  const totalTokens = usage.totalTokens ?? 0;
  const totalBudget = usage.totalBudget ?? 0;
  if (totalEl) totalEl.textContent = `${totalTokens.toLocaleString("en-US")} / ${totalBudget.toLocaleString("en-US")}`;
  if (barEl && totalBudget > 0) barEl.style.width = `${Math.min(100, Math.round((totalTokens / totalBudget) * 100))}%`;
  if (noteEl) {
    const cacheHitPct = usage.cacheHitPct ?? 0;
    const retryNote = usage.retryTokens ? `retry ${usage.retryTokens} tokens` : "no retries";
    noteEl.textContent = `cache hit ${cacheHitPct}% · ${retryNote}`;
  }
}

async function loadState() {
  try {
    const response = await fetch("/api/state");
    if (!response.ok) throw new Error(`status ${response.status}`);
    const fetched = await response.json();
    state = fetched;
  } catch (error) {
    console.warn("Conductor Work UI: /api/state fetch failed, falling back to local static snapshot.", error);
    state = LOCAL_FALLBACK_STATE;
  }
  render();
}

document.querySelectorAll("[data-decision]").forEach(
  (b) =>
    (b.onclick = () => {
      const approved = b.dataset.decision === "approved";
      // Local-only demo interaction: this updates what the page displays,
      // it does not send any decision to a real conductor run (there is no
      // persisted run behind this page — see README.md).
      note.textContent = approved
        ? "已记录人工批准（本地演示状态，不会更改任何持久化的 run），下一步将发送给 Tester。"
        : "已记录人工拒绝（本地演示状态，不会更改任何持久化的 run），返回 Coder 并要求补充反馈。";
      status.textContent = approved ? "SENDING TO TESTER" : "RETURNING TO CODER";
      const timelineCopy = state.timeline.slice();
      timelineCopy[2] = {
        ...timelineCopy[2],
        title: approved ? "G1 approved" : "G1 rejected",
        detail: approved ? "Human approval recorded · Tester will start" : "Human feedback required before retry",
        status: approved ? "done" : "waiting",
      };
      state = { ...state, timeline: timelineCopy };
      render();
    })
);

refresh.onclick = () => {
  loadState().then(() => {
    note.textContent = "已刷新（重新拉取 /api/state 的 demo fixture 投影结果）。";
  });
};

loadState();
