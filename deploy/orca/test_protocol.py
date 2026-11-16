import json
import unittest
from protocol import Router
from workspace import Workspace
class Backend:
    def __init__(self): self.ids=set()
    def create(self,i): self.ids.add(i)
    def exists(self,i): return i in self.ids
    def can_open(self,i): return i in self.ids
    def describe(self,i): return {'recovery_required':False,'has_checkpoint':False}
    def start(self,g,t,i): self.token=t
    def checkpoint(self,g): return False
    def commit_checkpoint(self,g): return False
    def stop(self,g): return True
class Tests(unittest.TestCase):
    def setUp(self):
        self.w=Workspace(Backend()); self.sent=[]
        cache={('tools/list',False):{'tools':[{'name':'slice','inputSchema':{'type':'object','properties':{}}}]},('initialize',False):{'instructions':'native'},('server/discover',True):{'instructions':'native'},('tools/list',True):{'tools':[{'name':'slice','inputSchema':{'type':'object','properties':{}}}]}}
        self.r=Router(self.w,cache,lambda g,d,h:(self.sent.append((g,json.loads(d))) or (200,b'{}')))
    def call(self,method,params=None):
        status,body=self.r.handle(json.dumps({'jsonrpc':'2.0','id':1,'method':method,'params':params or {}}).encode(),{})
        return status,json.loads(body)
    def test_catalog_requires_lease_in_both_protocol_eras(self):
        for p in ({},{'_meta':{'io.modelcontextprotocol/protocolVersion':'2026-07-28'}}):
            r=self.call('tools/list',p)[1]['result']; self.assertIn('workspace_id',r['tools'][0]['inputSchema']['required']);self.assertEqual(r['tools'][1]['name'],'workspace_create')
    def test_native_cannot_run_without_owned_lease(self):
        self.assertTrue(self.call('tools/call',{'name':'slice','arguments':{}})[1]['result']['isError'])
        began=self.call('tools/call',{'name':'workspace_create','arguments':{}})[1]
        lease=json.loads(began['result']['content'][0]['text'])['workspace_id']
        self.call('tools/call',{'name':'workspace_open','arguments':{'workspace_id':lease}})
        self.call('tools/call',{'name':'slice','arguments':{'workspace_id':lease,'plate':1}})
        self.assertEqual(self.sent[0][1]['params']['arguments'],{'plate':1})
        self.call('tools/call',{'name':'workspace_close','arguments':{'workspace_id':lease}})
        self.assertTrue(self.call('tools/call',{'name':'slice','arguments':{'workspace_id':lease}})[1]['result']['isError'])
    def test_instructions_teach_workflow(self):
        self.assertTrue(self.call('initialize')[1]['result']['instructions'].startswith('Call workspace_create'))
if __name__=='__main__': unittest.main()
