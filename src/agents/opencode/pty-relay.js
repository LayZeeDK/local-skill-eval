#!/usr/bin/env node
/**
 * pty-relay — run a command under a PTY and relay its output to stdout.
 *
 * Solves the Bun buffering problem on ARM64 Linux: Bun uses libc full
 * buffering (~4-8 KB) when stdout is a pipe.  If `timeout` kills the
 * process before the buffer fills, the output is lost (0 bytes).
 * By giving the child a PTY via node-pty, libc switches to line
 * buffering and flushes after every newline.
 *
 * Usage: node pty-relay.js <timeout_sec> <command> [args...]
 * Exit:  child's exit code, or 124 on timeout (coreutils convention).
 */
'use strict';

const pty = require('node-pty');

const args = process.argv.slice(2);

if (args.length < 2) {
    process.stderr.write('Usage: pty-relay <timeout_sec> <command> [args...]\n');
    process.exit(1);
}

const timeoutSec = parseInt(args[0], 10);
const cmd = args[1];
const cmdArgs = args.slice(2);

const proc = pty.spawn(cmd, cmdArgs, {
    cols: 200,
    rows: 50,
    env: process.env,
});

proc.onData(data => process.stdout.write(data));

let done = false;

function cleanup(code) {
    if (done) {
        return;
    }

    done = true;

    // Kill the entire process group (child session) to clean up
    // orphan processes (Ollama background workers, etc.)
    try {
        process.kill(-proc.pid, 'SIGKILL');
    } catch {
        // Process group may already be gone
    }

    process.exit(code);
}

// On child exit, wait briefly for remaining data events, then exit
proc.onExit(({ exitCode }) => {
    clearTimeout(timer);
    setTimeout(() => cleanup(exitCode), 300);
});

// Hard deadline: timeout + 10s grace
const timer = setTimeout(() => cleanup(124), (timeoutSec + 10) * 1000);

// Forward signals from parent (GHA step cancellation)
process.on('SIGTERM', () => cleanup(143));
process.on('SIGINT', () => cleanup(130));
