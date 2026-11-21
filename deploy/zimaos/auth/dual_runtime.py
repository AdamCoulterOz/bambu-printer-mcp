"""Independent printer and slicer protected-resource factory."""
import os

from cryptography.fernet import Fernet
from fastmcp.server.auth.providers.azure import AzureProvider
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.routing import Mount, Route

import runtime
from bridge import create_app

SLICER_PATH = "/3d-printing/slicer"
SLICER_AUTH = "/slicer-auth"


def compose(printer_app, slicer_provider, *, socket_path, backend_path, backend_bearer,
            tenant, oid, public_origin, trusted_host, transport=None):
    if backend_path != SLICER_PATH:
        raise ValueError("slicer backend path is not an approved fixed path")
    slicer_app = create_app(slicer_provider, backend_url="http://127.0.0.1" + backend_path,
                            backend_bearer=backend_bearer, tenant_id=tenant, user_oid=oid,
                            public_origin=public_origin, trusted_host=trusted_host,
                            transport=transport, resource_path=SLICER_PATH,
                            required_scope="slicer_access", uds_path=socket_path,
                            backend_path=backend_path)
    routes = slicer_provider.get_routes(SLICER_PATH)
    well_known = slicer_provider.get_well_known_routes(SLICER_PATH)
    allowed = {"/.well-known/oauth-authorization-server/slicer-auth",
               "/.well-known/openid-configuration/slicer-auth",
               "/.well-known/oauth-protected-resource/3d-printing/slicer"}
    app = Starlette(routes=[*(route for route in well_known if route.path in allowed),
                            Mount(SLICER_AUTH, routes=[route for route in routes if not route.path.startswith("/.well-known/")]),
                            Route(SLICER_PATH, endpoint=slicer_app, methods=["GET", "POST", "DELETE"]),
                            Mount("/", app=printer_app)],
                    middleware=[Middleware(TrustedHostMiddleware, allowed_hosts=[trusted_host])])
    app.router.redirect_slashes = False
    return app


def app():
    printer_app = runtime.app()
    tenant, origin, host, client_id, oid = runtime.environment()
    secret = runtime.read_private(os.environ["MCP_ENTRA_SECRET_FILE"]).decode("ascii")
    jwt_key = runtime.read_private(os.environ["SLICER_JWT_KEY_FILE"])
    storage_key = runtime.read_private(os.environ["SLICER_STORAGE_KEY_FILE"])
    backend = runtime.read_private(os.environ["SLICER_BACKEND_TOKEN_FILE"]).decode("ascii")
    if len(jwt_key) < 32 or jwt_key == runtime.read_private(os.environ["MCP_JWT_KEY_FILE"]):
        raise ValueError("slicer JWT key must be independent and sufficiently long")
    if (storage_key == runtime.read_private(os.environ["MCP_STORAGE_KEY_FILE"]) or
            backend == runtime.read_private(os.environ["MCP_BACKEND_TOKEN_FILE"]).decode("ascii")):
        raise ValueError("slicer encryption key and backend bearer must be independent")
    store = runtime.encrypted_store(os.environ["SLICER_STATE_DIR"], storage_key)
    provider = AzureProvider(client_id=client_id, client_secret=secret, tenant_id=tenant,
                             required_scopes=["slicer_access"], base_url=origin + SLICER_AUTH,
                             resource_base_url=origin, client_storage=store,
                             jwt_signing_key=jwt_key, require_authorization_consent=True,
                             enable_cimd=False, fastmcp_access_token_expiry_seconds=900,
                             allowed_client_redirect_uris=["https://chatgpt.com/connector_platform_oauth_redirect", "http://127.0.0.1/callback", "http://localhost/callback", "https://claude.ai/api/mcp/auth_callback"])
    return compose(printer_app, provider, socket_path=os.environ["SLICER_SOCKET_PATH"],
                   backend_path=os.environ["SLICER_BACKEND_PATH"], backend_bearer=backend,
                   tenant=tenant, oid=oid, public_origin=origin, trusted_host=host)
