"""Authenticated fixed-upstream ASGI gateway.

The deployment wrapper owns TLS and external routing. This process only accepts
an authenticated request for one protected resource, then substitutes the
private backend bearer for a fixed loopback or Unix-socket upstream.
"""
from collections.abc import AsyncIterator
import base64
import json
import math
import os
import time
from pathlib import PurePosixPath
from urllib.parse import urlsplit

import httpx2
from fastmcp.server.auth.middleware import RequireAuthMiddleware
from mcp.server.auth.middleware.bearer_auth import AuthenticatedUser
from pydantic import AnyHttpUrl
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.responses import PlainTextResponse
from starlette.routing import Route

RESOURCE_PATH = "/3d-printing"
HOP = {b"connection", b"keep-alive", b"proxy-authenticate", b"proxy-authorization", b"te", b"trailer", b"transfer-encoding", b"upgrade"}
REQUEST_ALLOWED = {b"accept", b"content-type", b"content-length", b"content-encoding", b"cache-control", b"last-event-id", b"user-agent", b"mcp-protocol-version", b"mcp-session-id", b"mcp-method", b"mcp-name"}


def clean_headers(headers, *, response=False):
    connection = set()
    for name, value in headers:
        if name.lower() == b"connection":
            connection.update(part.strip().lower() for part in value.split(b","))
    out = []
    for name, value in headers:
        low = name.lower()
        if low in HOP or low in connection or (response and low == b"set-cookie"):
            continue
        if not response and low not in REQUEST_ALLOWED:
            continue
        out.append((name, value))
    return out


def create_app(provider, *, backend_url, backend_bearer, tenant_id, user_oid,
               public_origin, trusted_host, transport=None,
               resource_path=RESOURCE_PATH, required_scope="mcp_access",
               uds_path=None, backend_path=None):
    """Create one resource gateway; callers own provider configuration."""
    parsed = urlsplit(backend_url)
    if (parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or
            parsed.username is not None or parsed.password is not None or
            parsed.path != (backend_path or resource_path) or parsed.query or parsed.fragment):
        raise ValueError("backend must be the fixed loopback MCP endpoint")
    origin = urlsplit(public_origin)
    if (origin.scheme != "https" or not origin.hostname or origin.username or
            origin.password or origin.path not in ("", "/") or origin.query or origin.fragment):
        raise ValueError("public origin must be a bare HTTPS origin")
    if origin.hostname != trusted_host:
        raise ValueError("trusted host must match the public origin")
    if uds_path is not None:
        path = PurePosixPath(uds_path)
        if (not path.is_absolute() or ".." in path.parts or str(path) != uds_path or
                path.name == "docker.sock" or os.path.realpath(uds_path) != uds_path):
            raise ValueError("socket path must be an absolute, canonical non-Docker socket path")
    if not backend_bearer or not tenant_id or not user_oid:
        raise ValueError("backend bearer and immutable allowlist are required")

    async def proxy(scope, receive, send):
        headers = scope.get("headers", [])
        origins = [value for name, value in headers if name.lower() == b"origin"]
        expected_origin = public_origin.encode("ascii")
        if len(origins) > 1 or (origins and origins[0] != expected_origin):
            await PlainTextResponse("Forbidden origin", status_code=403)(scope, receive, send)
            return
        if sum(name.lower() == b"authorization" for name, _ in headers) != 1:
            await PlainTextResponse("Invalid authorization", status_code=401)(scope, receive, send)
            return
        user = scope.get("user")
        if not isinstance(user, AuthenticatedUser):
            await PlainTextResponse("Unauthorized", status_code=401)(scope, receive, send)
            return
        claims = user.access_token.claims
        if claims.get("tid") != tenant_id or claims.get("oid") != user_oid:
            await PlainTextResponse("Forbidden", status_code=403)(scope, receive, send)
            return
        now = time.time()
        def future(value):
            return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > now
        if not future(user.access_token.expires_at) or not future(claims.get("exp")):
            await PlainTextResponse("Expired or missing expiration", status_code=401)(scope, receive, send)
            return
        try:
            raw = next(value for name, value in headers if name.lower() == b"authorization")
            scheme, token = raw.split(b" ", 1)
            if scheme.lower() != b"bearer" or len(token) > 16384:
                raise ValueError("invalid bearer")
            parts = token.split(b".")
            if len(parts) != 3:
                raise ValueError("invalid JWT")
            payload = json.loads(base64.b64decode(parts[1] + b"=" * (-len(parts[1]) % 4), altchars=b"-_", validate=True))
            if not isinstance(payload, dict) or not future(payload.get("exp")):
                raise ValueError("missing or invalid JWT expiration")
        except (ValueError, TypeError, KeyError):
            await PlainTextResponse("Expired or missing expiration", status_code=401)(scope, receive, send)
            return

        async def body() -> AsyncIterator[bytes]:
            while True:
                event = await receive()
                if event["type"] == "http.disconnect":
                    return
                if event["type"] != "http.request":
                    continue
                if event.get("body"):
                    yield event["body"]
                if not event.get("more_body", False):
                    return

        outbound_headers = clean_headers(headers)
        outbound_headers.extend(((b"authorization", ("Bearer " + backend_bearer).encode("ascii")),
                                 (b"host", trusted_host.encode("ascii"))))
        target = backend_url + (("?" + scope["query_string"].decode("ascii")) if scope["query_string"] else "")
        request_transport = transport
        if uds_path is not None and transport is None:
            request_transport = httpx2.AsyncHTTPTransport(uds=uds_path, retries=0, trust_env=False)
        response_started = False
        try:
            async with httpx2.AsyncClient(transport=request_transport, trust_env=False, follow_redirects=False, timeout=None) as client:
                async with client.stream(scope["method"], target, headers=outbound_headers, content=body()) as result:
                    await send({"type": "http.response.start", "status": result.status_code, "headers": clean_headers(result.headers.raw, response=True)})
                    response_started = True
                    async for chunk in result.aiter_raw():
                        await send({"type": "http.response.body", "body": chunk, "more_body": True})
                    await send({"type": "http.response.body", "body": b"", "more_body": False})
        except (httpx2.ConnectError, OSError):
            if uds_path is None or response_started:
                raise
            await PlainTextResponse("Backend unavailable", status_code=503)(scope, receive, send)

    metadata = AnyHttpUrl(public_origin + "/.well-known/oauth-protected-resource" + resource_path)
    endpoint = RequireAuthMiddleware(proxy, [required_scope], metadata)
    routes = provider.get_routes(resource_path) + [Route(resource_path, endpoint=endpoint, methods=["GET", "POST", "DELETE"])]
    app = Starlette(routes=routes, middleware=[Middleware(TrustedHostMiddleware, allowed_hosts=[trusted_host]), *provider.get_middleware()])
    app.router.redirect_slashes = False
    return app
