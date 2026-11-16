import http.client
import threading
import tempfile
import socket
import os
import stat
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from gateway import Server
TOKEN = 'a' * 64
class Upstream(BaseHTTPRequestHandler):
    calls = []
    def log_message(self, *args): pass
    def do_POST(self):
        body = self.rfile.read(int(self.headers['Content-Length']))
        Upstream.calls.append((self.path, dict(self.headers), body))
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(body)
class UnixConnection(http.client.HTTPConnection):
    def __init__(self, path): super().__init__('localhost', timeout=5); self.path=path
    def connect(self):
        self.sock=socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(5); self.sock.connect(self.path)
class GatewayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.upstream = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        cls.tmp=tempfile.TemporaryDirectory(); cls.path=cls.tmp.name+'/mcp.sock'
        cls.gateway = Server(cls.path, TOKEN, 'orca.example', cls.upstream.server_address)
        for server in (cls.upstream, cls.gateway): threading.Thread(target=server.serve_forever, daemon=True).start()
    @classmethod
    def tearDownClass(cls):
        for server in (cls.gateway, cls.upstream): server.shutdown(); server.server_close()
        cls.tmp.cleanup()
    def setUp(self): Upstream.calls.clear()
    def request(self, body=b'{}', **headers):
        conn = UnixConnection(self.path)
        conn.request('POST', '/3d-printing/slicer', body, headers={'Host':'orca.example', 'Authorization':'Bearer '+TOKEN, 'Content-Type':'application/json', **headers})
        r=conn.getresponse(); out=(r.status,r.read()); conn.close(); return out
    def test_forwards_protocol_forms_once(self):
        for body in (b'{"jsonrpc":"2.0","id":1,"method":"initialize"}', b'{"jsonrpc":"2.0","id":2,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}'):
            self.assertEqual(self.request(body, **{'MCP-Protocol-Version':'2025-11-25'}),(200,body))
        self.assertEqual(len(Upstream.calls),2)
        self.assertEqual(Upstream.calls[0][1]['Host'],f'{self.upstream.server_address[0]}:{self.upstream.server_address[1]}')
    def test_rejects_auth_host_origin(self):
        self.assertEqual(self.request(b'', Authorization='Bearer invalid')[0],401)
        self.assertEqual(self.request(b'', Host='wrong.example')[0],403)
        self.assertEqual(self.request(b'', Origin='https://attacker.example')[0],403)
        self.assertEqual(Upstream.calls,[])
    def test_body_limit(self):
        self.assertEqual(self.request(b'', **{'Content-Length': str(8*1024*1024+1)})[0],413)
        self.assertEqual(Upstream.calls,[])
    def test_socket_permissions_and_path(self):
        self.assertEqual(stat.S_IMODE(os.stat(self.path).st_mode), 0o600)
        conn=UnixConnection(self.path)
        conn.request('POST','/wrong',b'',headers={'Host':'orca.example','Authorization':'Bearer '+TOKEN,'Content-Type':'application/json'})
        r=conn.getresponse(); self.assertEqual(r.status,404); r.read(); conn.close()
        self.assertEqual(Upstream.calls,[])
    def test_second_server_cannot_replace_live_socket(self):
        before=os.stat(self.path).st_ino
        with self.assertRaises((BlockingIOError, OSError)):
            Server(self.path,TOKEN,'orca.example',self.upstream.server_address)
        self.assertEqual(os.stat(self.path).st_ino,before)
        self.assertEqual(self.request(),(200,b'{}'))
    def test_no_replay_on_lost_upstream(self):
        class Lost(Upstream):
            def do_POST(self):
                Upstream.calls.append(1); self.connection.shutdown(2); self.connection.close()
        lost=ThreadingHTTPServer(('127.0.0.1',0),Lost)
        threading.Thread(target=lost.serve_forever,daemon=True).start()
        prior=self.gateway.upstream; self.gateway.upstream=lost.server_address
        try:
            self.assertEqual(self.request(b'{"method":"tools/call"}')[0],502)
            self.assertEqual(len(Upstream.calls),1)
        finally: self.gateway.upstream=prior; lost.shutdown(); lost.server_close()
if __name__ == '__main__': unittest.main()

