import hashlib
import json
import os
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from export_store import ExportStore, limits
from orca_backend import OrcaBackend
from workspace import Workspace, WorkspaceError

class ExportTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.base=Path(self.temp.name)
        self.out=self.base/'out'; self.out.mkdir(); os.chmod(self.out,0o2750)
        self.art=self.base/'art'; self.art.mkdir(); self.root=self.base/'root'
        self.backend=OrcaBackend(self.root,artifact_root=self.art)
        self.store=ExportStore(self.out,os.getgid(),self.art,1024,8192,3)
        self.w=Workspace(self.backend,export_store=self.store)
        self.wid='a'*43; self.w.attach(self.wid)
        self.source=self.art/self.wid/'cube.3mf'; self.source.write_bytes(b'cube-data')
    def tearDown(self): self.temp.cleanup()
    def test_attach_is_cold_idempotent_and_preserves_uncertain_state(self):
        self.assertFalse(self.w.attach(self.wid)['created']); self.assertIsNone(self.backend.current)
        self.assertEqual(self.w.status(self.wid)['state'],'idle')
        manifest=self.root/'workspaces'/self.wid/'manifest.json'; data=json.loads(manifest.read_text()); data['recovery_required']=True
        manifest.write_text(json.dumps(data)); self.assertFalse(self.w.attach(self.wid)['created'])
        self.assertTrue(self.w.status(self.wid)['recovery_required'])
        with self.assertRaises(WorkspaceError): self.w.attach('../wrong')
    def test_publish_delete_hash_and_modes(self):
        receipt=self.store.publish(self.wid,'cube.3mf',lambda action: action())
        self.assertEqual(set(receipt),{'version','workspace_id','export_id','filename','sha256','size_bytes'})
        export=self.out/self.wid/receipt['export_id']
        self.assertEqual((export/'content').read_bytes(),b'cube-data')
        self.assertEqual(json.loads((export/'receipt.json').read_text()),receipt)
        self.assertEqual(stat.S_IMODE(export.stat().st_mode),0o2750)
        self.assertEqual(stat.S_IMODE((export/'content').stat().st_mode),0o440)
        with self.assertRaises(ValueError): self.store.delete(self.wid,receipt['export_id'],'0'*64)
        self.assertTrue(export.exists()); self.store.delete(self.wid,receipt['export_id'],receipt['sha256'])
        self.assertFalse(export.exists()); self.assertTrue(self.source.exists())
    def test_wrong_workspace_symlink_traversal_and_quota(self):
        (self.art/self.wid/'link').symlink_to(self.source)
        for name in ('link','../cube.3mf','/etc/passwd'):
            with self.assertRaises((ValueError,OSError)): self.store.publish(self.wid,name,lambda action: action())
        with self.assertRaises((ValueError,OSError)): self.store.publish('b'*43,'cube.3mf',lambda action: action())
        self.store.max_slots=1; self.store.publish(self.wid,'cube.3mf',lambda action: action())
        with self.assertRaises(ValueError): self.store.publish(self.wid,'cube.3mf',lambda action: action())
    def test_changed_source_never_publishes(self):
        old_read=os.read; mutated=False
        def change(fd,n):
            nonlocal mutated
            data=old_read(fd,n)
            if data and not mutated:
                mutated=True; self.source.write_bytes(b'changed!!')
            return data
        with patch('export_store.os.read',side_effect=change):
            with self.assertRaises(ValueError): self.store.publish(self.wid,'cube.3mf',lambda action: action())
        self.assertFalse(any((self.out/self.wid).iterdir()))
    def test_active_settlement_blocks_native_and_close_then_expires(self):
        self.w.state='active'; self.w.workspace_id=self.wid; self.w.generation=1; self.w.idle=self.w.hard=100
        self.w.clock=lambda:0
        self.backend.publication_idle=lambda gen:True
        entered=threading.Event(); release=threading.Event(); original=self.store.publish; results=[]
        def paused(*args): entered.set(); release.wait(2); return original(*args)
        self.store.publish=paused
        t=threading.Thread(target=lambda:results.append(self.w.publish_file(self.wid,'cube.3mf'))); t.start()
        self.assertTrue(entered.wait(1))
        with self.assertRaises(WorkspaceError): self.w.authorize(self.wid)
        with self.assertRaises(WorkspaceError): self.w.close(self.wid)
        release.set(); t.join(3); self.assertFalse(t.is_alive()); self.assertEqual(self.w.state,'active'); self.assertEqual(len(results),1)
    def test_limits_fail_closed(self):
        with self.assertRaises(ValueError): limits({'ORCA_EXPORT_MAX_SLOTS':'0'})
        with self.assertRaises(ValueError): limits({'ORCA_EXPORT_MAX_FILE_BYTES':'9999999999999999'})
    def test_competing_publications_respect_quota(self):
        self.store.max_slots=1; barrier=threading.Barrier(3); results=[]
        def publish():
            barrier.wait()
            try: results.append(self.store.publish(self.wid,'cube.3mf',lambda action: action()))
            except ValueError: results.append(None)
        threads=[threading.Thread(target=publish) for _ in range(2)]
        for thread in threads: thread.start()
        barrier.wait()
        for thread in threads: thread.join(3); self.assertFalse(thread.is_alive())
        self.assertEqual(sum(result is not None for result in results),1)
    def test_source_size_limit_and_receipt_tampering(self):
        self.store.max_file=4
        with self.assertRaises(ValueError): self.store.publish(self.wid,'cube.3mf',lambda action: action())
        self.store.max_file=1024
        receipt=self.store.publish(self.wid,'cube.3mf',lambda action: action())
        content=self.out/self.wid/receipt['export_id']/'content'
        os.chmod(content,0o600); content.write_bytes(b'tampered!')
        with self.assertRaises(ValueError): self.store.delete(self.wid,receipt['export_id'],receipt['sha256'])
        self.assertTrue(content.exists())
    def test_process_death_releases_outbox_lock(self):
        import fcntl
        lock=self.store._lock(); os.close(lock)
        code='import fcntl,sys,time; f=open(sys.argv[1],"r+"); fcntl.flock(f,fcntl.LOCK_EX); print("locked",flush=True); time.sleep(30)'
        child=subprocess.Popen([sys.executable,'-c',code,str(self.out/'.orca-export.lock')],stdout=subprocess.PIPE,text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(),'locked')
            fd=os.open(self.out/'.orca-export.lock',os.O_RDWR)
            try:
                with self.assertRaises(BlockingIOError): fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            finally: os.close(fd)
            child.kill(); child.wait(timeout=3)
            self.assertEqual(self.store.publish(self.wid,'cube.3mf',lambda action: action())['size_bytes'],9)
        finally:
            if child.poll() is None: child.kill(); child.wait()
            child.stdout.close()
    def test_expiry_and_dialog_refuse_publication(self):
        self.w.state='active'; self.w.workspace_id=self.wid; self.w.generation=1; self.w.idle=self.w.hard=100
        now=[0]; self.w.clock=lambda:now[0]; self.backend.publication_idle=lambda gen:False
        with self.assertRaises(WorkspaceError): self.w.publish_file(self.wid,'cube.3mf')
        self.backend.publication_idle=lambda gen:True
        def expires(*args): now[0]=100; return ExportStore.publish(self.store,*args)
        self.store.publish=expires
        with self.assertRaises(WorkspaceError): self.w.publish_file(self.wid,'cube.3mf')
        self.assertEqual(self.w.state,'active'); self.assertFalse(any((self.out/self.wid).iterdir()))
    def test_inflight_and_wrong_workspace_are_rejected(self):
        self.w.state='active'; self.w.workspace_id=self.wid; self.w.generation=1; self.w.idle=self.w.hard=100; self.w.clock=lambda:0
        with self.assertRaises(WorkspaceError): self.w.publish_file('b'*43,'cube.3mf')
        self.w.active=1
        with self.assertRaises(WorkspaceError): self.w.publish_file(self.wid,'cube.3mf')
    def test_commit_barrier_rejects_shutdown_and_expiry_before_rename(self):
        for condition in ('shutdown','expiry'):
            with self.subTest(condition=condition), tempfile.TemporaryDirectory() as d:
                root=Path(d); out=root/'out'; out.mkdir(); os.chmod(out,0o2750)
                art=root/'art'; art.mkdir(); backend=OrcaBackend(root/'state',artifact_root=art)
                store=ExportStore(out,os.getgid(),art,1024,8192,3)
                w=Workspace(backend,export_store=store); wid='p'*43; w.attach(wid)
                (art/wid/'file').write_bytes(b'content')
                now=[0]; w.clock=lambda:now[0]; w.state='active'; w.workspace_id=wid; w.generation=1; w.idle=w.hard=100
                backend.publication_idle=lambda gen:True; backend.checkpoint=lambda gen:False; backend.stop=lambda gen:True
                entered=threading.Event(); release=threading.Event(); original=store.publish; errors=[]
                def delayed(wid,path,commit):
                    def at_commit(action):
                        entered.set(); self.assertTrue(release.wait(3)); commit(action)
                    return original(wid,path,at_commit)
                store.publish=delayed
                def publish():
                    try: w.publish_file(wid,'file')
                    except Exception as e: errors.append(e)
                thread=threading.Thread(target=publish); thread.start(); self.assertTrue(entered.wait(2))
                stopper=None
                if condition=='shutdown':
                    stopper=threading.Thread(target=w.shutdown); stopper.start()
                    import time
                    deadline=time.monotonic()+2
                    while not w.shutting_down and time.monotonic()<deadline: time.sleep(.01)
                    self.assertTrue(w.shutting_down)
                else:
                    now[0]=100; self.assertIsNone(w.expire_if_due())
                release.set(); thread.join(3); self.assertFalse(thread.is_alive())
                if stopper: stopper.join(3); self.assertFalse(stopper.is_alive())
                self.assertEqual(len(errors),1); self.assertIsInstance(errors[0],WorkspaceError)
                self.assertFalse(any((out/wid).iterdir()))
    def test_crashes_during_preparation_and_recorded_deletion_are_recovered(self):
        # The subprocess dies while holding the real flock, at each on-disk window.
        published=self.store.publish(self.wid,'cube.3mf',lambda action:action())
        code='''import os,signal,sys
from export_store import ExportStore
out,art,wid,phase,eid,digest=sys.argv[1:]
s=ExportStore(out,os.getgid(),art,1024,8192,2)
real=os.rename
def crash(src,dst):
    if phase=='delete': real(src,dst)
    os.kill(os.getpid(),signal.SIGKILL)
os.rename=crash
if phase=='prepare': s.publish(wid,'cube.3mf',lambda action:action())
else: s.delete(wid,eid,digest)
'''
        def run_crash(phase,receipt):
            p=subprocess.run([sys.executable,'-c',code,str(self.out),str(self.art),self.wid,phase,receipt['export_id'],receipt['sha256']],capture_output=True,timeout=5)
            self.assertNotEqual(p.returncode,0,p.stderr.decode())
        run_crash('prepare',published)
        self.assertTrue(any(x.name.startswith('.prepare-') for x in (self.out/self.wid).iterdir()))
        added=self.store.publish(self.wid,'cube.3mf',lambda action:action())
        self.assertTrue((self.out/self.wid/published['export_id']).exists())
        self.assertFalse(any(x.name.startswith('.prepare-') for x in (self.out/self.wid).iterdir()))
        run_crash('delete',added)
        self.assertTrue((self.out/self.wid/('.delete-'+added['export_id'])).exists())
        third=self.store.publish(self.wid,'cube.3mf',lambda action:action())
        self.assertTrue((self.out/self.wid/published['export_id']).exists())
        self.assertTrue((self.out/self.wid/third['export_id']).exists())
        self.assertFalse((self.out/self.wid/('.delete-'+added['export_id'])).exists())
    def test_attach_rejects_bad_manifest_without_modification(self):
        manifest=self.root/'workspaces'/self.wid/'manifest.json'
        for raw in ('{}','{"state":"new","recovery_required":false}', '{bad'):
            manifest.write_text(raw)
            with self.assertRaises(WorkspaceError): self.w.attach(self.wid)
            self.assertEqual(manifest.read_text(),raw)
        raw='{"state":"active","recovery_required":true,"last_checkpoint":null}'
        manifest.write_text(raw); self.assertFalse(self.w.attach(self.wid)['created']); self.assertEqual(manifest.read_text(),raw)
if __name__=='__main__': unittest.main()
