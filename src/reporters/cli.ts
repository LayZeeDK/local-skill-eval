import * as fs from 'fs-extra';
import * as path from 'path';

// ─── ANSI helpers ──────────────────────────────────────────
const c = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    gray: '\x1b[90m',
    white: '\x1b[37m',
    bgGreen: '\x1b[42m',
    bgRed: '\x1b[41m',
    bgBlue: '\x1b[44m',
};

function badge(text: string, pass: boolean): string {
    return pass
        ? `${c.bgGreen}${c.bold} ${text} ${c.reset}`
        : `${c.bgRed}${c.bold} ${text} ${c.reset}`;
}

function bar(value: number, width: number = 20): string {
    const filled = Math.round(value * width);
    const empty = width - filled;
    const color = value >= 0.8 ? c.green : value >= 0.5 ? c.yellow : c.red;
    return `${color}${'█'.repeat(filled)}${c.gray}${'░'.repeat(empty)}${c.reset}`;
}

function divider(char = '─', width = 72): string {
    return c.gray + char.repeat(width) + c.reset;
}

function padRight(s: string, len: number): string {
    // Strip ANSI for length calculation
    const visible = s.replace(/\x1b\[[0-9;]*m/g, '');
    return s + ' '.repeat(Math.max(0, len - visible.length));
}

// ─── Main ──────────────────────────────────────────────────
export async function runCliPreview(resultsDir: string) {
    const resolved = path.resolve(resultsDir);
    const files = (await fs.readdir(resolved))
        .filter(f => f.endsWith('.json'))
        .reverse();

    if (!files.length) {
        console.log(`\n  ${c.yellow}📭 No reports found in ${resolved}${c.reset}\n`);
        return;
    }

    console.log(`\n  ${c.bold}📊 Skill Eval Results${c.reset}  ${c.gray}(${files.length} reports from ${resolved})${c.reset}\n`);

    for (const file of files) {
        let report: any;
        try { report = await fs.readJSON(path.join(resolved, file)); }
        catch { continue; }

        const passRate = report.pass_rate ?? 0;
        const isPass = passRate >= 0.5;
        const trials = report.trials || [];
        const avgDur = trials.reduce((s: number, t: any) => s + (t.duration_ms || 0), 0) / (trials.length || 1);
        const totalTokens = trials.reduce((s: number, t: any) => s + (t.input_tokens || 0) + (t.output_tokens || 0), 0);

        // ── Report header
        console.log(divider());
        console.log(`  ${badge(isPass ? 'PASS' : 'FAIL', isPass)}  ${c.bold}${report.task}${c.reset}`);

        // Timestamp from filename
        const ts = file.match(/\d{4}-\d{2}-\d{2}T[\d-]+/)?.[0]?.replace(/-(\d{2})-(\d{2})-/g, ':$1:$2:') || '';
        if (ts) console.log(`  ${c.gray}${ts}${c.reset}`);
        console.log('');

        // ── Summary metrics
        const metrics = [
            [`Pass Rate`, `${(passRate * 100).toFixed(1)}%`, bar(passRate)],
            [`pass@k`, report.pass_at_k != null ? `${(report.pass_at_k * 100).toFixed(1)}%` : '—', report.pass_at_k != null ? bar(report.pass_at_k) : ''],
            [`pass^k`, report.pass_pow_k != null ? `${(report.pass_pow_k * 100).toFixed(1)}%` : '—', report.pass_pow_k != null ? bar(report.pass_pow_k) : ''],
            [`Avg Duration`, `${(avgDur / 1000).toFixed(1)}s`, ''],
            [`Total Tokens`, `~${totalTokens}`, ''],
            [`Skills`, report.skills_used?.join(', ') || 'none', ''],
        ];

        for (const [label, value, barStr] of metrics) {
            console.log(`  ${c.gray}${padRight(label, 16)}${c.reset} ${c.bold}${padRight(value, 10)}${c.reset} ${barStr}`);
        }
        console.log('');

        // ── Trials table
        const hdr = `  ${c.dim}${padRight('Trial', 8)}${padRight('Reward', 10)}${padRight('Status', 8)}${padRight('Duration', 12)}${padRight('Commands', 10)}${padRight('Tokens', 12)}Graders${c.reset}`;
        console.log(hdr);
        console.log(`  ${c.gray}${'·'.repeat(90)}${c.reset}`);

        for (const trial of trials) {
            const tp = trial.reward >= 0.5;
            const reward = tp ? `${c.green}${trial.reward.toFixed(2)}${c.reset}` : `${c.red}${trial.reward.toFixed(2)}${c.reset}`;
            const status = badge(tp ? 'PASS' : 'FAIL', tp);
            const dur = `${((trial.duration_ms || 0) / 1000).toFixed(1)}s`;
            const tokens = `~${(trial.input_tokens || 0) + (trial.output_tokens || 0)}`;
            const graders = (trial.grader_results || []).map((g: any) => {
                const gc = g.score >= 0.5 ? c.green : c.red;
                return `${gc}${g.grader_type}:${g.score.toFixed(1)}${c.reset}`;
            }).join(' ');

            console.log(`  ${padRight(`${trial.trial_id}`, 8)}${padRight(reward, 20)}${padRight(status, 18)}${padRight(dur, 12)}${padRight(`${trial.n_commands || 0}`, 10)}${padRight(tokens, 12)}${graders}`);
        }
        console.log('');

        // ── Grader details (show reasoning for each trial)
        for (const trial of trials) {
            const llmGraders = (trial.grader_results || []).filter((g: any) => g.grader_type === 'llm_rubric');
            for (const g of llmGraders) {
                const gc = g.score >= 0.5 ? c.green : c.red;
                console.log(`  ${c.gray}Trial ${trial.trial_id}${c.reset} ${gc}[llm_rubric ${g.score.toFixed(2)}]${c.reset} ${c.dim}${g.details}${c.reset}`);
            }
        }
        if (trials.some((t: any) => t.grader_results?.some((g: any) => g.grader_type === 'llm_rubric'))) {
            console.log('');
        }

        console.log(`  ${c.gray}File: ${file}${c.reset}`);
        console.log('');
    }

    console.log(divider());
    console.log('');
}
