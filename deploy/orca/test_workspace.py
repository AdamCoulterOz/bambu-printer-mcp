import unittest
import threading
from workspace import Workspace, WorkspaceError
class Backend:
    def __init__(self): self.starts=[]; self.stops=[]; self.stopped=True; self.artifacts=['retained.3mf']; self.ids=set()
    def create(self,i): self.ids.add(i)
    def exists(self,i): return i in self.ids
    def can_open(self,i): return i in self.ids
    def describe(self,i): return {'recovery_required':False,'has_checkpoint':False}
    def start(self,g,t,i): self.starts.append((g,t))
    def checkpoint(self,g): return False
    def commit_checkpoint(self,g): return False
    def stop(self,g): self.stops.append(g); return self.stopped
class Tests(unittest.TestCase):
    def setUp(self):
        self.time=0; self.backend=Backend(); self.w=Workspace(self.backend,10,30,lambda:self.time)
    def test_exclusive_owner_renewal_and_hard_limit(self):
        key=self.w.create()['workspace_id']; self.w.open(key)
        other=self.w.create()['workspace_id']
        with self.assertRaises(WorkspaceError): self.w.open(other)
        with self.assertRaises(WorkspaceError): self.w.authorize('other')
        for n in (9,18,27): self.time=n; self.w.finish(self.w.authorize(key))
        self.time=30
        with self.assertRaises(WorkspaceError): self.w.authorize(key)
        self.assertTrue(self.w.expire_if_due()['closed'])
        self.assertEqual(self.w.status(),{'busy':False,'state':'idle','active':False})
    def test_failed_exit_keeps_workspace_reserved_and_artifacts(self):
        key=self.w.create()['workspace_id']; self.w.open(key); self.backend.stopped=False
        self.assertFalse(self.w.close(key)['closed'])
        other=self.w.create()['workspace_id']
        with self.assertRaises(WorkspaceError): self.w.open(other)
        self.assertEqual(self.backend.artifacts,['retained.3mf'])
        self.backend.stopped=True; self.assertTrue(self.w.retry_stop()); self.w.create()
    def test_stale_generation_does_not_finish_new_call_and_token_rotates(self):
        key=self.w.create()['workspace_id']; self.w.open(key); old=self.w.authorize(key); self.w.close(key)
        key2=self.w.create()['workspace_id']; self.w.open(key2); new=self.w.authorize(key2)
        self.w.finish(old); self.assertEqual(self.w.active,1)
        self.assertNotEqual(self.backend.starts[0][1],self.backend.starts[1][1])
        self.w.finish(new)
    def test_create_never_starts_worker(self):
        resource=self.w.create(); self.assertFalse(resource['worker_busy']); self.assertEqual(self.backend.starts,[]); self.assertFalse(self.w.status()['busy'])
    def test_start_in_progress_status_and_cold_create(self):
        resource=self.w.create(); key=resource['workspace_id']
        entered=threading.Event(); release=threading.Event()
        def start(g,t,i): entered.set(); release.wait(2)
        self.backend.start=start
        thread=threading.Thread(target=self.w.open,args=(key,));thread.start()
        self.assertTrue(entered.wait(1));self.assertEqual(self.w.status(key)['state'],'starting')
        other=self.w.create();self.assertTrue(other['worker_busy'])
        release.set();thread.join(2);self.assertFalse(thread.is_alive())
    def test_status_never_exposes_key(self):
        key=self.w.create()['workspace_id']; self.assertNotIn(key,str(self.w.status()))
    def test_close_owns_checkpoint_and_stop_until_finalized(self):
        key=self.w.create()['workspace_id']; other=self.w.create()['workspace_id']; self.w.open(key)
        checkpoint_entered=threading.Event(); checkpoint_release=threading.Event()
        stop_entered=threading.Event(); stop_release=threading.Event(); events=[]
        def checkpoint(g):
            events.append(('checkpoint',g)); checkpoint_entered.set(); self.assertTrue(checkpoint_release.wait(2)); return True
        def stop(g):
            events.append(('stop',g)); stop_entered.set(); self.assertTrue(stop_release.wait(2)); events.append(('finalized',g)); return True
        self.backend.checkpoint=checkpoint; self.backend.stop=stop
        self.backend.commit_checkpoint=lambda g: events.append(('commit',g)) or True
        result=[]; thread=threading.Thread(target=lambda:result.append(self.w.close(key))); thread.start()
        self.assertTrue(checkpoint_entered.wait(1)); self.time=30
        self.assertFalse(self.w.retry_stop()); self.assertIsNone(self.w.expire_if_due())
        with self.assertRaises(WorkspaceError): self.w.open(other)
        self.assertEqual(events,[('checkpoint',1)])
        checkpoint_release.set(); self.assertTrue(stop_entered.wait(1))
        self.assertFalse(self.w.retry_stop())
        with self.assertRaises(WorkspaceError): self.w.open(other)
        stop_release.set(); thread.join(2); self.assertFalse(thread.is_alive())
        self.assertTrue(result[0]['checkpointed']); self.w.open(other)
        self.assertEqual(events,[('checkpoint',1),('stop',1),('finalized',1),('commit',1)])
        self.assertEqual(self.backend.starts[-1][0],2)
if __name__=='__main__':unittest.main()
