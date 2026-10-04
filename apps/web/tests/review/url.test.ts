import { describe, expect, it } from 'vitest';
import { buildHref, first, parseSource, sourceParam } from '@/lib/review/url';

describe('url ヘルパ', () => {
  it('buildHref は undefined / 空を落とす', () => {
    expect(buildHref('/', { source: 'sbi', review: undefined, preset: '' })).toBe('/?source=sbi');
    expect(buildHref('/stats', {})).toBe('/stats');
  });
  it('first は配列なら先頭', () => {
    expect(first(['a', 'b'])).toBe('a');
    expect(first('a')).toBe('a');
    expect(first(undefined)).toBeUndefined();
  });
  it('source は sbi だけ SBI、それ以外はペーパー', () => {
    expect(parseSource('sbi')).toBe('SBI');
    expect(parseSource('paper')).toBe('PAPER');
    expect(parseSource('x')).toBe('PAPER');
    expect(parseSource(undefined)).toBe('PAPER');
    expect(sourceParam('SBI')).toBe('sbi');
    expect(sourceParam('PAPER')).toBe('paper');
  });
});
