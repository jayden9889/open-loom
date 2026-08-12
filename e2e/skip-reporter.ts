/**
 * A reporter that refuses to let a vacuous run look like a passing one.
 *
 * Most of this suite gates itself: specs skip when the app has not been built,
 * and the flows that drive a real capture skip when macOS has not granted
 * Screen Recording to the binary under test. Those gates are correct, but
 * Playwright reports a run where every single test skipped as green, and a
 * green run that asserted nothing is worse than a red one because it gets
 * trusted. So this reporter prints exactly which flows were skipped and why,
 * and fails the run when nothing actually ran.
 */
import type { Reporter, TestCase, TestResult, FullResult } from '@playwright/test/reporter';

type SkipRecord = { title: string; reason: string };

/** Playwright puts the annotation reason on the test, not the result. */
function skipReason(test: TestCase): string {
  const note = test.annotations.find((a) => a.type === 'skip' || a.type === 'fixme');
  return note?.description?.trim() || 'no reason given';
}

class SkipReporter implements Reporter {
  private skipped: SkipRecord[] = [];
  private ran = 0;

  onTestEnd(test: TestCase, result: TestResult) {
    if (result.status === 'skipped') {
      this.skipped.push({ title: test.titlePath().slice(1).join(' > '), reason: skipReason(test) });
    } else {
      this.ran += 1;
    }
  }

  onEnd(result: FullResult) {
    // `--list` enumerates without running anything, so an empty run is expected
    // there and must not be reported as a failure.
    if (process.argv.includes('--list')) return;

    if (this.skipped.length) {
      const width = Math.max(...this.skipped.map((s) => s.title.length));
      console.log(`\n  ${this.skipped.length} flow(s) skipped, so nothing below was verified:`);
      for (const s of this.skipped) {
        console.log(`    ${s.title.padEnd(width)}  ${s.reason}`);
      }
    }

    if (this.ran === 0) {
      console.log(
        '\n  Every test skipped, so this run proves nothing. Treating it as a failure.\n' +
          '  Build the app first with `npm run build`. On macOS, also grant Screen\n' +
          '  Recording to the Electron binary in System Settings > Privacy & Security\n' +
          '  so the capture flows can run.\n'
      );
      result.status = 'failed';
      return;
    }

    console.log(`\n  ${this.ran} test(s) actually ran.\n`);
  }
}

export default SkipReporter;
