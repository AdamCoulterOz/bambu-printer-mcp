"""Local gateway-to-Node HTTPS upload integration harness.

This never contacts a real MCP, printer, OAuth provider, Caddy, or public host.
It starts a temporary bearer-protected Node HTTP server, a local TLS ASGI gateway,
and uses curl with --connect-to to exercise the returned synthetic HTTPS URL.

Run after `npm run build` with the pinned gateway dependencies available:
  uv run --isolated --with fastmcp==4.2.0 --with httpx2==2.16.2 \
    python deploy/zimaos/auth/test_upload_e2e.py
"""
import asyncio
import base64
import hashlib
import http.client
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest

import uvicorn

from bridge import create_app


ROOT = Path(__file__).resolve().parents[3]
PUBLIC_HOST = "mcp.example.test"
PUBLIC_ORIGIN = f"https://{PUBLIC_HOST}"
BACKEND_TOKEN = "local-e2e-backend-token"
MCP_VERSION = "2026-07-28"

NODE_HELPER = r'''
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { HttpRequests } from './dist/http-requests.js';
import { handleWorkspaceArtifactTool, workspaceArtifactTools } from './dist/workspace-artifacts.js';

const runtime = new HttpRequests({
  host: '127.0.0.1', port: 0, path: '/3d-printing', enableJsonResponse: true,
  allowedOrigins: new Set(), allowedHosts: new Set(['mcp.example.test']),
  bearerToken: process.env.E2E_BACKEND_TOKEN,
}, () => {
  const server = new Server({name:'upload-e2e',version:'1'}, {capabilities:{tools:{}}});
  server.setRequestHandler(ListToolsRequestSchema, async () => ({tools: workspaceArtifactTools}));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const name = request.params.name;
    if (!workspaceArtifactTools.some(tool => tool.name === name)) throw new Error('unknown test tool');
    const result = await handleWorkspaceArtifactTool(name, request.params.arguments ?? {});
    return {content:[{type:'text',text:JSON.stringify(result)}], structuredContent:result};
  });
  return server;
});
await runtime.listen();
console.log(JSON.stringify({port: runtime.httpServer.address().port}));
for await (const line of process.stdin) {
  if (line.trim() === 'close') { await runtime.close(); break; }
}
'''


class Provider:
    """The capability route is deliberately independent of OAuth middleware."""
    def get_routes(self, _resource_path):
        return []

    def get_middleware(self):
        return []


