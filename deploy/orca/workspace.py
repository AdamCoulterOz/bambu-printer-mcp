"""Durable opaque workspace resources sharing one bounded Orca worker."""
import secrets
import os
import threading
import time

class WorkspaceError(Exception): pass

class Workspace:
    def __init__(self, backend, idle_seconds=900, hard_seconds=14400, clock=time.monotonic, export_store=None):
        if not 1 <= idle_seconds <= hard_seconds <= 86400: raise ValueError('invalid workspace deadlines')
        self.backend, self.idle_seconds, self.hard_seconds, self.clock = backend, idle_seconds, hard_seconds, clock
        self.export_store=export_store
        self.lock=threading.RLock(); self.state='idle'; self.generation=0; self.workspace_id=None; self.active=0; self.shutting_down=False; self.storage_active=0
    def create(self):
        with self.lock:
            if self.shutting_down: raise WorkspaceError('server shutting down')
            workspace_id=secrets.token_urlsafe(32)
            self.backend.create(workspace_id)
            return {'workspace_id':workspace_id,'worker_busy':self.state!='idle'}
    def attach(self, workspace_id):
        with self.lock:
            if self.shutting_down: raise WorkspaceError('server shutting down')
            try: created=self.backend.attach(workspace_id)
            except ValueError as e: raise WorkspaceError(str(e)) from e
            return {'workspace_id':workspace_id,'created':created,'worker_busy':self.state!='idle'}
    def publish_file(self, workspace_id, relative_path):
        with self.lock:
            if self.shutting_down or self.state!='active' or self.clock()>=min(self.idle,self.hard): raise WorkspaceError('workspace unavailable or expired')
            if not isinstance(workspace_id,str) or not secrets.compare_digest(workspace_id,self.workspace_id): raise WorkspaceError('invalid workspace ID')
            if self.active: raise WorkspaceError('workspace has in-flight calls')
            if self.export_store is None: raise WorkspaceError('export sharing is not configured')
            gen=self.generation; self.state='publishing'
        try:
            if not self.backend.publication_idle(gen): raise WorkspaceError('workspace has jobs or dialogs')
            def commit(action):
                with self.lock:
                    if self.shutting_down or self.state!='publishing' or self.generation!=gen or self.clock()>=min(self.idle,self.hard): raise WorkspaceError('workspace expired or revoked during publication')
                    action()
            return self.export_store.publish(workspace_id,relative_path,commit)
        finally:
            with self.lock:
                if self.generation==gen and self.state=='publishing': self.state='active'
    def export_delete(self, workspace_id, export_id, sha256):
        with self.lock:
            if self.shutting_down: raise WorkspaceError('server shutting down')
            if not isinstance(workspace_id,str) or not self.backend.exists(workspace_id): raise WorkspaceError('unknown workspace; use workspace_attach for a common ID')
            if self.export_store is None: raise WorkspaceError('export sharing is not configured')
            self.storage_active+=1
        try: return self.export_store.delete(workspace_id,export_id,sha256)
        finally:
            with self.lock: self.storage_active-=1
    def open(self, workspace_id):
        with self.lock:
            if self.shutting_down: raise WorkspaceError('server shutting down')
            if self.state!='idle': raise WorkspaceError('worker busy')
            if not isinstance(workspace_id,str) or not self.backend.exists(workspace_id): raise WorkspaceError('unknown workspace; use workspace_attach for a common ID')
            if not self.backend.can_open(workspace_id): raise WorkspaceError('workspace requires recovery; verified checkpoint unavailable')
            self.state='starting'; self.generation+=1; gen=self.generation; self.workspace_id=workspace_id
        try: self.backend.start(gen,secrets.token_hex(32),workspace_id)
        except BaseException:
            with self.lock: self.state='settling'; self.workspace_id=None
            stopped=False
            try: stopped=self.backend.stop(gen)
            finally:
                with self.lock: self.state='idle' if stopped else 'stopping'
            raise
        with self.lock:
            now=self.clock(); self.hard=now+self.hard_seconds; self.idle=min(now+self.idle_seconds,self.hard); self.state='active'
            return {'workspace_id':workspace_id,'idle_expires_in':self.idle_seconds,'hard_expires_in':self.hard_seconds}
    def status(self, workspace_id=None):
        with self.lock:
            if workspace_id is not None and (not isinstance(workspace_id,str) or not self.backend.exists(workspace_id)): raise WorkspaceError('unknown workspace; use workspace_attach for a common ID')
            if self.state=='active':
                result={'busy':True,'expires_in':max(0,min(self.idle,self.hard)-self.clock())}
                if workspace_id is not None:
                    result['active']=secrets.compare_digest(workspace_id,self.workspace_id)
                    result.update(self.backend.describe(workspace_id))
                return result
            result={'busy':self.state!='idle','state':self.state,'active':False}
            if workspace_id is not None: result.update(self.backend.describe(workspace_id))
            return result
    def authorize(self, workspace_id):
        with self.lock:
            now=self.clock()
            if self.shutting_down: raise WorkspaceError('server shutting down')
            if self.state!='active' or now>=min(self.idle,self.hard): raise WorkspaceError('workspace worker unavailable or expired')
            if not isinstance(workspace_id,str) or not secrets.compare_digest(workspace_id,self.workspace_id): raise WorkspaceError('invalid workspace ID')
            self.idle=min(now+self.idle_seconds,self.hard); self.active+=1
            return self.generation
    def finish(self,generation):
        with self.lock:
            if generation==self.generation and self.active>0: self.active-=1
    def close(self,workspace_id=None,expired=False):
        with self.lock:
            if self.state!='active': raise WorkspaceError('workspace not active')
            if expired and self.clock()<min(self.idle,self.hard): raise WorkspaceError('workspace renewed')
            if not expired and (not isinstance(workspace_id,str) or not secrets.compare_digest(workspace_id,self.workspace_id)): raise WorkspaceError('invalid workspace ID')
            gen=self.generation; can_checkpoint=not expired and self.active==0
            self.state='settling'; self.workspace_id=None
        stopped=False
        try:
            checkpointed=self.backend.checkpoint(gen) if can_checkpoint else False
            stopped=self.backend.stop(gen)
            checkpointed=bool(checkpointed and stopped and self.backend.commit_checkpoint(gen))
            return {'closed':bool(stopped),'checkpointed':bool(checkpointed),'unfinished_outcome':'unknown'}
        finally:
            with self.lock:
                if self.generation==gen:
                    self.state='idle' if stopped else 'stopping'
                    if stopped: self.active=0
    def expire_if_due(self):
        with self.lock: expired=self.state=='active' and self.clock()>=min(self.idle,self.hard)
        if expired:
            try: return self.close(expired=True)
            except WorkspaceError: pass
        return None
    def retry_stop(self):
        with self.lock:
            if self.state!='stopping': return self.state=='idle'
            gen=self.generation; self.state='settling'
        stopped=False
        try:
            stopped=self.backend.stop(gen)
            return bool(stopped)
        finally:
            with self.lock:
                if self.generation==gen:
                    self.state='idle' if stopped else 'stopping'
                    if stopped: self.active=0
    def shutdown(self):
        # A starting or settling operation remains its own lifecycle owner.
        # Wait for it to relinquish ownership before attempting cleanup.
        with self.lock: self.shutting_down=True
        while True:
            with self.lock:
                state=self.state; workspace_id=self.workspace_id; storage_active=self.storage_active
            if state=='idle':
                if not storage_active: return True
                time.sleep(.05)
            if state=='active':
                try: self.close(workspace_id)
                except WorkspaceError: pass
            elif state=='stopping':
                if not self.retry_stop(): return False
            else: time.sleep(.05)

def shutdown_or_exit(workspace, server, timeout=15, exit_process=os._exit):
    outcome=[]
    def settle():
        try: outcome.append(workspace.shutdown())
        except BaseException: outcome.append(False)
    thread=threading.Thread(target=settle,daemon=True); thread.start(); thread.join(timeout)
    if thread.is_alive() or outcome != [True]:
        # Do not close the listener or release its flock while a lifecycle
        # owner may still be running. Process exit releases it atomically.
        exit_process(1)
        return False
    if server: server.server_close()
    return True
