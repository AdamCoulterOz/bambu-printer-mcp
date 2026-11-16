"""Single owner of metadata probe, per-job Orca children, and private gateway."""
import http.client
import json
import os
import secrets
import signal
import sys
from pathlib import Path
from gateway import Server, token_from_file
from orca_backend import OrcaBackend
from protocol import Router
from workspace import Workspace, shutdown_or_exit

host=os.environ.get('ORCA_GATEWAY_HOST','')
if not host or any(c in host for c in '\r\n/ '): raise SystemExit('invalid gateway Host')
token=token_from_file(os.environ['ORCA_GATEWAY_TOKEN_FILE'])
os.umask(0o077)
root=Path('/home/orca/.config/orca-shared'); root.mkdir(parents=True,exist_ok=True,mode=0o700)
backend=OrcaBackend(root,os.environ.get('ORCA_PROFILE_TEMPLATE'),'/artifacts')
workspace=Workspace(backend,int(os.environ.get('ORCA_IDLE_SECONDS','900')),int(os.environ.get('ORCA_HARD_SECONDS','14400')))

def native(body, token, headers=None):
    conn=http.client.HTTPConnection('127.0.0.1',13619,timeout=120)
    h={'Host':'127.0.0.1:13619','Authorization':'Bearer '+token,'Content-Type':'application/json'}
    for key,value in (headers or {}).items():
        if key.lower() in ('mcp-protocol-version','mcp-method','mcp-name'): h[key]=value
    try:
        conn.request('POST','/mcp',body=body,headers=h)
        response=conn.getresponse(); result=response.read(32*1024*1024+1)
        if len(result)>32*1024*1024: raise ValueError('upstream reply too large')
        return response.status,result
    finally: conn.close()

def forward(generation, body, headers):
    # Capturing a generation-specific token prevents a stale request from
    # authenticating against a later process on the same loopback port.
    with workspace.lock:
        c=backend.current
        if workspace.state!='active' or workspace.generation!=generation or not c or c['generation']!=generation:
            return 503,b''
        child_token=c['token']
    return native(body,child_token,headers)

def probe():
    probe_token=secrets.token_hex(32)
    try:
        backend.start(0,probe_token)
        cache={}
        for method,modern in [('initialize',False),('tools/list',False),('server/discover',True),('tools/list',True)]:
            params={}
            if method=='initialize': params={'protocolVersion':'2025-11-25','capabilities':{},'clientInfo':{'name':'orca-metadata-probe','version':'1'}}
            headers={}
            if modern:
                params['_meta']={'io.modelcontextprotocol/protocolVersion':'2026-07-28'}
                headers={'MCP-Protocol-Version':'2026-07-28','Mcp-Method':method}
            body=json.dumps({'jsonrpc':'2.0','id':1,'method':method,'params':params}).encode()
            status,raw=native(body,probe_token,headers)
            parsed=json.loads(raw)
            if status!=200 or 'result' not in parsed: raise RuntimeError('native metadata probe failed')
            cache[(method,modern)]=parsed['result']
        return cache
    finally:
        if not backend.stop(0): raise RuntimeError('probe child did not exit')

server=None
try:
    server=Server('/run/orca-gateway/mcp.sock',token,host)
    cache=probe()
    server.router=Router(workspace,cache,forward)
    server.timeout=1
    running=True
    def stop(*_):
        global running
        running=False
    signal.signal(signal.SIGTERM,stop); signal.signal(signal.SIGINT,stop)
    while running:
        server.handle_request()
        workspace.expire_if_due()
        if workspace.state=='stopping':
            if backend.current and ('identity' not in backend.current or backend.current.get('unsettled')):
                raise RuntimeError('unidentified detached child; fail-stop required')
            workspace.retry_stop()
finally:
    shutdown_or_exit(workspace,server)
