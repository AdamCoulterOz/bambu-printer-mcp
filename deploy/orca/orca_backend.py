"""Owns one upstream harness instance; unfinished outcomes remain unknown."""
import json
import hashlib
import http.client
import zipfile
import os
import secrets
import re
import shutil
import signal
import subprocess
import time
import tempfile
from pathlib import Path

class OrcaBackend:
    def __init__(self, root, template=None, artifact_root=None, harness='/opt/orca-harness/orca_mcp.py', binary='/opt/orca/AppRun'):
        self.root=Path(root); self.template=Path(template) if template else None
        self.artifact_root=Path(artifact_root) if artifact_root else None
        self.harness, self.binary=harness,binary
        self.current=None
        self.pending_checkpoint=None
    @staticmethod
    def identity(pid):
        try:
            text=Path(f'/proc/{pid}/stat').read_text()
            fields=text[text.rfind(')')+2:].split()
            if fields[0] == 'Z': return None
            return fields[19]
        except (OSError, IndexError): return None
    @staticmethod
    def process_snapshot():
        processes={}
        for entry in Path('/proc').iterdir():
            if not entry.name.isdigit(): continue
            try:
                text=(entry/'stat').read_text(); fields=text[text.rfind(')')+2:].split()
                if fields[0]=='Z': continue
                processes[int(entry.name)]=(fields[19],int(fields[2]))
            except FileNotFoundError: continue  # process exited during enumeration
            except (OSError,ValueError,IndexError) as exc:
                raise RuntimeError('cannot establish process identity snapshot') from exc
        return processes
    def stop_group(self, pgid, baseline):
        def members():
            return {pid:entry for pid,entry in self.process_snapshot().items() if entry[1]==pgid}
        group=members()
        if any(pid in baseline and baseline[pid]==entry for pid,entry in group.items()): return False
        if group:
            try: os.killpg(pgid,signal.SIGTERM)
            except ProcessLookupError: pass
            deadline=time.monotonic()+5
            while members() and time.monotonic()<deadline: time.sleep(.1)
            if members():
                group=members()
                if any(pid in baseline and baseline[pid]==entry for pid,entry in group.items()): return False
                try: os.killpg(pgid,signal.SIGKILL)
                except ProcessLookupError: pass
                deadline=time.monotonic()+5
                while members() and time.monotonic()<deadline: time.sleep(.1)
            if members(): return False
        return True
    def exists(self, workspace_id):
        return bool(re.fullmatch(r'[A-Za-z0-9_-]{43}', workspace_id)) and (self.root/'workspaces'/workspace_id/'profile').is_dir()
    def create(self, workspace_id):
        if not re.fullmatch(r'[A-Za-z0-9_-]{43}', workspace_id): raise ValueError('invalid workspace ID')
        job=self.root/'workspaces'/workspace_id
        job.mkdir(parents=True,mode=0o700)
        datadir=job/'profile'
        if self.template: shutil.copytree(self.template,datadir,symlinks=False)
        else: datadir.mkdir(mode=0o700)
        artifact_dir=(self.artifact_root/workspace_id) if self.artifact_root else (job/'artifacts')
        artifact_dir.mkdir(parents=True,mode=0o700)
        self.write_manifest(job, {'state':'new','recovery_required':False,'last_checkpoint':None})
    @staticmethod
    def write_manifest(job, data):
        path=job/'manifest.json'; temporary=job/('manifest.'+secrets.token_hex(8)+'.tmp')
        fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'w') as f:
            json.dump(data,f); f.flush(); os.fsync(f.fileno())
        os.replace(temporary,path)
        fd=os.open(job,os.O_RDONLY)
        try: os.fsync(fd)
        finally: os.close(fd)
    def describe(self, workspace_id):
        try:
            manifest=json.loads((self.root/'workspaces'/workspace_id/'manifest.json').read_text())
            return {'recovery_required':bool(manifest['recovery_required']), 'has_checkpoint':bool(manifest.get('last_checkpoint'))}
        except (OSError,ValueError,KeyError,TypeError): return {'recovery_required':True,'has_checkpoint':False}
    def can_open(self, workspace_id):
        try:
            manifest=json.loads((self.root/'workspaces'/workspace_id/'manifest.json').read_text())
            return manifest['state'] in ('new','checkpointed') and manifest['recovery_required'] is False
        except (OSError,ValueError,KeyError,TypeError): return False
    def start(self, generation, token, workspace_id=None):
        if self.current is not None: raise RuntimeError('previous child is not settled')
        probe=workspace_id is None
        if probe:
            probes=self.root/'probes'; probes.mkdir(parents=True,mode=0o700,exist_ok=True)
            job=Path(tempfile.mkdtemp(prefix='probe-',dir=probes))
            datadir=job/'profile'; datadir.mkdir(mode=0o700)
            self.write_manifest(job, {'state':'new','recovery_required':False,'last_checkpoint':None})
        else:
            if not self.exists(workspace_id): raise ValueError('unknown workspace')
            job=self.root/'workspaces'/workspace_id
            datadir=job/'profile'
            if not self.can_open(workspace_id): raise RuntimeError('workspace requires recovery; verified checkpoint unavailable')
        manifest=json.loads((job/'manifest.json').read_text())
        checkpoint=manifest.get('last_checkpoint')
        if checkpoint:
            saved=job/'checkpoints'/checkpoint['name']
            if not saved.is_file() or hashlib.sha256(saved.read_bytes()).hexdigest()!=checkpoint['sha256']:
                raise RuntimeError('checkpoint missing or changed')
        self.write_manifest(job, {'state':'active','recovery_required':True,'last_checkpoint':checkpoint})
        session_dir=job/'sessions'/secrets.token_hex(16)
        session_dir.mkdir(parents=True,mode=0o700,exist_ok=False)
        session=session_dir/'session.json'
        if session.exists(): raise RuntimeError('session path already exists')
        baseline=self.process_snapshot()
        env=dict(os.environ,ORCA_MCP_SESSION=str(session),ORCA_MCP_TOKEN=token)
        self.current={'generation':generation,'token':token,'session':session,'job':job,'env':env,'probe':probe,'baseline':baseline}
        cmd=['python3',self.harness,'launch','--xvfb','--cad','--datadir',str(datadir),'--bin',self.binary,'--printer','Bambu Lab X2D@0.4','--vendor','BBL','--filament','Bambu PLA Basic @BBL X2D 0.4 nozzle']
        with open(os.devnull,'w') as sink:
            subprocess.run(cmd,env=env,stdout=sink,stderr=sink,timeout=180,check=True)
        data=json.loads(session.read_text()); pid=int(data['pid'])
        identity=self.identity(pid)
        if identity is None: raise RuntimeError('Orca child exited during startup')
        display_pid=data.get('display_server_pid')
        self.current.update(pid=pid,identity=identity,display_pid=display_pid, display_identity=self.identity(int(display_pid)) if display_pid else None)
        if checkpoint:
            self.restore(saved)
    def restore(self, saved):
        opened=self.call('open_files',{'paths':[str(saved)],'as':'project','discard_changes':True})
        if not isinstance(opened,dict) or opened.get('opened')!='project': raise RuntimeError('checkpoint load not confirmed')
        state=self.call('get_app_state',{})
        project=state.get('project') if isinstance(state,dict) else None
        if not isinstance(project,dict) or project.get('path')!=str(saved) or project.get('dirty') is not False:
            raise RuntimeError('restored project identity not confirmed')
    def call(self, name, arguments):
        c=self.current
        if not c: raise RuntimeError('no Orca child')
        body=json.dumps({'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':name,'arguments':arguments}}).encode()
        conn=http.client.HTTPConnection('127.0.0.1',13619,timeout=30)
        try:
            conn.request('POST','/mcp',body,{'Host':'127.0.0.1:13619','Authorization':'Bearer '+c['token'],'Content-Type':'application/json'})
            response=conn.getresponse(); data=json.loads(response.read(8*1024*1024))
            result=data.get('result',{})
            if response.status!=200 or 'error' in data or result.get('isError') or not isinstance(result.get('content'),list): raise RuntimeError('upstream refused operation')
            content=result['content']
            if len(content)!=1 or content[0].get('type')!='text': raise RuntimeError('unexpected upstream result')
            return json.loads(content[0]['text'])
        finally: conn.close()
    def checkpoint(self, generation):
        c=self.current
        if not c or c['generation']!=generation: return False
        try:
            idle=self.call('wait',{'for':'idle','timeout_s':0})
            if not isinstance(idle,dict) or idle.get('satisfied') is not True: return False
            state=self.call('get_app_state',{})
            if not isinstance(state,dict) or not isinstance(state.get('jobs'),list) or any(not isinstance(j,dict) or j.get('state') not in ('done','failed') for j in state['jobs']): return False
            directory=c['job']/'checkpoints'; directory.mkdir(mode=0o700,exist_ok=True)
            name=secrets.token_hex(16)+'.3mf'; path=directory/name
            saved=self.call('save_project',{'path':str(path),'overwrite':False})
            if not isinstance(saved,dict) or saved.get('path')!=str(path) or not isinstance(saved.get('bytes'),int): return False
            if not path.is_file() or path.stat().st_size!=saved['bytes']: return False
            with zipfile.ZipFile(path) as archive:
                names=set(archive.namelist())
                if archive.testzip() is not None or not {'[Content_Types].xml','3D/3dmodel.model'} <= names: return False
            with path.open('rb') as f: os.fsync(f.fileno())
            digest=hashlib.sha256(path.read_bytes()).hexdigest()
            self.pending_checkpoint=(generation,c['job'],{'name':name,'sha256':digest})
            return True
        except (OSError,ValueError,KeyError,TypeError,RuntimeError,zipfile.BadZipFile,http.client.HTTPException): return False
    def commit_checkpoint(self,generation):
        pending=self.pending_checkpoint
        if not pending or pending[0]!=generation or self.current is not None: return False
        path=pending[1]/'checkpoints'/pending[2]['name']
        try:
            if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest()!=pending[2]['sha256']: return False
            with zipfile.ZipFile(path) as archive:
                if archive.testzip() is not None or not {'[Content_Types].xml','3D/3dmodel.model'} <= set(archive.namelist()): return False
        except (OSError,zipfile.BadZipFile): return False
        self.write_manifest(pending[1],{'state':'checkpointed','recovery_required':False,'last_checkpoint':pending[2]})
        self.pending_checkpoint=None
        return True
    def stop(self, generation):
        if self.current is None: return True
        if self.current['generation'] != generation: return False
        c=self.current
        if c.get('unsettled'): return False
        try:
            return self._stop_owned(c)
        except (OSError,RuntimeError,ValueError):
            c['unsettled']=True
            return False
    def _stop_owned(self, c):
        def unsafe():
            c['unsettled']=True
            return False
        # Only identities captured from this successful launch may be signalled.
        # A timeout or failed launch may have detached children we cannot safely
        # identify; the caller must fail-stop the container, never recycle it.
        if 'pid' not in c or 'identity' not in c: return unsafe()
        pid=c['pid']; expected=c['identity']; display=c.get('display_pid')
        baseline=c.get('baseline',{})
        # Do not signal a reused leader PID; if its original group remains, its
        # other members still carry the original process-group ID.
        if self.identity(pid) not in (None,expected):
            if any(entry[1]==pid for entry in self.process_snapshot().values()): return unsafe()
        if display and self.identity(int(display)) not in (None,c.get('display_identity')):
            if any(entry[1]==int(display) for entry in self.process_snapshot().values()): return unsafe()
        if not self.stop_group(pid,baseline): return unsafe()
        if display and not self.stop_group(int(display),baseline): return unsafe()
        remaining=self.process_snapshot()
        if any(pid not in baseline or baseline[pid]!=entry for pid,entry in remaining.items()):
            return unsafe()
        self.current=None
        if c.get('probe'): shutil.rmtree(c['job'])
        return True
