// How long a template match takes, which only Node can time: inside workerd the clock stands
// still while synchronous code runs. A principal chooses the template, and every write tests it.
import { describe, expect, it } from 'vitest';
import { templateMatcher } from '../../src/server-role/uri-templates';

describe("a template's match", () => {
  it('takes time in proportion to the URI, however many expressions sit side by side', () => {
    // A backtracking regular expression took 1.5 seconds for this, and five times that with one
    // more expression.
    const matcher = templateMatcher('https://a.example/notes/{+a}{+b}{+c}{+d}!')!;
    const uri = `https://a.example/notes/${'x'.repeat(400)}`;
    const started = performance.now();
    expect(matcher(uri)).toBe(false);
    expect(performance.now() - started).toBeLessThan(100);
    expect(matcher(`https://a.example/notes/${'x'.repeat(400)}!/part`)).toBe(true);
  });

  it("takes RFC 6570's dotted variable names, as in {type.name}", () => {
    expect(templateMatcher('https://a.example/{type.name}/archive')?.('https://a.example/notes/archive/note-1')).toBe(true);
  });
});
