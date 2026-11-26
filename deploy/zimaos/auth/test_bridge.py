"""Isolated checks for the public one-use workspace-upload capability route.

Run inside the pinned gateway environment:
  python3 -m unittest -v test_bridge.py
"""
import os
import unittest

import httpx2

from bridge import MAX_CAPABILITY_CONTENT_LENGTH, create_app


CAPABILITY = "A" * 43


class Provider:
    def get_routes(self, _resource_path):
        return []

    def get_middleware(self):
        return []


class RecordingTransport(httpx2.AsyncBaseTransport):
    def __init__(self, failure=None):
        self.failure = failure
        self.requests = []

    async def handle_async_request(self, request):
        if self.failure:
            raise self.failure
        body = b"".join([chunk async for chunk in request.stream])
        self.requests.append((request, body))
        return httpx2.Response(201, headers={"cache-control": "public, max-age=1"},
                               stream=httpx2.ByteStream(b"accepted"), request=request)


def app(transport):
    return create_app(Provider(), backend_url="http://127.0.0.1:8189/3d-printing",
                      backend_bearer="private-backend-token", tenant_id="tenant", user_oid="operator",
                      public_origin="https://mcp.example.test", trusted_host="mcp.example.test",
                      transport=transport)


class CapabilityRouteTests(unittest.IsolatedAsyncioTestCase):
    async def request(self, application, method, path, *, headers=None, content=b""):
        async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=application),
                                      base_url="https://mcp.example.test") as client:
            return await client.request(method, path, headers=headers, content=content)

    async def test_legacy_runtime_uses_only_configured_public_origin(self):
        old_origin, old_host = os.environ.get("MCP_PUBLIC_ORIGIN"), os.environ.get("MCP_TRUSTED_HOST")
        os.environ["MCP_PUBLIC_ORIGIN"] = "https://mcp.example.test"
        os.environ["MCP_TRUSTED_HOST"] = "mcp.example.test"
        try:
            application = create_app(Provider(), backend_url="http://127.0.0.1:8189/3d-printing",
                                     backend_bearer="private-backend-token", tenant_id="tenant", user_oid="operator",
                                     transport=RecordingTransport())
            response = await self.request(application, "PUT", f"/3d-printing/workspace-uploads/{CAPABILITY}",
                                          headers={"content-type": "application/octet-stream", "content-length": "0"})
            self.assertEqual(response.status_code, 201)
        finally:
            if old_origin is None: os.environ.pop("MCP_PUBLIC_ORIGIN", None)
            else: os.environ["MCP_PUBLIC_ORIGIN"] = old_origin
            if old_host is None: os.environ.pop("MCP_TRUSTED_HOST", None)
            else: os.environ["MCP_TRUSTED_HOST"] = old_host

    async def test_streams_only_the_fixed_capability_path_and_strips_caller_authorization(self):
        transport = RecordingTransport()

        async def chunks():
            yield b"abc"
            yield b"def"

        response = await self.request(app(transport), "PUT", f"/3d-printing/workspace-uploads/{CAPABILITY}",
                                      headers={"content-type": "application/octet-stream", "content-length": "6",
                                               "authorization": "Bearer caller-token"}, content=chunks())
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.content, b"accepted")
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertEqual(len(transport.requests), 1)
        request, body = transport.requests[0]
        self.assertEqual(str(request.url), f"http://127.0.0.1:8189/3d-printing/workspace-uploads/{CAPABILITY}")
        self.assertEqual(body, b"abcdef")
        self.assertEqual(request.headers["authorization"], "Bearer private-backend-token")
        self.assertEqual(request.headers["host"], "mcp.example.test")
        self.assertEqual(request.headers["content-length"], "6")
        self.assertNotIn("caller-token", repr(request.headers))

    async def test_invalid_capability_forms_never_reach_the_backend(self):
        transport = RecordingTransport()
        application = app(transport)
        headers = {"content-type": "application/octet-stream", "content-length": "0"}
        for path in ("/3d-printing/workspace-uploads/short",
                     f"/3d-printing/workspace-uploads/{CAPABILITY}?extra=1"):
            response = await self.request(application, "PUT", path, headers=headers)
            self.assertEqual(response.status_code, 404)
        response = await self.request(application, "PUT", f"/3d-printing/workspace-uploads/{CAPABILITY}",
                                      headers={"content-type": "application/octet-stream",
                                               "content-length": str(MAX_CAPABILITY_CONTENT_LENGTH + 1)})
        self.assertEqual(response.status_code, 404)
        self.assertEqual(transport.requests, [])

    async def test_capability_route_has_no_oauth_requirement_but_mcp_route_still_does(self):
        transport = RecordingTransport()
        application = app(transport)
        response = await self.request(application, "POST", "/3d-printing",
                                      headers={"content-type": "application/json"}, content=b"{}")
        self.assertEqual(response.status_code, 401)
        response = await self.request(application, "GET", f"/3d-printing/workspace-uploads/{CAPABILITY}")
        self.assertEqual(response.status_code, 405)
        self.assertEqual(transport.requests, [])

    async def test_backend_failure_is_sanitized(self):
        application = app(RecordingTransport(httpx2.ConnectError("private upstream error")))
        response = await self.request(application, "PUT", f"/3d-printing/workspace-uploads/{CAPABILITY}",
                                      headers={"content-type": "application/octet-stream", "content-length": "0"})
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.text, "Upload unavailable")
        self.assertNotIn("private upstream", response.text)


if __name__ == "__main__":
    unittest.main()
