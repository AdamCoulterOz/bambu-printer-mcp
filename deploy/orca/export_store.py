"""Data-only, crash-locked export publication; originals remain in Orca storage."""
import fcntl
import hashlib
import json
import os
import re
import secrets
import shutil
import stat
from pathlib import Path

ID = re.compile(r'^[A-Za-z0-9_-]{43}$')
HEX = re.compile(r'^[0-9a-f]{64}$')

def limits(env):
    def number(key, default, ceiling):
        value=env.get(key,str(default))
        if not value.isascii() or not value.isdigit() or not 1 <= int(value) <= ceiling:
            raise ValueError('invalid '+key)
        return int(value)
    f=number('ORCA_EXPORT_MAX_FILE_BYTES',128*1024*1024,2*1024*1024*1024)
    t=number('ORCA_EXPORT_MAX_TOTAL_BYTES',2*1024*1024*1024,64*1024*1024*1024)
    s=number('ORCA_EXPORT_MAX_SLOTS',512,100000)
    if f>t: raise ValueError('file limit exceeds outbox limit')
    return f,t,s

def _identity(st): return (st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,st.st_ctime_ns)
def _fsync_dir(path):
    fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try: os.fsync(fd)
    finally: os.close(fd)

def _open_source(root, relative):
    if not isinstance(relative,str) or not relative or '\x00' in relative or relative.startswith('/'):
        raise ValueError('invalid relative path')
    parts=relative.split('/')
    if any(x in ('','.','..') for x in parts): raise ValueError('invalid relative path')
    fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            new=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            os.close(fd); fd=new
        source=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
        if not stat.S_ISREG(os.fstat(source).st_mode) or os.fstat(source).st_nlink!=1:
            os.close(source); raise ValueError('source is not a regular file')
        return source,parts[-1]
    finally: os.close(fd)

