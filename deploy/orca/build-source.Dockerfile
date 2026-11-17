FROM --platform=linux/amd64 ubuntu:24.04 AS build
ARG DEBIAN_FRONTEND=noninteractive
ENV ORCA_COMMIT=8cccdf82d00381942d9b664750457da318e7d068
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git sudo curl python3 file && rm -rf /var/lib/apt/lists/*
# Download and verify packaging tools before the offline packaging step.
RUN mkdir -p /opt/orca-build-assets \
 && curl -fsSL https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage -o /opt/orca-build-assets/appimagetool.AppImage \
 && echo 'e8c1169c4af66c3184d7ee110713d4be04befe671fa358e2c1591ee840553b03  /opt/orca-build-assets/appimagetool.AppImage' | sha256sum -c - \
 && curl -fsSL https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-x86_64 -o /opt/orca-build-assets/runtime-x86_64 \
 && echo '617aa77314d57c8b8e4fae9c3f0b35af7b30d5529cb69e98f64f92510ed98a46  /opt/orca-build-assets/runtime-x86_64' | sha256sum -c -
WORKDIR /opt/orca-source
RUN git init && git remote add origin https://github.com/OrcaSlicer/OrcaSlicer.git \
 && git fetch --depth 1 origin "$ORCA_COMMIT" && git checkout --detach FETCH_HEAD \
 && test "$(git rev-parse HEAD)" = "$ORCA_COMMIT"
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
