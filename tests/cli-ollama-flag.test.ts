/**
 * Unit tests for --agent=ollama CLI integration.
 * Verifies CLI source contains the necessary wiring without running the CLI.
 */
import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
    if (condition) {
        console.log(`  [PASS] ${message}`);
        passed++;
    } else {
        console.error(`  [FAIL] ${message}`);
        failed++;
    }
}

console.log('CLI --agent=ollama flag tests\n');

const cliSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli.ts'), 'utf-8');

// Test 1: Help text includes ollama
assert(cliSource.includes('--agent=gemini|claude|ollama'), 'Help text contains ollama as an agent option');

// Test 2: OllamaToolAgent import present
assert(cliSource.includes("import { OllamaToolAgent }"), 'OllamaToolAgent import is present in cli.ts');

// Test 3: smokeTestToolCalling import present
assert(cliSource.includes("import { smokeTestToolCalling }"), 'smokeTestToolCalling import is present in cli.ts');

// Test 4: Agent selection handles ollama case
assert(cliSource.includes("case 'ollama'"), 'Agent selection logic handles the ollama case');

// Test 5: Smoke test gate for ollama
assert(cliSource.includes("agentType === 'ollama'"), 'Smoke test gate checks for ollama agent type');

// Test 6: OllamaToolAgent instantiation
assert(cliSource.includes('new OllamaToolAgent()'), 'OllamaToolAgent is instantiated in CLI');

// Summary
console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
