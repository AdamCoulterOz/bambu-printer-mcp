"""Printer-resource runtime factory. Values come only from deployment secrets."""
import os
import stat
from pathlib import Path
from urllib.parse import urlsplit
from uuid import UUID

from cryptography.fernet import Fernet
from fastmcp.server.auth.providers.azure import AzureProvider
from key_value.aio.stores.filetree import FileTreeStore
from key_value.aio.wrappers.encryption import FernetEncryptionWrapper

from bridge import create_app


def read_private(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError("secret must be an owner-only regular file owned by runtime UID")
        value = os.read(fd, 4097)
        if not value or len(value) > 4096 or any(char in b" \t\r\n" for char in value):
            raise ValueError("secret must be one nonempty token <=4096 bytes")
        return value
    finally:
        os.close(fd)


def environment():
    origin = os.environ["MCP_PUBLIC_ORIGIN"].rstrip("/")
    parsed = urlsplit(origin)
    if parsed.scheme != "https" or not parsed.hostname or parsed.port is not None:
        raise ValueError("MCP_PUBLIC_ORIGIN must be a bare standard-port HTTPS origin")
    host = os.environ["MCP_TRUSTED_HOST"]
    if parsed.hostname != host:
        raise ValueError("MCP_TRUSTED_HOST must equal MCP_PUBLIC_ORIGIN host")
    return (str(UUID(os.environ["MCP_TENANT_ID"])), origin, host,
            str(UUID(os.environ["MCP_ENTRA_CLIENT_ID"])), str(UUID(os.environ["MCP_ALLOWED_OID"])))


def encrypted_store(directory_name, storage_key):
    directory = Path(directory_name)
    info = directory.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("state directory must be owner-only and owned by runtime UID")
    return FernetEncryptionWrapper(key_value=FileTreeStore(data_directory=directory), fernet=Fernet(storage_key), raise_on_decryption_error=True)


def app():
    tenant, origin, host, client_id, oid = environment()
    secret = read_private(os.environ["MCP_ENTRA_SECRET_FILE"]).decode("ascii")
    jwt_key = read_private(os.environ["MCP_JWT_KEY_FILE"])
    if len(jwt_key) < 32:
        raise ValueError("JWT key is too short")
    store = encrypted_store(os.environ["MCP_STATE_DIR"], read_private(os.environ["MCP_STORAGE_KEY_FILE"]))
    backend = read_private(os.environ["MCP_BACKEND_TOKEN_FILE"]).decode("ascii")
    provider = AzureProvider(client_id=client_id, client_secret=secret, tenant_id=tenant,
                             required_scopes=["mcp_access"], base_url=origin,
                             jwt_signing_key=jwt_key, client_storage=store,
                             require_authorization_consent=True, enable_cimd=False,
                             fastmcp_access_token_expiry_seconds=900,
                             allowed_client_redirect_uris=["https://chatgpt.com/connector_platform_oauth_redirect", "http://127.0.0.1/callback", "http://localhost/callback", "https://claude.ai/api/mcp/auth_callback"])
    return create_app(provider, backend_url=os.environ["MCP_PRINTER_BACKEND_URL"],
                      backend_bearer=backend, tenant_id=tenant, user_oid=oid,
                      public_origin=origin, trusted_host=host)
