#!/usr/bin/env bash
set -Eeuo pipefail

# Never reclaim disk or perform this expensive build on a user's machine.
if [[ "${GITHUB_ACTIONS:-}" != true || "${RUNNER_ENVIRONMENT:-}" != github-hosted || "${RUNNER_OS:-}" != Linux || "${RUNNER_ARCH:-}" != X64 ]]; then
  echo 'This build requires a disposable GitHub-hosted Linux x64 Actions runner.' >&2
  exit 1
fi
readonly orca_commit=8cccdf82d00381942d9b664750457da318e7d068
readonly limit_bytes=$((500 * 1024 * 1024))
readonly out="$GITHUB_WORKSPACE/orca-artifact"
readonly temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT
printf 'Disk before reclaim:\n'
df -h / "$GITHUB_WORKSPACE"
# GitHub-hosted runners are fresh VMs. Remove only preinstalled SDKs irrelevant
# to this C++ build, leaving Docker and the Actions runtime intact.
sudo rm -rf /usr/local/lib/android /usr/share/dotnet /opt/ghc /usr/local/share/boost
printf 'Disk after reclaim:\n'
df -h / "$GITHUB_WORKSPACE"
free -h

# A minimal build-only Dockerfile avoids coupling CI to runtime image changes.
# It follows the same pinned upstream build recipe as the runtime Dockerfile.

docker build --platform linux/amd64 --target build --tag orca-pinned-ci:local --file "$GITHUB_WORKSPACE/deploy/orca/build-source.Dockerfile" "$temp_dir"
# Check the uncompressed payload before copying or uploading it. The build
# image and its dependency tree are deliberately excluded from the artifact.
docker run --rm --entrypoint /bin/bash orca-pinned-ci:local -c '
  set -euo pipefail
  cd /opt/orca-source
  set -- build/OrcaSlicer_Linux_V*.AppImage
  test "$#" -eq 1 && test -f "$1" && test -d tools/mcp && test -f LICENSE.txt
  bytes=$(du -sb "$1" tools/mcp LICENSE.txt | awk "{sum += \$1} END {print sum}")
  printf "Payload bytes: %s\n" "$bytes"
  test "$bytes" -le 524288000
'
mkdir -p "$temp_dir/payload" "$out"
docker run --rm --entrypoint /bin/bash orca-pinned-ci:local -c '
  set -euo pipefail
  cd /opt/orca-source
  tar -cf - build/OrcaSlicer_Linux_V*.AppImage tools/mcp LICENSE.txt
' | tar -xf - -C "$temp_dir/payload"
printf '%s\n' "$orca_commit" > "$temp_dir/payload/ORCA_COMMIT"
printf '%s\n' "${GITHUB_SHA:?}" > "$temp_dir/payload/BUILD_REPOSITORY_COMMIT"
(
  cd "$temp_dir/payload"
  find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS
  sha256sum -c SHA256SUMS
  tar -czf "$out/orca-dev-linux-amd64.tar.gz" .
)
size=$(stat -c %s "$out/orca-dev-linux-amd64.tar.gz")
printf 'Compressed artifact bytes: %s\n' "$size"
if (( size > limit_bytes )); then
  rm -f "$out/orca-dev-linux-amd64.tar.gz"
  echo 'Artifact exceeds 500 MiB; refusing upload.' >&2
  exit 1
fi
(cd "$out" && sha256sum orca-dev-linux-amd64.tar.gz > orca-dev-linux-amd64.tar.gz.sha256)
printf 'Final disk usage:\n'
df -h / "$GITHUB_WORKSPACE"
