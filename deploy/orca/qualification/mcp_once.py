#!/usr/bin/env python3
"""One HTTP request, one response receipt; no retries, no printer tools."""
import argparse, http.client, json, os, socket, sys, uuid
from pathlib import Path

ALLOWED = {'workspace_create','workspace_attach','workspace_open','workspace_status','workspace_close',
           'get_app_state','list_presets','select_preset','select_objects','run_action',
           'list_objects','list_plates','slice','wait','get_slice_stats','export','open_files','workspace_publish_file'}
class UnixHTTP(http.client.HTTPConnection):
    def __init__(self, path, timeout):
        super().__init__('localhost', timeout=timeout); self.path=path
    def connect(self):
        self.sock=socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout); self.sock.connect(self.path)

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--socket', required=True); p.add_argument('--host',required=True)
    p.add_argument('--token-file',required=True); p.add_argument('--receipt',required=True)
    p.add_argument('--timeout',type=int,default=180)
    p.add_argument('method',choices=('initialize','server/discover','tools/list','tools/call'))
    p.add_argument('--tool'); p.add_argument('--args',default='{}'); p.add_argument('--modern',action='store_true')
    a=p.parse_args()
    if not 1 <= a.timeout <= 1800: p.error('timeout must be 1..1800 seconds')
    args=json.loads(a.args)
    if not isinstance(args,dict): p.error('args must be a JSON object')
    if a.method=='tools/call':
        if a.tool not in ALLOWED: p.error('tool outside qualification allowlist')
        if a.tool=='run_action' and (args.get('id')!='add_primitive_cube' or args.get('args')!={'size':[20,20,20]}):
            p.error('only the 20 mm cube action is allowed')
        if a.tool=='export' and (args.get('format')!='sliced_3mf' or args.get('overwrite') is not False):
            p.error('only non-overwriting sliced_3mf export is allowed')
        params={'name':a.tool,'arguments':args}
    else:
        if a.tool or args: p.error('tool and args apply only to tools/call')
        params={'protocolVersion':'2025-11-25','capabilities':{},'clientInfo':{'name':'orca-qualification','version':'1'}} if a.method=='initialize' else {}
    if a.modern: params['_meta']={'io.modelcontextprotocol/protocolVersion':'2026-07-28'}
    req={'jsonrpc':'2.0','id':uuid.uuid4().hex,'method':a.method,'params':params}
    token=Path(a.token_file).read_text().strip()
    if len(token)!=64 or any(c not in '0123456789abcdef' for c in token): raise ValueError('invalid token')
    fd=os.open(a.receipt,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as f:
        conn=UnixHTTP(a.socket,a.timeout)
        headers={'Host':a.host,'Authorization':'Bearer '+token,'Content-Type':'application/json'}
        if a.modern:
            headers.update({'MCP-Protocol-Version':'2026-07-28','Mcp-Method':a.method})
            if a.method=='tools/call': headers['Mcp-Name']=a.tool
        try:
            conn.request('POST','/3d-printing/slicer',json.dumps(req,separators=(',',':')),headers)
            res=conn.getresponse(); raw=res.read(32*1024*1024+1)
            if len(raw)>32*1024*1024: raise RuntimeError('response exceeded limit')
            parsed=json.loads(raw)
            record={'request':req,'http_status':res.status,'response':parsed}
            json.dump(record,f,indent=2); f.write('\n'); f.flush(); os.fsync(f.fileno())
            result=parsed.get('result',{})
            if res.status!=200 or parsed.get('id')!=req['id'] or 'error' in parsed or result.get('isError'):
                raise RuntimeError('request failed; inspect receipt before deciding next step')
            print(json.dumps({'method':a.method,'http_status':res.status,'receipt':a.receipt}, separators=(',', ':')))
        finally: conn.close()
if __name__=='__main__':
    try: main()
    except Exception:
        print('FAILED or outcome unknown; inspect the private receipt before deciding next step',file=sys.stderr); sys.exit(1)
