# 3D Printing plugin checkpoint

This is the repository checkpoint of the private **3D Printing** plugin release
`0.1.2`. It provides the `3d-printing` skill and portable/legacy MCP manifests.
The skill is guidance only: it neither supplies credentials nor authorizes a
print.

## Install

Use this directory as the canonical package. For a Claude skill installation,
install or copy only `skills/3d-printing/` into the Claude skills location
configured by that client; do not create a second edited copy of the skill.

Before enabling either MCP manifest, make one hostname substitution: replace
every `YOUR_MCP_HOST` with the trusted HTTPS host that serves this deployment.
Keep the `/3d-printing` and `/3d-printing/slicer` paths unchanged. `mcp.json`
is the portable manifest; `.mcp.json` is the legacy compatibility manifest.
Both retain OAuth DCR configuration and scope names, but contain no tokens,
client secrets, private IDs, or local-machine paths.

## Contents and provenance

The plugin source snapshot contained 26 files. This checkpoint keeps the same
skill text, icon, manifests, and Orca reference material, with the endpoint
hostname replaced by the installation template above. The optional author
contact email was redacted from the two package manifests; attribution remains.
The manifests keep their synchronized `3d-printing` identity and `0.1.2`
version.

`skills/3d-printing/references/orca/` is retained as third-party Orca reference
material. Its `SOURCE.txt` records upstream provenance and its `LICENSE` is
AGPL-3.0; that license applies to that reference material, independently of
this repository's GPL-2.0-only source code. The preserved provenance text is
historical attribution, not a claim about the checkpoint's current hosting.
