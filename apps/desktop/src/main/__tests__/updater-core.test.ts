/**
 * Updater message tests: every failure mode must land as a sentence that says
 * what happened and what to do, never silence.
 */
import { describe, expect, it } from 'vitest';
import { describeUpdateError } from '../updater-core';

describe('describeUpdateError', () => {
  it('a missing update feed is a packaging gap, pointed at the releases page', () => {
    const r = describeUpdateError('Cannot find latest-mac.yml in the latest release artifacts');
    expect(r.state).toBe('unavailable');
    expect(r.detail).toContain('releases page');
  });

  it('an unsigned macOS build says the app cannot update itself and where to download', () => {
    const r = describeUpdateError('Error: could not get code signature for running application');
    expect(r.state).toBe('failed');
    expect(r.detail).toContain('not code-signed');
    expect(r.detail).toContain('GitHub');
  });

  it('being offline reads as a connection problem, not a fault', () => {
    const r = describeUpdateError('Error: getaddrinfo ENOTFOUND github.com');
    expect(r.state).toBe('failed');
    expect(r.detail).toContain('connection');
  });

  it('anything else keeps the first line of the real error', () => {
    const r = describeUpdateError('HttpError: 403 rate limited');
    expect(r.state).toBe('failed');
    expect(r.detail).toContain('403 rate limited');
  });
});
