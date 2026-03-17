/**
 * pty-relay — run a command under a PTY and relay its output to stdout.
 *
 * Solves the Bun buffering problem on ARM64 Linux: Bun uses libc full
 * buffering (~4-8 KB) when stdout is a pipe.  If `timeout` kills the
 * process before the buffer fills, the output is lost (0 bytes).
 * By giving the child a PTY, libc switches to line buffering and
 * flushes after every newline.
 *
 * Previous PTY approaches failed on GitHub Actions CI:
 *   - script --flush:  PTY session (setsid) breaks signal delivery
 *   - unbuffer:        interact needs terminal; -p exits on stdin EOF
 *   - Python pty.fork: PEP 475 auto-retries waitpid on EINTR from
 *                      SIGALRM, so the hard deadline never fires
 *
 * This C implementation avoids all three issues:
 *   - No setsid — signals propagate normally
 *   - No stdin dependency — we only relay stdout
 *   - No PEP 475 — EINTR returns immediately in C
 *
 * Usage: pty-relay <timeout_sec> <command> [args...]
 * Exit:  child's exit code, or 124 if killed by timeout (matches
 *        coreutils timeout convention).
 *
 * Compile: gcc -O2 -o pty-relay pty-relay.c -lutil
 */

#include <errno.h>
#include <pty.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>

static volatile sig_atomic_t got_alarm = 0;

static void alarm_handler(int sig) {
    (void)sig;
    got_alarm = 1;
}

int main(int argc, char *argv[]) {
    if (argc < 3) {
        fprintf(stderr, "Usage: pty-relay <timeout_sec> <command> [args...]\n");
        return 1;
    }

    int timeout_sec = atoi(argv[1]);

    if (timeout_sec <= 0) {
        fprintf(stderr, "pty-relay: timeout must be > 0\n");
        return 1;
    }

    int master;
    pid_t pid = forkpty(&master, NULL, NULL, NULL);

    if (pid < 0) {
        perror("forkpty");
        return 1;
    }

    if (pid == 0) {
        /* Child: exec the command (argv[2..]) */
        execvp(argv[2], &argv[2]);
        perror("execvp");
        _exit(127);
    }

    /* Parent: relay PTY output to stdout with hard deadline. */
    struct sigaction sa;
    sa.sa_handler = alarm_handler;
    sa.sa_flags = 0;           /* no SA_RESTART — read() must return EINTR */
    sigemptyset(&sa.sa_mask);
    sigaction(SIGALRM, &sa, NULL);
    alarm(timeout_sec + 10);   /* hard deadline: timeout + 10s grace */

    char buf[4096];
    ssize_t n;

    while (!got_alarm) {
        n = read(master, buf, sizeof(buf));

        if (n > 0) {
            /* Write all bytes to stdout.  Partial writes are possible
             * when stdout is a pipe and the reader is slow. */
            ssize_t written = 0;

            while (written < n) {
                ssize_t w = write(STDOUT_FILENO, buf + written, n - written);

                if (w < 0) {
                    if (errno == EINTR) {
                        continue;
                    }

                    break;  /* stdout closed or error */
                }

                written += w;
            }
        } else if (n == 0) {
            break;  /* EOF — all slave fds closed */
        } else {
            /* n < 0 */
            if (errno == EINTR) {
                continue;  /* interrupted by signal, check got_alarm */
            }

            if (errno == EIO) {
                break;  /* child exited, PTY slave closed */
            }

            break;  /* unexpected error */
        }
    }

    /* Reap child (non-blocking to avoid hanging on orphans). */
    int status = 0;
    pid_t w = waitpid(pid, &status, WNOHANG);

    if (w == 0) {
        /* Child still running — send SIGTERM, wait briefly, then SIGKILL. */
        kill(pid, SIGTERM);
        usleep(500000);  /* 500ms grace */
        w = waitpid(pid, &status, WNOHANG);

        if (w == 0) {
            kill(pid, SIGKILL);
            waitpid(pid, &status, 0);
        }
    }

    close(master);

    if (got_alarm) {
        return 124;  /* match coreutils timeout exit code */
    }

    if (WIFEXITED(status)) {
        return WEXITSTATUS(status);
    }

    return 1;
}
