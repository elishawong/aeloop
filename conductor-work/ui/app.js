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

// ---------------------------------------------------------------------------
// issue #2 batch 1 — 多 workflow 总览看板（docs/conductor-mvp/DESIGN.md §3）。
// 轮询 GET /api/runs（2-3s，DESIGN §3.4 方案 A：轮询而非 WebSocket/SSE）。这段代码和上面的
// /api/state 单 run fixture 渲染逻辑完全独立，互不干扰——batch 1 明确不改动上面那段既有代码。
// ---------------------------------------------------------------------------

const BOARD_POLL_INTERVAL_MS = 2500;

function phaseBadgeClass(phase) {
  if (phase === "completed" || phase === "completed_no_change") return "verified";
  if (phase === "cancelled" || phase === "escalated") return "unproven";
  if (phase === "unknown") return "unproven";
  return "";
}

/**
 * 渲染一次成功拉取到的看板数据——只在真的有新数据时调用（`loadBoard()` 的成功分支）。
 * Zorro R1 yellow②修复：拉取失败时**不调用这个函数**（见下方 `loadBoard()`），避免"文案说保留
 * 上次、代码却把表清空"这种文案和行为不一致的情况——真正做到"失败就保留上一次成功渲染的内容"，
 * 不是靠一句话承诺。
 */
function renderBoard(board) {
  const pill = document.getElementById("board-source-pill");
  const rowsEl = document.getElementById("board-rows");
  const messageEl = document.getElementById("board-message");

  pill.style.background = "";
  if (board.source === "live") {
    pill.textContent = "LIVE";
    pill.className = "pill";
  } else {
    pill.textContent = "NO DATA";
    pill.className = "pill blue";
  }

  messageEl.textContent = board.message ?? (board.rows.length === 0 && board.source === "live" ? "当前没有 running/escalated 状态的 workflow。" : "");

  if (board.rows.length === 0) {
    rowsEl.innerHTML = "";
    return;
  }

  rowsEl.innerHTML = board.rows
    .map(
      (row) => `
      <tr>
        <td><code>#${row.runId}</code></td>
        <td class="${phaseBadgeClass(row.phase)}">${escapeHtml(row.phaseLabel)}</td>
        <td>${row.loopCount}</td>
        <td>${row.coderRoundCompleted ? "✓" : "—"}</td>
        <td>${escapeHtml(row.task)}</td>
        <td><time>${escapeHtml(row.updatedAt)}</time></td>
      </tr>`,
    )
    .join("");
}

/**
 * 拉取失败时调用——只更新错误提示条，**不碰 `#board-rows` 这个表格 DOM**（不清空、不重渲染），
 * 这样"保留上一次成功渲染的内容"这句话是代码行为本身保证的，不是靠一个从没被真正兑现的承诺
 * 文案（Zorro R1 yellow②）。
 */
function renderBoardFetchError(message) {
  const pill = document.getElementById("board-source-pill");
  const messageEl = document.getElementById("board-message");
  pill.textContent = "ERROR";
  pill.className = "pill";
  pill.style.background = "var(--red)";
  messageEl.textContent = message;
}

// `row.task`/`row.phaseLabel` 最终来自 TaskContract.objective / 一个固定的枚举标签集合（server.mjs
// 的 phaseLabelFor()），不是任意用户输入——但 objective 文本理论上可以包含任何字符（意图文本经
// translateIntent() 原样拼接），插进 innerHTML 前统一转义，不假设"这来源可信所以不用转义"。
function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = String(value ?? "");
  return div.innerHTML;
}

async function loadBoard() {
  try {
    const response = await fetch("/api/runs");
    if (!response.ok) throw new Error(`status ${response.status}`);
    const board = await response.json();
    renderBoard(board);
  } catch (error) {
    console.warn("Conductor Work UI: /api/runs fetch failed.", error);
    renderBoardFetchError("看板拉取失败（网络/服务端异常），下方列表保留上一次成功渲染的内容。");
  }
}

loadBoard();
setInterval(loadBoard, BOARD_POLL_INTERVAL_MS);
