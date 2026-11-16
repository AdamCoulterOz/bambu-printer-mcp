# Pinned official development branch. AGPL source and executable remain in this
# separate image; no upstream source is incorporated into the printer server.
FROM --platform=linux/amd64 ubuntu:24.04 AS build
ARG DEBIAN_FRONTEND=noninteractive
ENV ORCA_COMMIT=8cccdf82d00381942d9b664750457da318e7d068
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git sudo curl python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/orca-source
RUN git init && git remote add origin https://github.com/OrcaSlicer/OrcaSlicer.git \
 && git fetch --depth 1 origin "$ORCA_COMMIT" && git checkout --detach FETCH_HEAD \
 && test "$(git rev-parse HEAD)" = "$ORCA_COMMIT"
# Upstream's documented Ubuntu dependency and AppImage build. Two compiler
# jobs, one dependency at a time; the exact peak RAM/disk needs must be measured.
RUN ./build_linux.sh -u && ./build_linux.sh -dsir -j 2
RUN set -eu; set -- build/OrcaSlicer_Linux_V*.AppImage; test "$#" -eq 1; test -f "$1"; "$1" --appimage-extract; test -x squashfs-root/AppRun

FROM --platform=linux/amd64 ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends python3 xvfb xauth libgl1-mesa-dri libgl1 libgtk-3-0t64 libwebkit2gtk-4.1-0 ca-certificates dbus-x11 libfuse2t64 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 10001 orca
COPY --from=build /opt/orca-source/squashfs-root/ /opt/orca/
COPY --from=build /opt/orca-source/tools/mcp/ /opt/orca-harness/
COPY --from=build /opt/orca-source/LICENSE.txt /opt/orca-license/LICENSE.txt
COPY gateway.py supervisor.py workspace.py protocol.py orca_backend.py /opt/orca-runtime/
USER 10001:10001
WORKDIR /home/orca
ENV HOME=/home/orca ORCA_MCP_SESSION=/home/orca/.cache/orca-mcp/session.json
CMD ["python3", "/opt/orca-runtime/supervisor.py"]
