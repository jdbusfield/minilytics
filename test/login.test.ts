import { describe, expect, it } from 'vitest';
import { passwordsMatch } from '../src/worker/lib/crypto';

describe('passwordsMatch', () => {
  it('accepts the exact password', () => {
    expect(passwordsMatch('correct horse', 'correct horse')).toBe(true);
  });
  it('ignores a stray line break or space around the stored secret', () => {
    expect(passwordsMatch('correct horse', 'correct horse\n')).toBe(true);
    expect(passwordsMatch('correct horse', ' correct horse \r\n')).toBe(true);
  });
  it('ignores a stray space around what was typed', () => {
    expect(passwordsMatch('correct horse ', 'correct horse')).toBe(true);
  });
  it('still rejects a wrong password, a different case, or changed inner spacing', () => {
    expect(passwordsMatch('correct horses', 'correct horse')).toBe(false);
    expect(passwordsMatch('Correct horse', 'correct horse')).toBe(false);
    expect(passwordsMatch('correcthorse', 'correct horse')).toBe(false);
    expect(passwordsMatch('', 'correct horse')).toBe(false);
  });
});
