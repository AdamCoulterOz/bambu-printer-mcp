"""Linux-only actual detached-child lifecycle fixture. Never launches Orca."""
import sys
import tempfile
import unittest
from pathlib import Path
from orca_backend import OrcaBackend

@unittest.skipUnless(sys.platform=='linux' and Path('/proc/self/stat').exists(), 'requires Linux procfs')
class LinuxProcessTests(unittest.TestCase):
    def test_stop_waits_for_real_detached_processes_and_retains_artifacts(self):
        with tempfile.TemporaryDirectory() as d:
            script=Path(d)/'fake_harness.py'
            script.write_text('''import json,os,subprocess,sys\napp=subprocess.Popen([sys.executable,"-c","import time; time.sleep(300)"],start_new_session=True)\ndisplay=subprocess.Popen([sys.executable,"-c","import time; time.sleep(300)"],start_new_session=True)\nwith open(os.environ["ORCA_MCP_SESSION"],"w") as f: json.dump({"pid":app.pid,"display_server_pid":display.pid},f)\n''')
            backend=OrcaBackend(d,harness=str(script),binary='/unused')
            wid='c'*43; backend.create(wid)
            artifact=Path(d)/'workspaces'/wid/'artifacts'/'kept.3mf'; artifact.write_bytes(b'fixture')
            try:
                backend.start(1,'a'*64,wid); child=backend.current['pid']; display=backend.current['display_pid']
                self.assertIsNotNone(backend.identity(child)); self.assertTrue(backend.stop(1))
                self.assertIsNone(backend.identity(child)); self.assertIsNone(backend.identity(display))
                self.assertEqual(artifact.read_bytes(),b'fixture')
            finally:
                if backend.current: backend.stop(1)
    def test_leader_exits_but_term_ignoring_group_child_is_killed(self):
        import time
        with tempfile.TemporaryDirectory() as d:
            script=Path(d)/'fake_harness.py'
            ready=Path(d)/'ready'; term=Path(d)/'term'
            child="import signal,time,pathlib; signal.signal(signal.SIGTERM, lambda *_: pathlib.Path(%r).write_text('received')); pathlib.Path(%r).write_text('ready'); time.sleep(300)" % (str(term),str(ready))
            code='import subprocess,sys,time; subprocess.Popen([sys.executable,"-c",%r]); time.sleep(300)' % child
            script.write_text("""import json,os,subprocess,sys
code=%r
app=subprocess.Popen([sys.executable,'-c',code],start_new_session=True)
with open(os.environ['ORCA_MCP_SESSION'],'w') as f: json.dump({'pid':app.pid},f)
""" % code)
            backend=OrcaBackend(d,harness=str(script),binary='/unused')
            wid='g'*43;backend.create(wid)
            try:
                backend.start(1,'a'*64,wid);pgid=backend.current['pid']
                deadline=time.monotonic()+3
                while not ready.exists() and time.monotonic()<deadline: time.sleep(.05)
                self.assertTrue(ready.exists())
                self.assertGreaterEqual(len([x for x in backend.process_snapshot().values() if x[1]==pgid]),2)
                self.assertTrue(backend.stop(1))
                self.assertTrue(term.exists(), 'child must receive and survive SIGTERM until escalation')
                self.assertFalse(any(x[1]==pgid for x in backend.process_snapshot().values()))
            finally:
                if backend.current: backend.stop(1)
    def test_detached_child_prevents_reuse_and_checkpoint_commit(self):
        import os, signal, time
        with tempfile.TemporaryDirectory() as d:
            marker=Path(d)/'detached.pid'; script=Path(d)/'fake_harness.py'
            script.write_text("""import json,os,subprocess,sys
code='import os,subprocess,sys,time; p=subprocess.Popen([sys.executable,"-c","import time; time.sleep(300)"],start_new_session=True); open(sys.argv[1],"w").write(str(p.pid)); time.sleep(300)'
app=subprocess.Popen([sys.executable,'-c',code,sys.argv[1]],start_new_session=True)
with open(os.environ['ORCA_MCP_SESSION'],'w') as f: json.dump({'pid':app.pid},f)
""")
            # Harness arguments are fixed, so use an embedded marker path.
            script.write_text(script.read_text().replace('sys.argv[1]],start_new_session=True)',repr(str(marker))+'],start_new_session=True)'))
            backend=OrcaBackend(d,harness=str(script),binary='/unused'); wid='h'*43; backend.create(wid)
            detached=None
            try:
                backend.start(1,'a'*64,wid)
                deadline=time.monotonic()+3
                while not marker.exists() and time.monotonic()<deadline: time.sleep(.05)
                detached=int(marker.read_text())
                self.assertFalse(backend.stop(1)); self.assertTrue(backend.current['unsettled'])
                self.assertFalse(backend.stop(1)); self.assertFalse(backend.can_open(wid))
                self.assertFalse(backend.commit_checkpoint(1))
            finally:
                if detached:
                    try: os.killpg(detached,signal.SIGKILL)
                    except ProcessLookupError: pass
if __name__=='__main__': unittest.main()
