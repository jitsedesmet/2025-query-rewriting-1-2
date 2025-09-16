import { describe, it } from 'vitest';
import { construct1, construct2 } from '../lib/index.js';

describe('dummy', () => {
  it('tests', ({ expect }) => {
    expect(construct1).toEqual(construct1);
    expect(construct1).not.toEqual(construct2);
  });
});
