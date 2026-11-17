#!/usr/bin/env python3
"""Operation-owned kernel lock and no-follow export reader; never a daemon."""
import fcntl
import os
import stat
import struct
import sys


def open_dir(path, boundary, gid):
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        current = ''
        for component in os.path.abspath(path).split('/'):
            if component:
                next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = next_fd
                current += '/' + component
                if current == boundary or current.startswith(boundary + '/'):
                    info = os.fstat(fd)
                    if info.st_gid != gid or stat.S_IMODE(info.st_mode) != 0o2750:
                        raise ValueError('invalid outbox directory permissions')
        return fd
    except BaseException:
        os.close(fd)
        raise


def read_file(directory, name, limit, gid):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size > limit or before.st_gid != gid or stat.S_IMODE(before.st_mode) != 0o440:
            raise ValueError('not a bounded regular file')
        chunks = []
        while True:
            chunk = os.read(fd, min(1048576, limit + 1 - sum(map(len, chunks))))
            if not chunk:
                break
            chunks.append(chunk)
            if sum(map(len, chunks)) > limit:
                raise ValueError('file too large')
        after = os.fstat(fd)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError('file changed')
        return b''.join(chunks)
    finally:
        os.close(fd)


if len(sys.argv) > 1 and sys.argv[1] == 'read-export':
    gid = int(sys.argv[6])
    boundary = os.path.abspath(sys.argv[2])
    directory = open_dir(os.path.join(boundary, sys.argv[3], sys.argv[4]), boundary, gid)
    try:
        receipt = read_file(directory, 'receipt.json', 4096, gid)
        content = read_file(directory, 'content', int(sys.argv[5]), gid)
        sys.stdout.buffer.write(struct.pack('!I', len(receipt)))
        sys.stdout.buffer.write(receipt)
        sys.stdout.buffer.write(content)
        sys.stdout.buffer.flush()
    finally:
        os.close(directory)
else:
    # fd 3 is inherited from the Node owner.  Do not unlock: its open file
    # description remains locked until Node closes its own descriptor.
    fcntl.flock(3, fcntl.LOCK_EX)
