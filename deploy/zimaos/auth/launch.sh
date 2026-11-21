#!/bin/sh
# Environment is injected by the service manager. Do not read a host .env here.
set -eu

for name in MCP_PUBLIC_ORIGIN MCP_TRUSTED_HOST MCP_TENANT_ID MCP_ENTRA_CLIENT_ID \
    MCP_ALLOWED_OID MCP_ENTRA_SECRET_FILE MCP_JWT_KEY_FILE \
    MCP_STORAGE_KEY_FILE MCP_BACKEND_TOKEN_FILE MCP_STATE_DIR \
    MCP_PRINTER_BACKEND_URL SLICER_JWT_KEY_FILE SLICER_STORAGE_KEY_FILE \
    SLICER_BACKEND_TOKEN_FILE SLICER_STATE_DIR SLICER_SOCKET_PATH \
    SLICER_BACKEND_PATH; do
    eval "value=\${$name-}"
    [ -n "$value" ] || { echo "$name is required" >&2; exit 64; }
done

exec "$@"
