FROM --platform=linux/amd64 ubuntu:24.04 AS build
ARG DEBIAN_FRONTEND=noninteractive
# The development MCP branch and current upstream main diverged before the
# multi-plate export correction. Reconstruct the reviewed clean merge from
# immutable upstream commits and assert both the synthetic commit and tree.
ENV ORCA_MAIN_COMMIT=6b79a61ff323a03f67c5778a00019f6744986389 \
    ORCA_MCP_COMMIT=bff0641b288acc115b5ee8cb36e2f5568b855f28 \
    ORCA_COMMIT=b1b1fb328d66a3f7f48110dd7612f8592179a6d0 \
    ORCA_SOURCE_TREE=14e2e8cd7fec8600577ff4374a44a872a3ec0a66
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git sudo curl python3 file && rm -rf /var/lib/apt/lists/*
# Download and verify packaging tools before the offline packaging step.
RUN mkdir -p /opt/orca-build-assets \
 && curl -fsSL https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage -o /opt/orca-build-assets/appimagetool.AppImage \
 && echo 'e8c1169c4af66c3184d7ee110713d4be04befe671fa358e2c1591ee840553b03  /opt/orca-build-assets/appimagetool.AppImage' | sha256sum -c - \
 && curl -fsSL https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-x86_64 -o /opt/orca-build-assets/runtime-x86_64 \
 && echo '617aa77314d57c8b8e4fae9c3f0b35af7b30d5529cb69e98f64f92510ed98a46  /opt/orca-build-assets/runtime-x86_64' | sha256sum -c -
WORKDIR /opt/orca-source
RUN git init && git remote add origin https://github.com/OrcaSlicer/OrcaSlicer.git \
 && git fetch --depth 600 origin "$ORCA_MAIN_COMMIT" "$ORCA_MCP_COMMIT" \
 && git checkout --detach "$ORCA_MAIN_COMMIT" \
 && git merge --no-ff --no-commit "$ORCA_MCP_COMMIT" \
 && test "$(git write-tree)" = "$ORCA_SOURCE_TREE" \
 && GIT_AUTHOR_NAME='Orca source merger' GIT_AUTHOR_EMAIL='build@invalid.local' GIT_AUTHOR_DATE='2026-11-24T00:00:00Z' GIT_COMMITTER_NAME='Orca source merger' GIT_COMMITTER_EMAIL='build@invalid.local' GIT_COMMITTER_DATE='2026-11-24T00:00:00Z' git commit --no-gpg-sign -m 'Merge OrcaSlicer main 6b79a61 and feature/mcp bff0641 for isolated qualification' \
 && test "$(git rev-parse HEAD)" = "$ORCA_COMMIT" \
 && test "$(git rev-parse HEAD^{tree})" = "$ORCA_SOURCE_TREE"
RUN ./build_linux.sh -u && ./build_linux.sh -dr -j 2
RUN ./build_linux.sh -sr -j 2
# The generated helper computes the repository root from the build directory,
# and its Docker branch modifies the AppImage runtime before extraction.
# Correct these pinned upstream lines and fail if upstream changes them.
RUN python3 - <<'PYCODE'
from pathlib import Path

path = Path("build/build_appimage.sh")
script = path.read_text()
root = 'REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../../.." && pwd)"'
download = 'wget ${APPIMAGETOOLURL} -O ../appimagetool.AppImage'
magic = """if [ -f /.dockerenv ] ; then # Only run if inside of a Docker Container
sed '0,/AI\\x02/{s|AI\\x02|\\x00\\x00\\x00|}' -i  ../appimagetool.AppImage
fi"""
invocation = """if [ -f /.dockerenv ] ; then # Only run if inside of a Docker Container
  ../appimagetool.AppImage --appimage-extract-and-run . $([ -n "${container}" ] && echo '--appimage-extract-and-run')
else
  ../appimagetool.AppImage . $([ -n "${container}" ] && echo '--appimage-extract-and-run')
fi"""
assert all(script.count(part) == 1 for part in (root, download, magic, invocation))
script = script.replace("#!/usr/bin/env bash\n", "#!/usr/bin/env bash\nset -e\n", 1)
script = script.replace(root, "REPO_ROOT=/opt/orca-source")
script = script.replace(download, "cp /opt/orca-build-assets/appimagetool.AppImage ../appimagetool.AppImage\nprintf '%s  %s\\n' e8c1169c4af66c3184d7ee110713d4be04befe671fa358e2c1591ee840553b03 ../appimagetool.AppImage | sha256sum -c -\nprintf '%s  %s\\n' 617aa77314d57c8b8e4fae9c3f0b35af7b30d5529cb69e98f64f92510ed98a46 /opt/orca-build-assets/runtime-x86_64 | sha256sum -c -")
script = script.replace(magic, "# Preserve the AppImage runtime for extract-and-run.")
script = script.replace(invocation, "APPIMAGE_EXTRACT_AND_RUN=1 ../appimagetool.AppImage --runtime-file /opt/orca-build-assets/runtime-x86_64 .")
path.write_text(script)
PYCODE
RUN --network=none ./build_linux.sh -ir -j 2
RUN set -eu; set -- build/OrcaSlicer_Linux_V*.AppImage; test "$#" -eq 1; test -f "$1"; "$1" --appimage-extract; test -x squashfs-root/AppRun
