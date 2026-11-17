# Pinned official development branch. AGPL source and executable remain in this
# separate image; no upstream source is incorporated into the printer server.
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
# Upstream's documented Ubuntu dependency and AppImage build. Two compiler
# jobs, one dependency at a time; the exact peak RAM/disk needs must be measured.
RUN ./build_linux.sh -u && ./build_linux.sh -dr -j 2
RUN ./build_linux.sh -sr -j 2
# Keep this pinned helper correction aligned with build-source.Dockerfile.
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

FROM --platform=linux/amd64 ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends python3 xvfb xauth libgl1-mesa-dri libgl1 libopengl0 libgtk-3-0t64 libwebkit2gtk-4.1-0 ca-certificates dbus-x11 libfuse2t64 locales && rm -rf /var/lib/apt/lists/* \
 && localedef -i en_US -f UTF-8 en_US.UTF-8 \
 && useradd --create-home --uid 10001 orca
ENV LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
COPY --from=build /opt/orca-source/squashfs-root/ /opt/orca/
COPY --from=build /opt/orca-source/tools/mcp/ /opt/orca-harness/
COPY --from=build /opt/orca-source/LICENSE.txt /opt/orca-license/LICENSE.txt
COPY gateway.py supervisor.py workspace.py protocol.py orca_backend.py export_store.py /opt/orca-runtime/
COPY orca-session /opt/orca-runtime/orca-session
RUN chmod 755 /opt/orca-runtime/orca-session && test -x /usr/bin/dbus-run-session && test -x /usr/bin/dbus-daemon && test -x /opt/orca-runtime/orca-session
# The extracted public AppImage can contain root-only directories. Do not follow symlinks.
RUN find -P /opt/orca -type d -exec chmod a+rx {} + \
 && find -P /opt/orca -type f -exec chmod a+rX {} +
USER 10001:10001
# Check the entire public tree using the actual runtime identity.
RUN python3 -c 'import os, stat; root="/opt/orca"; fail=lambda error: (_ for _ in ()).throw(error); [(os.access(p, os.R_OK | (os.X_OK if os.path.isdir(p) or os.lstat(p).st_mode & 0o111 else 0)) or fail(PermissionError(p))) for base, dirs, files in os.walk(root, onerror=fail, followlinks=False) for p in [base] + [os.path.join(base, n) for n in dirs + files] if not os.path.islink(p)]; assert os.access("/opt/orca/AppRun", os.X_OK) and os.access("/opt/orca/libexec/orca-slicer-env", os.X_OK)'
RUN python3 -c 'import ctypes; ctypes.CDLL("libOpenGL.so.0")'
RUN python3 -c 'import locale, os, subprocess; assert os.environ["LANG"] == os.environ["LC_ALL"] == "en_US.UTF-8"; assert any(x.lower().replace("_", "").replace("-", "").replace(".", "") == "enusutf8" for x in subprocess.check_output(["locale", "-a"], text=True).splitlines()); assert locale.setlocale(locale.LC_ALL, ""); assert subprocess.check_output(["locale", "charmap"], text=True).strip().upper() == "UTF-8"'
WORKDIR /home/orca
ENV HOME=/home/orca ORCA_MCP_SESSION=/home/orca/.cache/orca-mcp/session.json
CMD ["python3", "/opt/orca-runtime/supervisor.py"]
