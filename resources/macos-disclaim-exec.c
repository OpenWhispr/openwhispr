/*
 * macos-disclaim-exec: exec a program as its own TCC "responsible process".
 *
 * A process spawned from a terminal-launched app inherits the terminal as its
 * responsible process, so macOS reads privacy usage strings (and attributes
 * permission prompts) from the terminal's Info.plist instead of the target
 * binary's. Disclaiming responsibility before exec makes the target process
 * responsible for itself, so its embedded __info_plist usage strings apply.
 *
 * Dev-only: used when spawning macos-calendar-listener from a non-packaged
 * app. Packaged builds are launched via LaunchServices and are already
 * self-responsible.
 *
 * Compile: cc -O2 macos-disclaim-exec.c -o macos-disclaim-exec
 */

#include <spawn.h>
#include <stdio.h>

extern char **environ;
extern int responsibility_spawnattrs_setdisclaim(posix_spawnattr_t *attrs, int disclaim);

int main(int argc, char *argv[]) {
  if (argc < 2) {
    fprintf(stderr, "usage: %s <program> [args...]\n", argv[0]);
    return 64;
  }
  posix_spawnattr_t attr;
  posix_spawnattr_init(&attr);
  /* SETEXEC replaces this process instead of forking, so the caller keeps the
     same pid, stdio pipes, and exit semantics as a direct spawn. */
  posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETEXEC);
  responsibility_spawnattrs_setdisclaim(&attr, 1);
  int rc = posix_spawn(NULL, argv[1], NULL, &attr, &argv[1], environ);
  fprintf(stderr, "disclaim-exec: failed to exec %s: %d\n", argv[1], rc);
  return 127;
}
