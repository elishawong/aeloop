# Conductor Work visual demo

Zero-dependency local UI for the company workflow. It displays the concepts
that must remain visible to a company user: LoopEvent timeline, human gates,
requirement coverage, EvidenceBundle, policy status, and token savings.

```bash
node conductor-work/ui/server.mjs
```

Open `http://127.0.0.1:4173`.

The current UI uses a deterministic local event snapshot. The next adapter can
replace the snapshot with the `EvidenceEventProjector` output without changing
the page structure.