class NodeFixture:
    def __init__(self, store):
        env = os.environ | {
            "BAMBU_ARTIFACT_DIR": str(store),
            "BAMBU_ARTIFACT_GROUP_GID": str(os.getgid()),
            "BAMBU_ARTIFACT_UPLOAD_BASE_URL": PUBLIC_ORIGIN + "/3d-printing",
            "E2E_BACKEND_TOKEN": BACKEND_TOKEN,
        }
        self.process = subprocess.Popen(["node", "--input-type=module", "--eval", NODE_HELPER], cwd=ROOT,
                                        env=env, text=True, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE)
        line = self.process.stdout.readline().strip()
        if not line:
            raise RuntimeError(self.process.stderr.read() or "Node fixture did not start")
        self.port = json.loads(line)["port"]
        self.session = None

    def close(self):
        if self.process.poll() is None:
            self.process.stdin.write("close\n")
            self.process.stdin.flush()
            self.process.wait(timeout=10)
        self.process.stdin.close()
        self.process.stdout.close()
        self.process.stderr.close()

    def rpc(self, message, *, initialize=False):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        body = json.dumps(message, separators=(",", ":")).encode()
        conn.putrequest("POST", "/3d-printing", skip_host=True)
        conn.putheader("Host", PUBLIC_HOST)
        conn.putheader("Authorization", "Bearer " + BACKEND_TOKEN)
        conn.putheader("Content-Type", "application/json")
        conn.putheader("Accept", "application/json, text/event-stream")
        if self.session:
            conn.putheader("Mcp-Session-Id", self.session)
            conn.putheader("MCP-Protocol-Version", MCP_VERSION)
            conn.putheader("Mcp-Method", message["method"])
            if isinstance(message.get("params"), dict) and isinstance(message["params"].get("name"), str):
                conn.putheader("Mcp-Name", message["params"]["name"])
        conn.putheader("Content-Length", str(len(body)))
        conn.endheaders(body)
        response = conn.getresponse()
        raw = response.read()
        session = response.getheader("Mcp-Session-Id")
        conn.close()
        if initialize:
            if response.status != 200 or not session:
                raise AssertionError(f"MCP initialize failed: {response.status} {raw!r}")
            self.session = session
            return {}
        if message["method"].startswith("notifications/"):
            if response.status != 202:
                raise AssertionError(f"MCP notification failed: {response.status} {raw!r}")
            return {}
        if response.status != 200:
            raise AssertionError(f"MCP request failed: {response.status} {raw!r}")
        if response.getheader("Content-Type", "").startswith("application/json"):
            envelope = json.loads(raw)
        else:
            events = [line[6:] for line in raw.decode().splitlines() if line.startswith("data: ")]
            if not events:
                raise AssertionError(f"missing MCP SSE result: {raw!r}")
            envelope = json.loads(events[-1])
        if "error" in envelope:
            raise AssertionError(envelope["error"])
        result = envelope["result"]
        return result.get("structuredContent") or json.loads(result["content"][0]["text"])

    def initialize(self):
        self.rpc({"jsonrpc":"2.0", "id":1, "method":"initialize", "params":{
            "protocolVersion":MCP_VERSION, "clientInfo":{"name":"upload-e2e","version":"1"}, "capabilities":{},
        }}, initialize=True)
        self.rpc({"jsonrpc":"2.0", "method":"notifications/initialized", "params":{}})

    def tool(self, name, arguments):
        return self.rpc({"jsonrpc":"2.0", "id":int(time.time_ns() % 2_000_000_000), "method":"tools/call",
                         "params":{"name":name, "arguments":arguments, "_meta":{
                             "io.modelcontextprotocol/protocolVersion":MCP_VERSION,
                             "io.modelcontextprotocol/clientCapabilities":{},
                         }}})


