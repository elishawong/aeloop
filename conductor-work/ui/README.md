# Conductor Work visual demo

Zero-dependency local UI for the company workflow. It displays the concepts
that must remain visible to a company user: LoopEvent timeline, human gates,
requirement coverage, EvidenceBundle, policy status, and token savings.

```bash
node conductor-work/ui/server.mjs
```

Open `http://127.0.0.1:4173`.

## Where the data comes from (demo fixture stage, not production)

This is a **demo fixture stage**, not a connection to any real, running
conductor. `server.mjs` hardcodes a small, type-legal `LoopEvent[]` array
(`src/loop/events.ts` shapes) at module scope and feeds it, once at process
start, through the real `EvidenceEventProjector` /
`EvidenceBundleBuilder`/`TokenBudgetLedger` classes (`src/evidence/bundle.ts`,
compiled to `dist/evidence/bundle.js`). The JSON served at `GET /api/state`
is therefore a genuine projector *output* computed from that fixture — not a
hand-authored object shaped to look like one.

Run `pnpm run build` at the repo root first so `dist/evidence/bundle.js`
exists. If it doesn't (fresh checkout, no build yet), `server.mjs` catches
the missing-module error and serves a clearly-labelled static fallback
snapshot instead (`source: "static-fallback"` in the JSON) so the page still
renders — but that fallback is hand-authored copy, not projector output.
`source: "projector"` in the `/api/state` response tells you which one you
are looking at.

**What is still demo/not-yet-wired**: the *event stream itself*. A future
iteration should replace `FIXTURE_EVENTS` in `server.mjs` with the real
`LoopEvent` stream emitted by a live conductor run (`runner.ts`'s
`LoopEventEmitter`, or `ConductorWorkApp.projectEvents()` once a real
`brains/company` + `TaskContract` + workflow registry are wired up end to
end) — that adapter swap should not require changing `index.html`'s
structure, since `app.js` already renders whatever shape `/api/state`
returns.

The human-gate buttons (`Approve`/`Reject`) only mutate what this page
displays locally — they do not send a decision to any persisted run.

Everything else in this file is documentation, not UI copy — the existing
Chinese UI labels in `index.html`/`app.js` are left as-is.
