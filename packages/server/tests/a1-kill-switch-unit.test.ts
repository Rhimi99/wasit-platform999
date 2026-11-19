import { describe, it, expect, afterEach } from 'vitest';
import { ApiError } from '@wasit/shared';
import { env } from '../src/lib/env.js';
import {
  isAiExecutionEnabled,
  isAiExecutionDisabled,
  isAiExecutionBlocked,
  assertAiExecutionEnabled,
  setAiExecutionEnabled,
  getAiExecutionSwitchState,
  AI_EXECUTION_DISABLED_MESSAGE,
} from '../src/lib/ai/kill-switch.js';

/**
 * A1 — Central AI Kill Switch: the gate itself.
 *
 * Pure, no database. Proves the single control point is fail-closed and
 * LLM-independent: an explicit disable stops everything, clearing it restores
 * the environment default, and a broken check refuses rather than allows.
 */

afterEach(() => {
  // Never leak switch state into another spec in this file.
  setAiExecutionEnabled(null);
});

describe('A1 — AI kill switch gate', () => {
  it('defaults to enabled from the environment (unchanged behaviour)', () => {
    setAiExecutionEnabled(null);
    expect(isAiExecutionEnabled()).toBe(true);
    expect(isAiExecutionDisabled()).toBe(false);
    expect(isAiExecutionBlocked()).toBe(false);
    expect(getAiExecutionSwitchState()).toEqual({ enabled: true, source: 'env' });
  });

  it('does not throw from the guard while enabled', () => {
    setAiExecutionEnabled(true);
    expect(() => assertAiExecutionEnabled()).not.toThrow();
  });

  it('an explicit disable stops execution and the guard refuses with 503', () => {
    setAiExecutionEnabled(false);
    expect(isAiExecutionEnabled()).toBe(false);
    expect(isAiExecutionDisabled()).toBe(true);
    expect(isAiExecutionBlocked()).toBe(true);
    expect(getAiExecutionSwitchState()).toEqual({ enabled: false, source: 'runtime' });

    let caught: unknown;
    try {
      assertAiExecutionEnabled();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).statusCode).toBe(503);
    expect((caught as ApiError).code).toBe('SERVICE_UNAVAILABLE');
    expect((caught as ApiError).message).toBe(AI_EXECUTION_DISABLED_MESSAGE);
  });

  it('re-enabling restores execution', () => {
    setAiExecutionEnabled(false);
    expect(isAiExecutionDisabled()).toBe(true);
    setAiExecutionEnabled(true);
    expect(isAiExecutionEnabled()).toBe(true);
    expect(() => assertAiExecutionEnabled()).not.toThrow();
  });

  it('clearing the override falls back to the environment default', () => {
    setAiExecutionEnabled(false);
    setAiExecutionEnabled(null);
    expect(getAiExecutionSwitchState().source).toBe('env');
    expect(isAiExecutionEnabled()).toBe(env.AI_AGENT_EXECUTION_ENABLED);
  });

  it('fails closed: a broken flag resolution refuses execution (no bypass)', () => {
    // Simulate a resolution failure. The switch must NOT default to "allowed".
    setAiExecutionEnabled(null);
    const original = Object.getOwnPropertyDescriptor(env, 'AI_AGENT_EXECUTION_ENABLED');
    Object.defineProperty(env, 'AI_AGENT_EXECUTION_ENABLED', {
      configurable: true,
      get() {
        throw new Error('flag resolution failed');
      },
    });
    try {
      expect(isAiExecutionEnabled()).toBe(false);
      expect(isAiExecutionBlocked()).toBe(true);
      expect(() => assertAiExecutionEnabled()).toThrow(/disabled by the central kill switch/);
    } finally {
      if (original) Object.defineProperty(env, 'AI_AGENT_EXECUTION_ENABLED', original);
    }
  });
});
