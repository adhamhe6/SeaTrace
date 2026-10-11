import { describe, expect, it } from 'vitest';
import { ApiError } from '@/api/client';
import { describeCommandFailure } from './errors';
import { validateDuration } from './ScenarioCard';

const err = (status: number, code: string, message = 'm') =>
  new ApiError({ status, code, message });

describe('describeCommandFailure', () => {
  it('maps the documented backend codes', () => {
    expect(describeCommandFailure(err(503, 'simulator_unavailable')).title).toBe(
      'Simulator unavailable',
    );
    expect(describeCommandFailure(err(409, 'scenario_rejected', 'already active')).message).toBe(
      'already active',
    );
    expect(describeCommandFailure(err(422, 'invalid_duration', 'too long')).message).toBe(
      'too long',
    );
    expect(describeCommandFailure(err(422, 'vessel_required')).title).toBe('Vessel required');
    expect(describeCommandFailure(err(502, 'simulator_error')).title).toMatch(/protocol/);
    expect(describeCommandFailure(err(403, 'forbidden')).title).toBe('Operator role required');
    expect(describeCommandFailure(err(404, 'not_found', 'nope')).message).toBe('nope');
    expect(
      describeCommandFailure(new ApiError({ status: 0, code: 'network_error', message: 'offline' }))
        .title,
    ).toBe('Server unreachable');
    expect(describeCommandFailure(err(500, 'internal_error')).title).toBe('Command failed');
    expect(describeCommandFailure(new Error('x')).message).toBe('x');
  });
});

describe('validateDuration', () => {
  it('accepts empty, zero and in-range integers', () => {
    expect(validateDuration('', 100)).toEqual({ value: undefined, error: null });
    expect(validateDuration('0', 100)).toEqual({ value: 0, error: null });
    expect(validateDuration('60', 100)).toEqual({ value: 60, error: null });
  });
  it('rejects negatives, fractions and values above the maximum', () => {
    expect(validateDuration('-1', 100).error).toMatch(/whole number/);
    expect(validateDuration('1.5', 100).error).toMatch(/whole number/);
    expect(validateDuration('abc', 100).error).toMatch(/whole number/);
    expect(validateDuration('101', 100).error).toMatch(/At most 100 s/);
  });
});
