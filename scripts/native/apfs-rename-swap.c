#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/attr.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/stdio.h>
#include <unistd.h>

static int inspect_directory(const char *path, struct stat *result) {
  if (lstat(path, result) != 0) {
    perror(path);
    return 0;
  }
  if (!S_ISDIR(result->st_mode) || S_ISLNK(result->st_mode)) {
    fprintf(stderr, "bundle path must be a real directory: %s\n", path);
    return 0;
  }
  return 1;
}

static int parent_path(const char *path, char *result, size_t length) {
  if (strlen(path) >= length) return 0;
  strcpy(result, path);
  char *slash = strrchr(result, '/');
  if (slash == NULL) return 0;
  if (slash == result) slash[1] = '\0';
  else *slash = '\0';
  return 1;
}

static int volume_supports_swap(const char *path) {
  struct statfs filesystem;
  if (statfs(path, &filesystem) != 0) {
    perror("statfs");
    return 0;
  }
  if (strcmp(filesystem.f_fstypename, "apfs") != 0) {
    fprintf(stderr, "filesystem must be APFS: %s\n", filesystem.f_fstypename);
    return 0;
  }

  struct attrlist attributes;
  memset(&attributes, 0, sizeof(attributes));
  attributes.bitmapcount = ATTR_BIT_MAP_COUNT;
  attributes.volattr = ATTR_VOL_CAPABILITIES;
  struct {
    uint32_t length;
    vol_capabilities_attr_t capabilities;
  } response;
  memset(&response, 0, sizeof(response));
  if (getattrlist(path, &attributes, &response, sizeof(response), 0) != 0) {
    perror("getattrlist");
    return 0;
  }
  if ((response.capabilities.valid[VOL_CAPABILITIES_INTERFACES]
       & VOL_CAP_INT_RENAME_SWAP) == 0
      || (response.capabilities.capabilities[VOL_CAPABILITIES_INTERFACES]
          & VOL_CAP_INT_RENAME_SWAP) == 0) {
    fprintf(stderr, "filesystem does not advertise atomic rename swap\n");
    return 0;
  }
  return 1;
}

int main(int argc, char **argv) {
  if (argc != 3 && argc != 4) {
    fprintf(stderr, "usage: apfs-rename-swap --probe PATH | --swap LEFT RIGHT\n");
    return 64;
  }
  if (strcmp(argv[1], "--probe") == 0 && argc == 3) {
    struct stat directory;
    return inspect_directory(argv[2], &directory) && volume_supports_swap(argv[2]) ? 0 : 65;
  }
  if (strcmp(argv[1], "--swap") != 0 || argc != 4) return 64;

  struct stat left_before;
  struct stat right_before;
  if (!inspect_directory(argv[2], &left_before) || !inspect_directory(argv[3], &right_before)) return 65;
  if (left_before.st_dev != right_before.st_dev || left_before.st_ino == right_before.st_ino) {
    fprintf(stderr, "bundle directories must be distinct entries on one filesystem\n");
    return 66;
  }

  char left_parent[PATH_MAX];
  char right_parent[PATH_MAX];
  if (!parent_path(argv[2], left_parent, sizeof(left_parent))
      || !parent_path(argv[3], right_parent, sizeof(right_parent))
      || strcmp(left_parent, right_parent) != 0) {
    fprintf(stderr, "bundle directories must share one parent\n");
    return 67;
  }
  if (!volume_supports_swap(left_parent)) return 68;

  if (renameatx_np(AT_FDCWD, argv[2], AT_FDCWD, argv[3], RENAME_SWAP) != 0) {
    perror("renameatx_np");
    return 69;
  }

  struct stat left_after;
  struct stat right_after;
  if (!inspect_directory(argv[2], &left_after) || !inspect_directory(argv[3], &right_after)
      || left_after.st_dev != right_before.st_dev || left_after.st_ino != right_before.st_ino
      || right_after.st_dev != left_before.st_dev || right_after.st_ino != left_before.st_ino) {
    fprintf(stderr, "post-swap inode verification failed\n");
    return 70;
  }

  int parent = open(left_parent, O_RDONLY | O_CLOEXEC);
  if (parent < 0 || fsync(parent) != 0) {
    perror("parent fsync");
    if (parent >= 0) close(parent);
    return 71;
  }
  close(parent);
  return 0;
}
