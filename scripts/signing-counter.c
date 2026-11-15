/* Original POSIX counter: stable flock inode, durable rename before returning.
 * No time/lease based lock recovery. OS releases flock on process exit. */
#define _DARWIN_C_SOURCE
#define _DEFAULT_SOURCE
#define _POSIX_C_SOURCE 200809L
#define _XOPEN_SOURCE 700
#include <sys/file.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <errno.h>
#include <string.h>
#include <limits.h>
#ifndef O_NOFOLLOW
#error O_NOFOLLOW required
#endif
static void die(void) { fputs("SIGNING_SEQUENCE_UNAVAILABLE\n", stderr); exit(1); }
static int safe(int fd, int directory) {
 struct stat st; return fd >= 0 && fstat(fd,&st)==0 && st.st_uid==geteuid() &&
 (directory ? S_ISDIR(st.st_mode) && !(st.st_mode&0077) : S_ISREG(st.st_mode) && !(st.st_mode&0077) && st.st_nlink==1);
}
static unsigned long parse(const char *s) {
 if(!*s) die(); for(const char *p=s;*p;p++) if(*p<'0'||*p>'9') die();
 errno=0; char *end; unsigned long n=strtoul(s,&end,10); if(errno || *end || n<20000 || n>2147483647UL) die(); return n;
}
int main(int argc,char **argv) {
 if(argc!=3 && argc!=4) die(); int initialize=!strcmp(argv[1],"init"), checking=!strcmp(argv[1],"check"); if(!initialize && !checking && strcmp(argv[1],"next")) die();
 if((initialize && argc!=4)||(!initialize && argc!=3)||argv[2][0]!='/') die();
 char resolved[PATH_MAX]; if(!realpath(argv[2],resolved) || strcmp(resolved,argv[2])) die();
 int dir=open(argv[2],O_RDONLY|O_DIRECTORY|O_NOFOLLOW); if(!safe(dir,1)) die();
 int lock=openat(dir,"counter.lock",O_CREAT|O_RDWR|O_NOFOLLOW,0600); if(!safe(lock,0)||flock(lock,LOCK_EX)) die();
 unsigned long n; int fd=openat(dir,"counter",O_RDONLY|O_NOFOLLOW);
 if(initialize) { if(fd>=0 || errno!=ENOENT) die(); n=parse(argv[3]); }
 else {
  if(!safe(fd,0)) die(); char buf[64]; ssize_t len=read(fd,buf,sizeof(buf)-1); if(len<=0||len>20) die(); buf[len]=0;
  n=parse(buf); if(!checking) { if(n==2147483647UL) die(); n++; }
 }
 if(fd>=0) close(fd);
 if(checking) { printf("%lu\n",n); close(lock); close(dir); return 0; }
 /* Stale temp files from a killed process are harmless and never lock owners. */
 char tmp[80]; snprintf(tmp,sizeof(tmp),"counter.tmp.%ld",(long)getpid());
 int out=openat(dir,tmp,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW,0600); if(!safe(out,0)) die();
 char value[32]; int len=snprintf(value,sizeof(value),"%lu",n);
 if(write(out,value,(size_t)len)!=len || fsync(out) || close(out) || renameat(dir,tmp,dir,"counter") || fsync(dir)) die();
 if(printf("%lu\n",n)<0 || fflush(stdout)) die();
 close(lock); close(dir); return 0;
}
