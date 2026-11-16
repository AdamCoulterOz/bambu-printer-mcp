import json
import tempfile
import unittest
from pathlib import Path
from orca_backend import OrcaBackend
class StorageTests(unittest.TestCase):
    def test_manifest_survives_new_backend_and_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            a=OrcaBackend(directory); workspace_id='a'*43; a.create(workspace_id)
            artifact=Path(directory)/'workspaces'/workspace_id/'artifacts'/'part.3mf'; artifact.write_bytes(b'retained')
            b=OrcaBackend(directory); self.assertTrue(b.exists(workspace_id)); self.assertTrue(b.can_open(workspace_id))
            job=artifact.parent.parent; b.write_manifest(job,{'state':'active','recovery_required':True,'last_checkpoint':None})
            c=OrcaBackend(directory); self.assertFalse(c.can_open(workspace_id)); self.assertEqual(artifact.read_bytes(),b'retained')
            self.assertFalse(c.exists('../'+workspace_id))
if __name__=='__main__': unittest.main()

class CheckpointTests(unittest.TestCase):
    def test_checkpoint_commits_only_after_exit_and_corruption_blocks(self):
        import zipfile
        with tempfile.TemporaryDirectory() as directory:
            b=OrcaBackend(directory); workspace_id='b'*43; b.create(workspace_id)
            job=Path(directory)/'workspaces'/workspace_id
            b.write_manifest(job,{'state':'active','recovery_required':True,'last_checkpoint':None})
            b.current={'generation':1,'job':job}
            def call(name,args):
                if name=='wait': return {'satisfied':True}
                if name=='get_app_state': return {'jobs':[]}
                with zipfile.ZipFile(args['path'],'w') as archive:
                    archive.writestr('3D/3dmodel.model','synthetic'); archive.writestr('[Content_Types].xml','synthetic')
                return {'path':args['path'],'bytes':Path(args['path']).stat().st_size}
            b.call=call
            self.assertTrue(b.checkpoint(1)); self.assertFalse(b.commit_checkpoint(1)); self.assertFalse(b.can_open(workspace_id))
            b.current=None; self.assertTrue(b.commit_checkpoint(1)); self.assertTrue(b.can_open(workspace_id))
            manifest=json.loads((job/'manifest.json').read_text()); (job/'checkpoints'/manifest['last_checkpoint']['name']).write_bytes(b'changed')
            # start performs the checksum check before clearing the clean manifest.
            with self.assertRaises(RuntimeError): b.start(2,'0'*64,workspace_id)
    def test_running_job_never_checkpoints(self):
        with tempfile.TemporaryDirectory() as directory:
            b=OrcaBackend(directory); b.current={'generation':1,'job':Path(directory)}
            b.call=lambda name,args: {'satisfied':True} if name=='wait' else {'jobs':[{'state':'running'}]}
            self.assertFalse(b.checkpoint(1)); self.assertIsNone(b.pending_checkpoint)