class ExportStore:
    def __init__(self, root, gid, artifact_root, max_file, max_total, max_slots):
        self.root=Path(root); self.gid=gid; self.artifacts=Path(artifact_root)
        self.max_file,self.max_total,self.max_slots=max_file,max_total,max_slots
        self._dir(self.root,0o2750)
    def _dir(self,path,mode):
        st=os.lstat(path)
        if not stat.S_ISDIR(st.st_mode) or st.st_uid!=os.getuid() or st.st_gid!=self.gid or stat.S_IMODE(st.st_mode)!=mode:
            raise ValueError('invalid outbox directory ownership or mode')
    def _lock(self):
        fd=os.open(self.root/'.orca-export.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
        try:
            st=os.fstat(fd); pst=os.lstat(self.root/'.orca-export.lock')
            if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or st.st_nlink!=1 or stat.S_IMODE(st.st_mode)!=0o600 or (st.st_dev,st.st_ino)!=(pst.st_dev,pst.st_ino): raise ValueError('invalid export lock')
            fcntl.flock(fd,fcntl.LOCK_EX)
            self._recover()
            return fd
        except BaseException: os.close(fd); raise
    def _recover(self):
        # The crash-released lock proves no cooperating publisher or deleter
        # still owns these reserved temporary names. Final IDs are untouched.
        for workspace in self.root.iterdir():
            if workspace.name=='.orca-export.lock': continue
            if re.fullmatch(r'\.workspace-[A-Za-z0-9_-]{43}',workspace.name):
                st=os.lstat(workspace)
                if not stat.S_ISDIR(st.st_mode) or st.st_uid!=os.getuid() or st.st_gid!=self.gid or stat.S_IMODE(st.st_mode) not in (0o700,0o2700,0o2750) or os.listdir(workspace): raise ValueError('invalid incomplete workspace directory')
                os.rmdir(workspace); _fsync_dir(self.root); continue
            if not ID.fullmatch(workspace.name): raise ValueError('unexpected outbox entry')
            self._dir(workspace,0o2750)
            for entry in workspace.iterdir():
                if ID.fullmatch(entry.name): continue
                if not re.fullmatch(r'\.(?:prepare|delete)-[A-Za-z0-9_-]{43}',entry.name): raise ValueError('unexpected export entry')
                st=os.lstat(entry)
                if not stat.S_ISDIR(st.st_mode) or st.st_uid!=os.getuid() or st.st_gid!=self.gid or stat.S_IMODE(st.st_mode) not in (0o700,0o2700,0o2770,0o2750): raise ValueError('invalid incomplete export')
                for item in entry.iterdir():
                    info=os.lstat(item)
                    if item.name not in ('content','receipt.json') or not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_gid!=self.gid or info.st_nlink!=1: raise ValueError('invalid incomplete export content')
                shutil.rmtree(entry); _fsync_dir(workspace)
    def _usage(self):
        count=total=0
        for workspace in self.root.iterdir():
            if workspace.name=='.orca-export.lock': continue
            if not ID.fullmatch(workspace.name): raise ValueError('unexpected outbox entry')
            self._dir(workspace,0o2750)
            for export in workspace.iterdir():
                if not (ID.fullmatch(export.name) or export.name.startswith('.prepare-') or export.name.startswith('.delete-')): raise ValueError('unexpected export entry')
                st=os.lstat(export)
                if not stat.S_ISDIR(st.st_mode) or st.st_uid!=os.getuid() or st.st_gid!=self.gid: raise ValueError('invalid export directory')
                count+=1
                for item in export.iterdir():
                    st=os.lstat(item)
                    if not stat.S_ISREG(st.st_mode) or st.st_nlink!=1: raise ValueError('invalid export file')
                    total+=st.st_size
        return count,total
    def publish(self, wid, relative, commit):
        if not ID.fullmatch(wid): raise ValueError('invalid workspace')
        source,filename=_open_source(self.artifacts/wid,relative)
        lock=None; stage=None
        try:
            before=os.fstat(source)
            if before.st_size<=0 or before.st_size>self.max_file: raise ValueError('file exceeds allowed size')
            lock=self._lock(); count,total=self._usage()
            if count>=self.max_slots or total+before.st_size>self.max_total: raise ValueError('outbox quota exceeded')
            wd=self.root/wid
            if not os.path.lexists(wd):
                new_workspace=self.root/('.workspace-'+wid)
                os.mkdir(new_workspace,0o2750); os.chmod(new_workspace,0o2750)
                self._dir(new_workspace,0o2750); _fsync_dir(new_workspace)
                os.rename(new_workspace,wd); _fsync_dir(self.root)
            self._dir(wd,0o2750)
            eid=secrets.token_urlsafe(32); stage=wd/('.prepare-'+eid)
            os.mkdir(stage,0o2770); os.chmod(stage,0o2770)
            self._dir(stage,0o2770)
            fd=os.open(stage/'content',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
            h=hashlib.sha256(); size=0
            try:
                with os.fdopen(fd,'wb') as out:
                    while True:
                        chunk=os.read(source,1024*1024)
                        if not chunk: break
                        size+=len(chunk)
                        if size>before.st_size or size>self.max_file: raise ValueError('source changed')
                        h.update(chunk); out.write(chunk)
                    out.flush(); os.fchmod(out.fileno(),0o440); os.fsync(out.fileno())
                    if os.fstat(out.fileno()).st_gid!=self.gid: raise ValueError('content group mismatch')
                if size!=before.st_size or _identity(os.fstat(source))!=_identity(before): raise ValueError('source changed')
                os.lseek(source,0,os.SEEK_SET); check=hashlib.sha256()
                while True:
                    chunk=os.read(source,1024*1024)
                    if not chunk: break
                    check.update(chunk)
                if check.digest()!=h.digest() or _identity(os.fstat(source))!=_identity(before): raise ValueError('source changed')
                copied=hashlib.sha256()
                with open(stage/'content','rb') as copied_file:
                    copied_stat=os.fstat(copied_file.fileno())
                    for chunk in iter(lambda:copied_file.read(1024*1024),b''): copied.update(chunk)
                    if copied.digest()!=h.digest() or copied_stat.st_size!=size or _identity(os.fstat(copied_file.fileno()))!=_identity(copied_stat): raise ValueError('copied content changed')
                reopened,_=_open_source(self.artifacts/wid,relative)
                try:
                    if _identity(os.fstat(reopened))!=_identity(before): raise ValueError('source path changed')
                finally: os.close(reopened)
                receipt={'version':1,'workspace_id':wid,'export_id':eid,'filename':filename,'sha256':h.hexdigest(),'size_bytes':size}
                data=json.dumps(receipt,separators=(',',':')).encode()
                if total+size+len(data)>self.max_total: raise ValueError('outbox quota exceeded')
                rfd=os.open(stage/'receipt.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
                with os.fdopen(rfd,'wb') as out:
                    out.write(data); out.flush(); os.fchmod(out.fileno(),0o440); os.fsync(out.fileno())
                    if os.fstat(out.fileno()).st_gid!=self.gid: raise ValueError('receipt group mismatch')
                os.chmod(stage,0o2750); _fsync_dir(stage)
                def rename_final():
                    if os.path.lexists(wd/eid): raise ValueError('export ID collision')
                    os.rename(stage,wd/eid)
                commit(rename_final)
                stage=None; _fsync_dir(wd)
                return receipt
            finally:
                if stage is not None: shutil.rmtree(stage)
        finally:
            if lock is not None: os.close(lock)
            os.close(source)
    def delete(self,wid,eid,digest):
        if not isinstance(wid,str) or not ID.fullmatch(wid) or not isinstance(eid,str) or not ID.fullmatch(eid) or not isinstance(digest,str) or not HEX.fullmatch(digest): raise ValueError('invalid export identity')
        lock=self._lock()
        try:
            self._usage(); wd=self.root/wid; self._dir(wd,0o2750); target=wd/eid; self._dir(target,0o2750)
            flags=os.O_RDONLY|os.O_NOFOLLOW
            rfd=os.open(target/'receipt.json',flags); cfd=None
            try:
                st=os.fstat(rfd)
                if not stat.S_ISREG(st.st_mode) or st.st_size>8192: raise ValueError('invalid receipt')
                data=json.loads(os.read(rfd,8193))
                cfd=os.open(target/'content',flags); cst=os.fstat(cfd)
                if not stat.S_ISREG(cst.st_mode) or cst.st_size>self.max_file: raise ValueError('invalid content')
                h=hashlib.sha256()
                while True:
                    chunk=os.read(cfd,1024*1024)
                    if not chunk: break
                    h.update(chunk)
                if set(data)!={'version','workspace_id','export_id','filename','sha256','size_bytes'} or data['version']!=1 or data['workspace_id']!=wid or data['export_id']!=eid or data['sha256']!=digest or data['size_bytes']!=cst.st_size or h.hexdigest()!=digest or _identity(os.fstat(cfd))!=_identity(cst): raise ValueError('export identity or hash mismatch')
            finally:
                os.close(rfd)
                if cfd is not None: os.close(cfd)
            if set(os.listdir(target))!={'content','receipt.json'}: raise ValueError('unexpected export contents')
            pending=wd/('.delete-'+eid); os.rename(target,pending); _fsync_dir(wd)
            shutil.rmtree(pending); _fsync_dir(wd)
            return {'version':1,'workspace_id':wid,'export_id':eid,'sha256':digest,'deleted':True}
        finally: os.close(lock)