class UploadE2ETests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        if not shutil.which("curl") or not shutil.which("openssl"):
            self.skipTest("curl and openssl are required for this local TLS harness")
        if not (ROOT / "dist" / "http-requests.js").exists():
            self.skipTest("run npm run build before the integration harness")
        self.temp = tempfile.TemporaryDirectory(prefix="bambu-upload-e2e-", dir=os.path.realpath(tempfile.gettempdir()))
        self.root = Path(self.temp.name)
        self.store = self.root / "store"
        self.store.mkdir(mode=0o700)
        self.node = NodeFixture(self.store)
        self.node.initialize()
        self.cert, self.key = self.root / "cert.pem", self.root / "key.pem"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                        "-subj", f"/CN={PUBLIC_HOST}", "-addext", f"subjectAltName=DNS:{PUBLIC_HOST}",
                        "-keyout", str(self.key), "-out", str(self.cert)], check=True, capture_output=True)
        gateway = create_app(Provider(), backend_url=f"http://127.0.0.1:{self.node.port}/3d-printing",
                             backend_bearer=BACKEND_TOKEN, tenant_id="fixture", user_oid="fixture",
                             public_origin=PUBLIC_ORIGIN, trusted_host=PUBLIC_HOST)
        config = uvicorn.Config(gateway, host="127.0.0.1", port=0, ssl_certfile=str(self.cert),
                                ssl_keyfile=str(self.key), access_log=False, log_level="critical")
        self.gateway = uvicorn.Server(config)
        self.gateway_task = asyncio.create_task(self.gateway.serve())
        for _ in range(200):
            if self.gateway.started:
                break
            await asyncio.sleep(0.01)
        if not self.gateway.started:
            raise RuntimeError("TLS gateway did not start")
        self.gateway_port = next(iter(self.gateway.servers)).sockets[0].getsockname()[1]

    async def asyncTearDown(self):
        self.gateway.should_exit = True
        await self.gateway_task
        self.node.close()
        self.temp.cleanup()

    async def curl_put(self, upload_url, source, *, limit_rate=None, terminate=False):
        args = ["curl", "--silent", "--show-error", "--fail-with-body", "--cacert", str(self.cert),
                "--connect-to", f"{PUBLIC_HOST}:443:127.0.0.1:{self.gateway_port}", "--request", "PUT",
                "--header", "Content-Type: application/octet-stream", "--upload-file", str(source), upload_url]
        if limit_rate:
            args[1:1] = ["--limit-rate", limit_rate]
        process = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        if terminate:
            await asyncio.sleep(0.2)
            process.terminate()
        stdout, stderr = await process.communicate()
        return process.returncode, stdout, stderr

    def reserve(self, filename, content, expected=None):
        digest = expected or hashlib.sha256(content).hexdigest()
        workspace = self.node.tool("workspace_create", {})["workspace_id"]
        ticket = self.node.tool("workspace_upload_begin_https", {"workspace_id":workspace, "filename":filename,
                                                                    "size_bytes":len(content), "sha256":digest})
        self.assertEqual(ticket["method"], "PUT")
        self.assertEqual(ticket["size_bytes"], len(content))
        self.assertEqual(ticket["sha256"], digest)
        self.assertTrue(ticket["upload_url"].startswith(PUBLIC_ORIGIN + "/3d-printing/workspace-uploads/"))
        return workspace, ticket

    async def test_mcp_reservation_curl_upload_finish_readback_replay_hash_and_abort(self):
        content = b"curl gateway to node exact bytes"
        source = self.root / "fixture.3mf"
        source.write_bytes(content)
        workspace, ticket = self.reserve("fixture.3mf", content)
        code, stdout, stderr = await self.curl_put(ticket["upload_url"], source)
        self.assertEqual((code, stdout, stderr), (0, b"", b""))
        artifact = self.node.tool("workspace_upload_finish", {"workspace_id":workspace, "upload_id":ticket["upload_id"]})
        self.assertEqual(artifact["sha256"], hashlib.sha256(content).hexdigest())
        readback = self.node.tool("workspace_artifact_read", {"workspace_id":workspace, "artifact_id":artifact["artifact_id"]})
        self.assertEqual(base64.b64decode(readback["data_base64"]), content)
        replay, _, _ = await self.curl_put(ticket["upload_url"], source)
        self.assertNotEqual(replay, 0)

        bad_workspace, bad = self.reserve("bad.3mf", content, expected="0" * 64)
        bad_code, _, _ = await self.curl_put(bad["upload_url"], source)
        self.assertNotEqual(bad_code, 0)
        status = self.node.tool("workspace_status", {"workspace_id":bad_workspace})
        self.assertFalse(any(item["upload_id"] == bad["upload_id"] for item in status["uploads"]))

        aborted = self.root / "aborted.3mf"
        aborted.write_bytes(b"x" * (256 * 1024))
        abort_workspace, abort_ticket = self.reserve("aborted.3mf", aborted.read_bytes())
        cancelled, _, _ = await self.curl_put(abort_ticket["upload_url"], aborted, limit_rate="1K", terminate=True)
        self.assertNotEqual(cancelled, 0)
        await asyncio.sleep(0.1)
        status = self.node.tool("workspace_status", {"workspace_id":abort_workspace})
        self.assertFalse(any(item["upload_id"] == abort_ticket["upload_id"] for item in status["uploads"]))
        replay, _, _ = await self.curl_put(abort_ticket["upload_url"], aborted)
        self.assertNotEqual(replay, 0)


if __name__ == "__main__":
    unittest.main()
