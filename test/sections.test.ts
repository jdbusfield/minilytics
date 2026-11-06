import { describe, expect, it } from 'vitest';
import { sectionMatch, sectionsFor } from '../src/shared/sections';

describe('sections', () => {
  it('only sites with sections get the switch', () => {
    expect(sectionsFor('fanranked.com').map((s) => s.name)).toEqual(['Baseball', 'Football']);
    expect(sectionsFor('www.FanRanked.com')).toHaveLength(2);
    expect(sectionsFor('hdrsiteservices.com')).toEqual([]);
  });

  it('a named section takes its own patterns', () => {
    const m = sectionMatch('fanranked.com', 'Football')!;
    expect(m.exclude).toBe(false);
    expect(m.patterns).toContain('/football/*');
  });

  it('the catch-all is everything the other sections claim, left out', () => {
    const m = sectionMatch('fanranked.com', 'Baseball')!;
    expect(m.exclude).toBe(true);
    expect(m.patterns).toEqual(expect.arrayContaining(['/football', '/football/*']));
  });

  it("every pattern fits D1's 50-byte GLOB limit", () => {
    const patterns = sectionsFor('fanranked.com').flatMap((s) => s.patterns ?? []);
    expect(patterns.filter((p) => p.length > 50)).toEqual([]);
  });

  it('an unknown section is ignored', () => {
    expect(sectionMatch('fanranked.com', 'Hockey')).toBeNull();
    expect(sectionMatch('hdrsiteservices.com', 'Football')).toBeNull();
  });
});
