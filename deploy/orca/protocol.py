"""MCP metadata and exclusive-workspace policy for a single Orca GUI."""
import copy
import json
from workspace import WorkspaceError

INSTRUCTIONS = ('Call workspace_create, then workspace_open with its workspace_id. Pass that ID to every Orca tool call. '
                'Wait for jobs and export before workspace_close. Use workspace_open with the same ID after a verified checkpoint; recovery is required after an unclean stop. Unfinished outcomes are unknown.')
CONTROL = [
 {'name':'workspace_create','description':'Create a durable cold workspace and return its ID.', 'inputSchema':{'type':'object','properties':{},'additionalProperties':False}},
 {'name':'workspace_open','description':'Open a workspace from its verified checkpoint; unclean workspaces require recovery.', 'inputSchema':{'type':'object','properties':{'workspace_id':{'type':'string'}},'required':['workspace_id'],'additionalProperties':False}},
 {'name':'workspace_status','description':'Read worker state; optionally check a workspace ID.', 'inputSchema':{'type':'object','properties':{'workspace_id':{'type':'string'}},'additionalProperties':False}},
 {'name':'workspace_close','description':'End the owned workspace; unfinished outcomes may be unknown.', 'inputSchema':{'type':'object','properties':{'workspace_id':{'type':'string'}},'required':['workspace_id'],'additionalProperties':False}},
]
class Router:
    def __init__(self, workspace, cache, forward): self.workspace,self.cache,self.forward=workspace,cache,forward
    @staticmethod
    def result(req,result,modern):
        if modern: result=dict(result,resultType='complete')
        return {'jsonrpc':'2.0','id':req.get('id'),'result':result}
    @staticmethod
    def error(req,message): return {'jsonrpc':'2.0','id':req.get('id'),'error':{'code':-32600,'message':message}}
    def handle(self, data, headers):
        try: req=json.loads(data)
        except (ValueError,UnicodeDecodeError): return 400,b''
        if not isinstance(req,dict) or req.get('jsonrpc')!='2.0' or not isinstance(req.get('method'),str): return 400,b''
        method=req['method']; params=req.get('params') or {}
        if not isinstance(params,dict): return 400,b''
        modern=isinstance(params.get('_meta'),dict) and 'io.modelcontextprotocol/protocolVersion' in params['_meta']
        if method=='notifications/initialized' and 'id' not in req: return 202,b''
        if method in ('initialize','server/discover','tools/list','ping'):
            if method=='ping': result={}
            else:
                cached=self.cache.get((method,modern))
                if cached is None: return 503,b''
                result=copy.deepcopy(cached)
            if method in ('initialize','server/discover'):
                result['instructions']=(INSTRUCTIONS+'\n'+result.get('instructions','')).strip()
            if method=='tools/list':
                for tool in result['tools']:
                    schema=tool.setdefault('inputSchema',{'type':'object'})
                    if tool.get('name') in {control['name'] for control in CONTROL} or 'workspace_id' in schema.get('properties',{}): return 503,b''
                    schema.setdefault('properties',{})['workspace_id']={'type':'string','description':'Workspace ID from workspace_create or workspace_open.'}
                    required=schema.setdefault('required',[])
                    if 'workspace_id' not in required: required.append('workspace_id')
                result['tools']+=copy.deepcopy(CONTROL)
            return 200,json.dumps(self.result(req,result,modern),separators=(',',':')).encode()
        if method!='tools/call': return 200,json.dumps(self.error(req,'Unsupported method')).encode()
        name=params.get('name'); args=params.get('arguments',{})
        if not isinstance(name,str) or not isinstance(args,dict): return 400,b''
        try:
            if name=='workspace_create': result=self.workspace.create()
            elif name=='workspace_open': result=self.workspace.open(args.get('workspace_id'))
            elif name=='workspace_status': result=self.workspace.status(args.get('workspace_id'))
            elif name=='workspace_close': result=self.workspace.close(args.get('workspace_id'))
            else:
                workspace_id=args.get('workspace_id'); generation=self.workspace.authorize(workspace_id)
                try:
                    args=dict(args); args.pop('workspace_id',None); req['params']=dict(params,arguments=args)
                    return self.forward(generation,json.dumps(req,separators=(',',':')).encode(),headers)
                finally: self.workspace.finish(generation)
            text=json.dumps(result,separators=(',',':'))
            return 200,json.dumps(self.result(req,{'content':[{'type':'text','text':text}]},modern),separators=(',',':')).encode()
        except WorkspaceError as e:
            return 200,json.dumps(self.result(req,{'isError':True,'content':[{'type':'text','text':str(e)}]},modern),separators=(',',':')).encode()
        except Exception:
            # Startup, checkpoint or transport errors may have dispatched work;
            # expose no secrets and never replay the request.
            return 200,json.dumps(self.result(req,{'isError':True,'content':[{'type':'text','text':'Workspace operation failed; check status before retrying.'}]},modern),separators=(',',':')).encode()
