import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs-extra';

async function main() {
    console.log('Running path traversal tests...');
    let passed = 0;
    let failed = 0;

    function test(name: string, fn: () => void): void {
        try {
            fn();
            console.log(`  [OK] ${name}`);
            passed++;
        } catch (e: any) {
            console.error(`  [FAIL] ${name}: ${e.message}`);
            failed++;
        }
    }

    const { resolveWorkspacePath } = require('../src/agents/ollama/tools');

    // Create a temporary workspace for testing
    const workspaceRoot = path.join(os.tmpdir(), 'path-traversal-test-' + Date.now());
    await fs.ensureDir(workspaceRoot);
    await fs.ensureDir(path.join(workspaceRoot, 'subdir'));
    await fs.writeFile(path.join(workspaceRoot, 'subdir', 'file.txt'), 'test');
    await fs.writeFile(path.join(workspaceRoot, 'root-file.txt'), 'test');

    try {
        // --- Rejection cases ---

        test('Rejects relative path ../../../etc/passwd', () => {
            assert.throws(
                () => resolveWorkspacePath(workspaceRoot, '../../../etc/passwd'),
                /Path traversal blocked/
            );
        });

        test('Rejects absolute path /etc/passwd', () => {
            assert.throws(
                () => resolveWorkspacePath(workspaceRoot, '/etc/passwd'),
                /Path traversal blocked/
            );
        });

        // --- Allowed cases ---

        test('Allows path with .. that resolves inside workspace (subdir/../root-file.txt)', () => {
            const resolved = resolveWorkspacePath(workspaceRoot, 'subdir/../root-file.txt');
            assert.strictEqual(
                path.normalize(resolved),
                path.normalize(path.join(workspaceRoot, 'root-file.txt'))
            );
        });

        test('Allows normal relative path src/index.ts', () => {
            const resolved = resolveWorkspacePath(workspaceRoot, 'src/index.ts');
            assert.strictEqual(
                path.normalize(resolved),
                path.normalize(path.join(workspaceRoot, 'src', 'index.ts'))
            );
        });

        test('Allows workspace root path .', () => {
            const resolved = resolveWorkspacePath(workspaceRoot, '.');
            assert.strictEqual(
                path.normalize(resolved),
                path.normalize(workspaceRoot)
            );
        });

        test('Allows path exactly equal to workspace root', () => {
            const resolved = resolveWorkspacePath(workspaceRoot, '');
            assert.strictEqual(
                path.normalize(resolved),
                path.normalize(workspaceRoot)
            );
        });
    } finally {
        // Cleanup
        await fs.remove(workspaceRoot);
    }

    // Summary
    console.log(`\n${passed} passed, ${failed} failed`);

    if (failed > 0) {
        process.exit(1);
    }

    console.log('[SUCCESS] All path traversal tests passed.');
}

main();
