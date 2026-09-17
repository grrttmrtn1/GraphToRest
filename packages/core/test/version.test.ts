import { describe, it, expect } from 'vitest';
import { CORE_VERSION } from '../src/version';

describe('CORE_VERSION', () => {
  it('is defined', () => {
    expect(CORE_VERSION).toBe('0.1.0');
  });
});