class SocketOwnershipTests(unittest.TestCase):
    def test_stale_socket_is_recovered_after_lock_release(self):
        with tempfile.TemporaryDirectory() as d:
            path=d+'/mcp.sock'
            first=Server(path,TOKEN,'orca.example'); first.server_close()
            stale=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); stale.bind(path); stale.close()
            server=Server(path,TOKEN,'orca.example')
            self.assertTrue(stat.S_ISSOCK(os.lstat(path).st_mode))
            server.server_close(); self.assertFalse(os.path.exists(path))
    def test_bad_socket_or_lock_file_and_symlinks_are_rejected(self):
        for target in ('socket-file','socket-link','lock-file','lock-link','lock-public'):
            with self.subTest(target=target), tempfile.TemporaryDirectory() as d:
                path=d+'/mcp.sock'; lock=path+'.lock'; regular=d+'/regular'
                with open(regular,'w') as f: f.write('untouched')
                if target=='socket-file': os.rename(regular,path)
                elif target=='socket-link': os.symlink(regular,path)
                elif target=='lock-file': os.mkdir(lock)
                elif target=='lock-link': os.symlink(regular,lock)
                else: os.rename(regular,lock); os.chmod(lock,0o644)
                with self.assertRaises((OSError,ValueError)): Server(path,TOKEN,'orca.example')
                self.assertTrue(os.path.lexists(lock if target.startswith('lock') else path))

    def test_signal_shutdown_holds_lock_for_start_and_checkpoint(self):
        import subprocess, sys, time, signal
        script='''import os,signal,sys,threading,time
from pathlib import Path
from gateway import Server
from workspace import Workspace,shutdown_or_exit
d=Path(sys.argv[1]); phase=sys.argv[2]; token='a'*64
def barrier():
    (d/'entered').write_text('1')
    while not (d/'release').exists(): time.sleep(.01)
class Backend:
    def create(self,i): pass
    def exists(self,i): return True
    def can_open(self,i): return True
    def start(self,*a):
        if phase=='start': barrier()
    def checkpoint(self,*a):
        if phase=='checkpoint': barrier()
        return False
    def stop(self,*a): return True
    def commit_checkpoint(self,*a): return False
w=Workspace(Backend()); server=Server(str(d/'mcp.sock'),token,'orca.example')
def on_signal(*_): (d/'signal').write_text('1')
signal.signal(signal.SIGTERM,on_signal)
if phase=='start': threading.Thread(target=w.open,args=('fixture',),daemon=True).start()
else:
    w.open('fixture'); threading.Thread(target=w.close,args=('fixture',),daemon=True).start()
while not (d/'signal').exists(): time.sleep(.01)
def observe():
    while not w.shutting_down: time.sleep(.005)
    (d/'shutdown').write_text('1')
threading.Thread(target=observe,daemon=True).start()
shutdown_or_exit(w,server,timeout=float(sys.argv[3]))
'''
        for phase,timeout_exit in (('start',False),('checkpoint',False),('start',True)):
            with self.subTest(phase=phase,timeout_exit=timeout_exit), tempfile.TemporaryDirectory() as d:
                path=d+'/mcp.sock'; env=dict(os.environ, PYTHONPATH=os.path.dirname(__file__))
                p=subprocess.Popen([sys.executable,'-B','-c',script,d,phase,'1' if timeout_exit else '3'],env=env)
                try:
                    def wait_for(name):
                        deadline=time.monotonic()+3
                        while not os.path.exists(d+'/'+name) and time.monotonic()<deadline: time.sleep(.01)
                        self.assertTrue(os.path.exists(d+'/'+name),name)
                    wait_for('entered'); p.send_signal(signal.SIGTERM); wait_for('shutdown')
                    with self.assertRaises((BlockingIOError,OSError)): Server(path,TOKEN,'orca.example')
                    if not timeout_exit:
                        with open(d+'/release','w') as f: f.write('1')
                    self.assertEqual(p.wait(timeout=5),1 if timeout_exit else 0)
                    next_server=Server(path,TOKEN,'orca.example'); next_server.server_close()
                finally:
                    if p.poll() is None: p.kill(); p.wait()

class IntegratedProtocolTests(unittest.TestCase):
    def test_unix_gateway_never_forwards_without_workspace_id(self):
        import json
        from protocol import Router
        from workspace import Workspace
        class Backend:
            def __init__(self): self.ids=set()
            def create(self,i): self.ids.add(i)
            def exists(self,i): return i in self.ids
            def can_open(self,i): return i in self.ids
            def describe(self,i): return {'recovery_required':False,'has_checkpoint':False}
            def start(self,g,t,i): pass
            def checkpoint(self,g): return False
            def stop(self,g): return True
        seen=[]
        workspace=Workspace(Backend())
        router=Router(workspace,{},lambda g,d,h:(seen.append(json.loads(d)) or (200,b'{}')))
        with tempfile.TemporaryDirectory() as d:
            path=d+'/mcp.sock'; server=Server(path,TOKEN,'orca.example');server.router=router
            threading.Thread(target=server.serve_forever,daemon=True).start()
            def send(name,args):
                c=UnixConnection(path); body=json.dumps({'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':name,'arguments':args}})
                c.request('POST','/3d-printing/slicer',body,headers={'Host':'orca.example','Authorization':'Bearer '+TOKEN,'Content-Type':'application/json'})
                r=c.getresponse(); payload=json.loads(r.read());c.close();return payload
            try:
                self.assertTrue(send('slice',{})['result']['isError']); self.assertEqual(seen,[])
                made=send('workspace_create',{}); wid=json.loads(made['result']['content'][0]['text'])['workspace_id']
                send('workspace_open',{'workspace_id':wid}); send('slice',{'workspace_id':wid});self.assertEqual(len(seen),1)
                self.assertNotIn('workspace_id',seen[0]['params']['arguments'])
            finally: server.shutdown();server.server_close()
