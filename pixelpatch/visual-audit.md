# Trace Compare visual audit

## Final pass

- Reference: `pixelpatch/reference.png` (direct product screenshot).
- Runtime screenshot: `.playwright-cli/compare-trajectory-type-scale.png`.
- Layout: passed at the 1448×1086 desktop viewport. The four-card analysis row is stretch-aligned at 254px; the Reliability table and Context Efficiency metric grid absorb the shared row height without empty card space.
- Summary metrics: passed. Four real column borders extend through the aligned result footer; each metric uses fixed A, B, delta and Better grid areas.
- Typography: passed. Trace Compare now uses the Activity / Trajectory reading scale: 12px body, 11px controls, 10px tables and time labels, and 14px section titles.
- Data visualization: passed. Context uses stacked bars; trajectory uses deterministic SVG/DOM lanes and markers; no generated image assets are used.
- Semantics: passed. The summary uses `Trade-off` rather than a single score; validity exposes same/different/unknown dimensions and confidence; missing cost remains `—`.
- Interaction: passed by browser smoke check. Optimization target buttons are wired, session selectors remain native controls, and trajectory navigation remains available.
- Full trace: passed by browser smoke check. `查看完整 Trace` opens the existing Activity `TrajectoryView` in a native modal at full viewport scale; Escape closes it. Runtime screenshot: `.playwright-cli/compare-full-trace-dialog.png`.
- Responsive: existing 1180px and 760px fallbacks remain in place; the four-card and recommendation grids collapse for narrow screens.

## Known scope

The page uses the currently available comparison API data. It does not add backend trace deep-linking or new cost attribution fields; those remain explicit empty states until the source API provides them.
