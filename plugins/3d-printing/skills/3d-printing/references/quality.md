# FDM print quality engineering

Use this guidance alongside the actual slicer's available tools and printer workflow. It adds engineering judgment, not a tool catalog. Check the active printer and available capabilities; do not assume a particular model, endpoint, preset or feature is available. A slice is not proof of a successful print or a mechanically adequate part.

## Evidence and comparisons

- Preserve the original model and project. Identify the exact model/revision and hash, printer, nozzle, material/spool if known, slicer version and source of machine, filament and process presets. Record unknowns rather than invent profiles, calibration, drying or prior results. Use separate copies/outputs and do not discard unsaved work automatically.
- Inspect the actual slice, G-code/toolpaths and relevant layer preview when available, especially the reported defect's location and adjacent layers. Quantify useful facts where available: extrusion segment lengths and distribution, short isolated paths, travel/retraction counts and placement, extrusion/flow and layer transitions. State units, thresholds, sampling limits and how they were obtained. Distinguish direct measurements and visible geometry from hypotheses about pressure recovery, adhesion or strength; toolpaths alone do not establish physical outcomes.
- Establish a baseline and compare a small number of targeted variants, changing as few variables as practical. Keep the same input, orientation, printer, material, preset and slicer version except for the deliberate changes; snapshot the settings and record hashes of the inputs and outputs. Review the affected geometry and any lost detail, coverage, time and material tradeoffs, not just aggregate metrics. Stop if the slice or assumptions cannot be verified.
- Report the evidence, changes, affected layers/regions, tradeoffs and uncertainty; distinguish measured, visually observed and inferred claims. Recommend physical tests for hypotheses needing them, and record only actual outcomes tied to the specific spool, part revision, settings and printer. Do not imply a printed part was validated when it has not been.

## Targeted diagnosis

- For tiny gap-fill or disconnected short extrusions with repeated retracts and travels, inspect those sequences and the immediately following structural layers. They can be associated with pressure recovery problems, but the actual nozzle pressure is not measured by G-code. Compare Classic and Arachne when supported, and assess line width and minimum wall length in the context of the specific nozzle and geometry. Values such as 0.48–0.5 mm or 2 mm are examples, not defaults. Removing small features can remove needed detail or wall coverage.
- For ironing followed by structural extrusion, inspect transition paths, flow and speed. Compare bounded flow/speed adjustments and resulting surface and structural geometry; do not claim a strength improvement without physical testing. Consider smooth-timelapse priming only when behavior is confirmed for the exact printer and configuration; do not toggle it as a blanket remedy.
- For TPU, examine continuity and retraction/travel sequences, and compare suitable alternatives such as concentric solid infill against the actual geometry. Preserve coverage and intended mechanical behavior; minimizing retraction alone is not proof of improved quality.

## Execution boundary

Slicing and inspection do not authorize printing, changing printer modes, or overwriting a user's model or presets. Use the existing printer MCP as the sole dispatch path, with its current preflight and authorization checks. Never bypass its deterministic safety validator. Report slice preparation, dispatch, first-layer observation, final quality and fit as separate evidence stages.
