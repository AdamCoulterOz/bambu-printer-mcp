FROM --platform=linux/amd64 ubuntu:24.04 AS build
ARG DEBIAN_FRONTEND=noninteractive
ENV ORCA_COMMIT=8cccdf82d00381942d9b664750457da318e7d068
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git sudo curl python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/orca-source
RUN git init && git remote add origin https://github.com/OrcaSlicer/OrcaSlicer.git \
 && git fetch --depth 1 origin "$ORCA_COMMIT" && git checkout --detach FETCH_HEAD \
 && test "$(git rev-parse HEAD)" = "$ORCA_COMMIT"
RUN ./build_linux.sh -u && ./build_linux.sh -dsir -j 2
RUN set -eu; set -- build/OrcaSlicer_Linux_V*.AppImage; test "$#" -eq 1; test -f "$1"; "$1" --appimage-extract; test -x squashfs-root/AppRun
