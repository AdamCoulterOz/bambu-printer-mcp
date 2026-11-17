"""Linux-only actual detached-child lifecycle fixture. Never launches Orca."""
import sys
import tempfile
import unittest
from pathlib import Path
from orca_backend import OrcaBackend

class ProcessSnapshotTests(unittest.TestCase):
    @staticmethod
    def inject(error, backend=OrcaBackend):
        from unittest.mock import patch
        class Entry:
            def __init__(self,name,content): self.name,self.content=name,content
            def __truediv__(self,_): return self
            def read_text(self):
                if isinstance(self.content,BaseException): raise self.content
                return self.content
        class Proc:
            def iterdir(self):
                return iter([Entry('10',error),Entry('11','11 (alive) S 1 11 '+'0 '*16+'12345')])
        with patch('orca_backend.Path',return_value=Proc()): return backend.process_snapshot()

    def test_exited_entry_skipped_without_dropping_other_processes(self):
        import errno
        for error in (ProcessLookupError(errno.ESRCH,'process exited'),FileNotFoundError(errno.ENOENT,'process exited')):
            with self.subTest(error=type(error).__name__):
                self.assertEqual(self.inject(error),{11:('12345',11)})

    def test_non_disappearance_snapshot_errors_fail_closed_before_signalling(self):
        import errno
        from unittest.mock import patch
        for error in (PermissionError(errno.EACCES,'denied'),OSError(errno.EIO,'io error'),'malformed'):
            with self.subTest(error=type(error).__name__):
                with self.assertRaises(RuntimeError): self.inject(error)
                backend=OrcaBackend('/unused'); backend.current={'generation':1,'pid':99,'identity':'99','baseline':{}}
                with patch.object(backend,'identity',return_value='99'), patch.object(backend,'process_snapshot',side_effect=lambda:self.inject(error)), patch('orca_backend.os.killpg') as kill:
                    self.assertFalse(backend.stop(1));self.assertTrue(backend.current['unsettled']);kill.assert_not_called()
                    self.assertFalse(backend.stop(1));kill.assert_not_called()

@unittest.skipUnless(sys.platform=='linux' and Path('/proc/self/stat').exists(), 'requires Linux procfs')
class ProcDisappearanceWitnessTests(unittest.TestCase):
    def test_open_stat_then_reap_returns_esrch_and_snapshot_skips_it(self):
        import errno,os,subprocess
        child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(300)'])
        fd=None
        try:
            fd=os.open(f'/proc/{child.pid}/stat',os.O_RDONLY)
            child.terminate();child.wait(timeout=5)
            with self.assertRaises(ProcessLookupError) as caught: os.read(fd,4096)
            self.assertEqual(caught.exception.errno,errno.ESRCH)
            self.assertEqual(ProcessSnapshotTests.inject(caught.exception),{11:('12345',11)})
        finally:
            if fd is not None: os.close(fd)
            if child.poll() is None: child.kill();child.wait(timeout=5)

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

class SessionWrapperTests(unittest.TestCase):
    def test_wrapper_is_a_direct_exec_and_in_both_build_contexts(self):
        base=Path(__file__).parent
        self.assertEqual((base/'orca-session').read_text().splitlines()[-1],
                         'exec /usr/bin/dbus-run-session -- /opt/orca/AppRun "$@"')
        self.assertIn('!orca-session', (base/'.dockerignore').read_text().splitlines())
        for name in ('Dockerfile','Dockerfile.runtime'):
            docker=(base/name).read_text()
            copy=docker.index('COPY orca-session /opt/orca-runtime/orca-session')
            chmod=docker.index('RUN chmod 755 /opt/orca-runtime/orca-session')
            user=docker.index('USER 10001:10001')
            self.assertLess(copy,chmod); self.assertLess(chmod,user)
            self.assertIn('test -x /usr/bin/dbus-run-session',docker)
            self.assertIn('test -x /usr/bin/dbus-daemon',docker)