class LaunchIdentityTests(unittest.TestCase):
    def test_unprovable_shutdown_is_permanent_and_blocks_checkpoint(self):
        from unittest.mock import patch
        b=OrcaBackend('/unused'); b.current={'generation':1,'pid':12345,'identity':'original','display_pid':None}
        with patch.object(b,'identity',return_value='original'), patch.object(b,'stop_group',side_effect=RuntimeError('snapshot unavailable')):
            self.assertFalse(b.stop(1)); self.assertTrue(b.current['unsettled'])
        with patch.object(b,'stop_group',return_value=True) as stop_group:
            self.assertFalse(b.stop(1)); stop_group.assert_not_called()
        self.assertFalse(b.commit_checkpoint(1))
    def test_timeout_never_adopts_stale_session_or_signals_old_pid(self):
        from unittest.mock import patch
        import subprocess
        with tempfile.TemporaryDirectory() as directory:
            b=OrcaBackend(directory); wid='d'*43; b.create(wid)
            job=Path(directory)/'workspaces'/wid
            (job/'session.json').write_text('{"pid":12345}')
            with patch('orca_backend.subprocess.run',side_effect=subprocess.TimeoutExpired('fixture',1)), patch.object(b,'process_snapshot',return_value={}), patch('orca_backend.os.killpg') as kill:
                with self.assertRaises(subprocess.TimeoutExpired): b.start(1,'a'*64,wid)
                self.assertNotEqual(b.current['session'],job/'session.json')
                self.assertFalse(b.stop(1)); kill.assert_not_called()
    def test_reused_pid_is_not_signalled(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            b=OrcaBackend(directory); b.current={'generation':1,'pid':12345,'identity':'original','display_pid':None}
            with patch.object(b,'identity',return_value='different'),patch.object(b,'process_snapshot',return_value={}),patch('orca_backend.os.killpg') as kill:
                self.assertTrue(b.stop(1));kill.assert_not_called()

class ResultContractTests(unittest.TestCase):
    def test_save_running_or_dialog_is_not_success(self):
        import zipfile
        for response in ({'status':'running','job_id':'j'}, {'status':'blocked_by_dialog'}):
            with tempfile.TemporaryDirectory() as directory:
                b=OrcaBackend(directory); wid='e'*43;b.create(wid);job=Path(directory)/'workspaces'/wid
                b.current={'generation':1,'job':job}
                def call(name,args):
                    if name=='wait': return {'satisfied':True}
                    if name=='get_app_state': return {'jobs':[]}
                    with zipfile.ZipFile(args['path'],'w') as z:
                        z.writestr('[Content_Types].xml','x');z.writestr('3D/3dmodel.model','x')
                    return response
                b.call=call;self.assertFalse(b.checkpoint(1))
    def test_restore_requires_project_and_exact_clean_path(self):
        b=OrcaBackend('/unused'); saved=Path('/tmp/checked.3mf')
        for opened,state in [({'status':'running'},{}),({'status':'blocked_by_dialog'},{}),({'opened':'project'},{'project':{'path':'/tmp/other.3mf','dirty':False}})]:
            b.call=lambda name,args: opened if name=='open_files' else state
            with self.assertRaises(RuntimeError): b.restore(saved)
    def test_changed_checkpoint_after_exit_never_commits(self):
        import zipfile
        with tempfile.TemporaryDirectory() as directory:
            b=OrcaBackend(directory);wid='f'*43;b.create(wid);job=Path(directory)/'workspaces'/wid
            b.write_manifest(job,{'state':'active','recovery_required':True,'last_checkpoint':None});b.current={'generation':1,'job':job}
            def call(name,args):
                if name=='wait': return {'satisfied':True}
                if name=='get_app_state': return {'jobs':[]}
                with zipfile.ZipFile(args['path'],'w') as z:
                    z.writestr('[Content_Types].xml','x');z.writestr('3D/3dmodel.model','x')
                return {'path':args['path'],'bytes':Path(args['path']).stat().st_size}
            b.call=call;self.assertTrue(b.checkpoint(1)); b.current=None
            path=job/'checkpoints'/b.pending_checkpoint[2]['name'];path.write_bytes(b'changed')
            self.assertFalse(b.commit_checkpoint(1));self.assertFalse(b.can_open(wid))

class ProbeTests(unittest.TestCase):
    def test_probe_is_not_a_workspace_and_is_deleted_only_after_exit(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            b=OrcaBackend(directory); alive={'value':False}
            def launch(cmd,env,**kw):
                Path(env['ORCA_MCP_SESSION']).write_text('{"pid":12345}');alive['value']=True
            def identity(pid): return 'one' if alive['value'] else None
            def kill(pid,sig): alive['value']=False
            with patch('orca_backend.subprocess.run',side_effect=launch),patch.object(b,'identity',side_effect=identity),patch.object(b,'process_snapshot',side_effect=lambda:{12345:('one',12345)} if alive['value'] else {}),patch('orca_backend.os.killpg',side_effect=kill):
                b.start(0,'a'*64);path=b.current['job'];self.assertEqual(path.parent.name,'probes')
                self.assertFalse((Path(directory)/'workspaces').exists());self.assertTrue(b.stop(0));self.assertFalse(path.exists())
    def test_unidentified_failed_probe_is_retained(self):
        import subprocess
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            b=OrcaBackend(directory)
            with patch('orca_backend.subprocess.run',side_effect=subprocess.TimeoutExpired('fixture',1)),patch.object(b,'process_snapshot',return_value={}):
                with self.assertRaises(subprocess.TimeoutExpired): b.start(0,'a'*64)
                path=b.current['job'];self.assertFalse(b.stop(0));self.assertTrue(path.exists())
