---
name: 3d-printing
description: Prepare, slice, inspect, troubleshoot, or operate an FDM 3D printer using connected printer and slicer services, including OrcaSlicer.
---

# 3D printing

## Reference map

- [Printer and slicer workflow](references/workflow.md): discovery, status, filament assignment, shared workspaces, file transfer, slicing and authorized printing. Read for connected-service work.
- [FDM print quality](references/quality.md): geometry-specific slicing, toolpath inspection, variant comparison and defect diagnosis. Read when quality, strength or slicing tradeoffs matter.
- [Advanced OrcaSlicer guide](references/orca/guide.md): tool operation, settings, scene, jobs and links to detailed task references. Read for Orca-specific operations. [Source and license](references/orca/SOURCE.txt), [AGPL license](references/orca/LICENSE).

Discover the active tools and schemas; connector names, endpoints, available operations and versions differ across hosts. A skill supplies guidance, not connections or authorization. Read the applicable reference before acting, and preserve the user's existing models, workspaces and presets.

When several printers are available, list them with `list_configured_printers`, use the one the person names (ask if unclear), pass it as `printer` on every printer tool, and select its matching machine preset in the slicer. See [Choose the printer](references/workflow.md#choose-the-printer).

Use compact fresh printer status for monitoring or current identity when the schema supports `get_printer_status({fresh:true, detail:"compact"})`; use `detail:"full"` for needed diagnostics. Older deployments may not offer `detail`: inspect their schema and use supported fresh status, requesting full details only when that evidence is needed. Fresh status does not replace the current printer preflight. Readiness is configuration evidence, not live or physical readiness.

Preparation, inspection, export and slicing do not authorize a physical print. When the user requests printing, follow the connected printer's current inspection and preflight rules and exact artifact and feed mapping. Never automatically replay an uncertain dispatch. Report preparation, dispatch, observed progress, final physical quality and fit separately.
