#include <errno.h>
#include <fcntl.h>
#include <libgen.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/clonefile.h>
#include <sys/stat.h>
#include <unistd.h>

int main(int argc, char **argv) {
  struct stat source;
  struct stat destination;

  if (argc != 3) {
    fprintf(stderr, "usage: apfs-clone-file SOURCE DESTINATION\n");
    return 64;
  }
  if (lstat(argv[1], &source) != 0 || !S_ISREG(source.st_mode)) {
    perror("source");
    return 65;
  }
  if (lstat(argv[2], &destination) == 0 || errno != ENOENT) {
    fprintf(stderr, "destination must not exist\n");
    return 66;
  }
  if (clonefile(argv[1], argv[2], CLONE_NOFOLLOW) != 0) {
    perror("clonefile");
    return 67;
  }
  int descriptor = open(argv[2], O_RDONLY | O_CLOEXEC);
  if (descriptor < 0 || fcntl(descriptor, F_FULLFSYNC) != 0) {
    perror("fullfsync");
    if (descriptor >= 0) close(descriptor);
    unlink(argv[2]);
    return 68;
  }
  close(descriptor);
  char *destination_path = strdup(argv[2]);
  if (destination_path == NULL) {
    unlink(argv[2]);
    return 69;
  }
  int directory = open(dirname(destination_path), O_RDONLY | O_CLOEXEC);
  free(destination_path);
  if (directory < 0 || fsync(directory) != 0) {
    perror("directory fsync");
    if (directory >= 0) close(directory);
    unlink(argv[2]);
    return 70;
  }
  close(directory);
  return 0;
}
