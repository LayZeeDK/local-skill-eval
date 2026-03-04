import { runCliPreview } from './reporters/cli';
import { runBrowserPreview } from './reporters/browser';

async function main() {
    const args = process.argv.slice(2);
    const mode = args[0] || 'cli';
    const logDirArg = args.find(arg => arg.startsWith('--logDir='));
    const logDir = logDirArg ? logDirArg.split('=')[1] : './results';

    if (mode === 'browser') {
        await runBrowserPreview(logDir);
    } else {
        await runCliPreview(logDir);
    }
}

main();