@unittest.skipUnless(sys.platform=='linux' and Path('/proc/self/stat').exists() and Path('/usr/bin/dbus-run-session').is_file() and Path('/usr/bin/dbus-daemon').is_file(), 'requires Linux and real D-Bus binaries')
class SessionBusLifecycleTests(unittest.TestCase):
    def fixture(self, d):
        import os
        root=Path(d); output=root/'app.json'; app=root/'AppRun'; wrapper=root/'session'; harness=root/'harness.py'
        app.write_text('''#!/usr/bin/python3
import json,os,pathlib,signal,sys,time
if os.environ.get('FIXTURE_IGNORE_TERM') == '1': signal.signal(signal.SIGTERM, signal.SIG_IGN)
pathlib.Path(os.environ['FIXTURE_OUTPUT']).write_text(json.dumps({'pid':os.getpid(),'ppid':os.getppid(),'pgid':os.getpgrp(),'args':sys.argv[1:],'display':os.environ.get('DISPLAY'),'token':os.environ.get('ORCA_MCP_TOKEN'),'bus':bool(os.environ.get('DBUS_SESSION_BUS_ADDRESS'))}))
if os.environ.get('FIXTURE_EXIT') != '1': time.sleep(300)
'''); app.chmod(0o755)
        actual=(Path(__file__).parent/'orca-session').read_text()
        self.assertEqual(actual.count('/opt/orca/AppRun'),1)
        wrapper.write_text(actual.replace('/opt/orca/AppRun',str(app)));wrapper.chmod(0o755)
        harness.write_text('''import json,os,subprocess,sys,time
args=sys.argv[1:]; binary=args[args.index('--bin')+1]; datadir=args[args.index('--datadir')+1]
app=subprocess.Popen([binary,'--datadir',datadir,'--mcp','--mcp-port','13619','--cad'],start_new_session=True)
display=subprocess.Popen([sys.executable,'-c','import time; time.sleep(300)'],start_new_session=True)
with open(os.environ['ORCA_MCP_SESSION'],'w') as f: json.dump({'pid':app.pid,'display_server_pid':display.pid},f)
''')
        return wrapper,harness,output

    def test_natural_app_exit_ends_private_bus(self):
        import os,subprocess,time
        with tempfile.TemporaryDirectory() as d:
            wrapper,_,output=self.fixture(d)
            env=dict(os.environ,FIXTURE_OUTPUT=str(output),FIXTURE_EXIT='1',DISPLAY=':fixture',ORCA_MCP_TOKEN='fixture-token')
            run=subprocess.Popen([str(wrapper),'--datadir','/fixture profile','--mcp'],env=env,start_new_session=True)
            self.assertEqual(run.wait(timeout=10),0)
            data=__import__('json').loads(output.read_text());self.assertTrue(data['bus'])
            self.assertEqual(data['args'],['--datadir','/fixture profile','--mcp'])
            self.assertEqual(data['display'],':fixture');self.assertEqual(data['token'],'fixture-token')
            backend=OrcaBackend(d);deadline=time.monotonic()+3
            while any(entry[1]==run.pid for entry in backend.process_snapshot().values()) and time.monotonic()<deadline: time.sleep(.05)
            self.assertFalse(any(entry[1]==run.pid for entry in backend.process_snapshot().values()))

    def test_backend_owns_runner_bus_and_app_group_and_escalates(self):
        import os,time,json
        from unittest.mock import patch
        for ignore in (False,True):
            with self.subTest(ignore_term=ignore),tempfile.TemporaryDirectory() as d:
                wrapper,harness,output=self.fixture(d);backend=OrcaBackend(d,harness=str(harness),binary=str(wrapper));wid='s'*43;backend.create(wid)
                env={'FIXTURE_OUTPUT':str(output),'DISPLAY':':fixture','FIXTURE_IGNORE_TERM':'1' if ignore else '0'}
                with patch.dict(os.environ,env):
                    stop_attempted=False
                    try:
                        backend.start(1,'a'*64,wid);runner=backend.current['pid'];display=backend.current['display_pid']
                        deadline=time.monotonic()+5
                        while not output.exists() and time.monotonic()<deadline: time.sleep(.05)
                        self.assertTrue(output.exists());data=json.loads(output.read_text())
                        self.assertEqual(data['ppid'],runner);self.assertEqual(data['pgid'],runner);self.assertTrue(data['bus'])
                        self.assertEqual(data['display'],':fixture');self.assertEqual(data['token'],'a'*64)
                        self.assertEqual(data['args'],['--datadir',str(backend.current['job']/'profile'),'--mcp','--mcp-port','13619','--cad'])
                        children=Path(f'/proc/{runner}/task/{runner}/children').read_text().split()
                        procs=[int(pid) for pid in children]
                        bus=[pid for pid in procs if Path(f'/proc/{pid}/comm').read_text().strip()=='dbus-daemon']
                        self.assertEqual(len(bus),1);self.assertEqual(os.getpgid(bus[0]),runner)
                        self.assertNotEqual(display,runner)
                        started=time.monotonic();stop_attempted=True
                        self.assertTrue(backend.stop(1), 'backend stop failed')
                        if ignore: self.assertGreaterEqual(time.monotonic()-started,4.5)
                        self.assertFalse(any(entry[1] in (runner,display) for entry in backend.process_snapshot().values()))
                    finally:
                        if backend.current and not stop_attempted: backend.stop(1)

if __name__=='__main__': unittest.main()
