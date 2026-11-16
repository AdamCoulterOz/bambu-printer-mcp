"""Private transport adapter; it does not enforce printer egress or project ownership."""
import hmac
import fcntl
import http.client
import os
import socket
import socketserver
import stat
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BODY = 8 * 1024 * 1024
MAX_REPLY = 32 * 1024 * 1024

class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    request_queue_size = 32
    def __init__(self, address, token, host, upstream=('127.0.0.1', 13619), path='/3d-printing/slicer'):
        self.token, self.allowed_host, self.upstream, self.path = token, host, upstream, path
        self.slots = threading.BoundedSemaphore(32)
        mode = os.environ.get('ORCA_SOCKET_MODE', '600')
        if mode not in ('600', '0600', '660', '0660'): raise ValueError('socket mode must be 0600 or 0660')
        self.lock_fd = None
        lock_path = os.fspath(address) + '.lock'
        fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            st=os.fstat(fd); path_st=os.lstat(lock_path)
            if (not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid() or st.st_mode & 0o077
                or st.st_nlink != 1 or (st.st_dev,st.st_ino)!=(path_st.st_dev,path_st.st_ino)):
                raise ValueError('invalid gateway lock file')
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.lock_fd=fd
            try:
                existing = os.lstat(address)
                if not stat.S_ISSOCK(existing.st_mode) or existing.st_uid != os.getuid():
                    raise ValueError('refusing to replace socket path')
                os.unlink(address)
            except FileNotFoundError: pass
            super().__init__(address, Handler)
            self.socket_identity=(os.lstat(address).st_dev,os.lstat(address).st_ino)
            os.chmod(address, int(mode, 8))
        except BaseException:
            if hasattr(self,'socket'): super().server_close()
            os.close(fd); self.lock_fd=None
            raise

    def server_close(self):
        if self.lock_fd is None: return
        try:
            super().server_close()
            try:
                st=os.lstat(self.server_address)
                if (st.st_dev,st.st_ino)==self.socket_identity: os.unlink(self.server_address)
            except FileNotFoundError: pass
        finally:
            os.close(self.lock_fd); self.lock_fd=None

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try: super().process_request(request, client_address)
        except BaseException:
            self.slots.release()
            raise
    def process_request_thread(self, request, client_address):
        try: super().process_request_thread(request, client_address)
        finally: self.slots.release()

class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def setup(self):
        super().setup()
        self.connection.settimeout(30)
    def log_message(self, *args):
        pass
    def fail(self, code):
        self.send_response(code)
        self.send_header('Content-Length', '0')
        self.send_header('Connection', 'close')
        self.end_headers()
        self.close_connection = True
    def do_POST(self):
        if self.headers.get_all('Host') != [self.server.allowed_host]: return self.fail(403)
        if self.headers.get('Origin') is not None: return self.fail(403)
        if self.path != self.server.path: return self.fail(404)
        authorization = self.headers.get_all('Authorization') or []
        expected = 'Bearer ' + self.server.token
        if len(authorization) != 1 or not hmac.compare_digest(authorization[0].encode(), expected.encode()): return self.fail(401)
        if self.headers.get('Transfer-Encoding') is not None: return self.fail(400)
        lengths = self.headers.get_all('Content-Length') or []
        if len(lengths) != 1 or not lengths[0].isdigit(): return self.fail(400)
        size = int(lengths[0])
        if size > MAX_BODY: return self.fail(413)
        if self.headers.get_content_type() != 'application/json': return self.fail(415)
        try:
            data = self.rfile.read(size)
            if len(data) != size: return self.fail(400)
            if getattr(self.server, 'router', None) is not None:
                status, payload = self.server.router.handle(data, dict(self.headers))
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            upstream = http.client.HTTPConnection(*self.server.upstream, timeout=120)
            headers = {'Host': f'{self.server.upstream[0]}:{self.server.upstream[1]}', 'Authorization': expected, 'Content-Type': 'application/json'}
            for name in ('MCP-Protocol-Version', 'Mcp-Method', 'Mcp-Name'):
                if self.headers.get(name) is not None: headers[name] = self.headers[name]
            try:
                upstream.request('POST', '/mcp', body=data, headers=headers)
                reply = upstream.getresponse()
                payload = reply.read(MAX_REPLY + 1)
                if len(payload) > MAX_REPLY: return self.fail(502)
                self.send_response(reply.status)
                self.send_header('Content-Type', reply.getheader('Content-Type', 'application/json'))
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            finally: upstream.close()
        except (OSError, socket.timeout, http.client.HTTPException):
            # A failed response does not prove that an accepted operation stopped.
            self.fail(502)
    def do_GET(self): self.fail(405)
    def do_DELETE(self): self.fail(405)
    def do_OPTIONS(self): self.fail(405)

def token_from_file(path):
    st = os.stat(path)
    if not os.path.isfile(path) or st.st_uid != os.getuid() or st.st_mode & 0o077 or st.st_size > 4096:
        raise ValueError('token file must be private and owned by the service user')
    with open(path, encoding='utf-8') as f: token = f.read().strip()
    if len(token) != 64 or any(c not in '0123456789abcdef' for c in token):
        raise ValueError('token must be 64 lowercase hexadecimal characters')
    return token
