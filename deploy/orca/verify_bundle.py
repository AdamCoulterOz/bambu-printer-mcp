"""Fail closed unless every regular bundle file is covered by its manifest."""
import hashlib
import os
import re
from pathlib import Path
root=Path('/bundle')
seen={}
for line in (root/'SHA256SUMS').read_text().splitlines():
    match=re.fullmatch(r'([0-9a-fA-F]{64}) [ *](.+)',line)
    if not match: raise SystemExit('invalid SHA256SUMS line')
    raw=match.group(2)
    while raw.startswith('./'): raw=raw[2:]
    path=Path(raw)
    if path.is_absolute() or '..' in path.parts or not path.parts or raw=='SHA256SUMS' or raw in seen: raise SystemExit('invalid manifest path')
    item=root/path
    if item.is_symlink() or not item.is_file() or root.resolve() not in item.resolve().parents: raise SystemExit('invalid manifest file')
    digest=hashlib.sha256()
    with item.open('rb') as f:
        for block in iter(lambda:f.read(1024*1024),b''): digest.update(block)
    if digest.hexdigest()!=match.group(1).lower(): raise SystemExit('bundle digest mismatch')
    seen[raw]=True
actual=set()
for directory,dirs,files in os.walk(root,followlinks=False):
    for name in dirs+files:
        item=Path(directory)/name
        if item.is_symlink(): raise SystemExit('bundle symlink refused')
        if item.is_file() and item.relative_to(root).as_posix()!='SHA256SUMS': actual.add(item.relative_to(root).as_posix())
if actual != set(seen): raise SystemExit('bundle contains unmanifested or missing files')
