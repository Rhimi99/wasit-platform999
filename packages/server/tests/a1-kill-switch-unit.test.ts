import { describe, it, expect } from 'vitest';
import { ApiError } from '@wasit/shared';
import {
  describeSwitchState,
  assertExecutionAllowed,
  isExecutionBlocked,
  readExecutionSwitchState,
  type SwitchRowView,
} from '../src/lib/ai/execution-switch.js';
import {
  AI_AGENT_PAUSED_MESSAGE,
  AI_CONTROL_UNAVAILABLE_MESSAGE,
} from '../src/lib/ai/execution-switch.js';
import { AI_EXECUTION_DISABLED_MESSAGE } from '../src/lib/ai/kill-switch.js';

/**
 * A1 / FLEET-01 — the kill switch decision itself, without a database.
 *
 * The projection is pure: it must fail closed when the authoritative GLOBAL row
 * is missing, let the environment flag stop work but never re-open it, and
 * expose the agents that are stopped individually. Database failures are proven
 * closed in `ai-killswitch-fleet-01.test.ts` (a real unreachable pool).
 */

const GLOBAL_OPEN: SwitchRowView = {
  scope: 'GLOBAL',
  targetKey: '*',
  stopped: false,
  reason: null,
  actorId: null,
  version: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const agentRow = (key: string, stopped: boolean): SwitchRowView => ({
  scope: 'AGENT',
  targetKey: key,
  stopped,
  reason: stopped ? 'paused' : null,
  actorId: 'u-1',
  version: 2,
  updatedAt: '2026-01-01T00:00:00.000Z',
});

describe('FLEET-01 — switch state projection', () => {
  it('is open when the GLOBAL row is open and the env belt is not applied', () => {
    const state = describeSwitchState([GLOBAL_OPEN], false);
    expect(state).toMatchObject({
      enabled: true,
      source: 'database',
      failClosed: false,
      globalStopped: false,
      envStopped: false,
    });
  });

  it('reports the env belt as the source when it stops work', () => {
    expect(describeSwitchState([GLOBAL_OPEN], true)).toMatchObject({
      enabled: false,
      source: 'env',
      envStopped: true,
      failClosed: false,
    });
  });

  it('reports a stopped GLOBAL row as stopped', () => {
    const state = describeSwitchState([{ ...GLOBAL_OPEN, stopped: true, version: 4 }], false);
    expect(state).toMatchObject({ enabled: false, source: 'database', globalStopped: true });
    expect(state.global?.version).toBe(4);
  });

  it('fails closed when the authoritative GLOBAL row is missing', () => {
    const state = describeSwitchState([agentRow('sales-agent', true)], false);
    expect(state).toMatchObject({
      enabled: false,
      source: 'unavailable',
      failClosed: true,
      global: null,
    });
    expect(state.stoppedAgents).toEqual(['sales-agent']);
  });

  it('lists stopped agents only', () => {
    const state = describeSwitchState(
      [GLOBAL_OPEN, agentRow('sales-agent', true), agentRow('product-agent', false)],
      false,
    );
    expect(state.stoppedAgents).toEqual(['sales-agent']);
  });
});

describe('FLEET-01 — an unreadable control store fails closed', () => {
  const broken = {
    select() {
      throw new Error('connection refused');
    },
  } as never;

  it('refuses execution instead of assuming it is allowed', async () => {
    await expect(assertExecutionAllowed(broken)).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      message: AI_CONTROL_UNAVAILABLE_MESSAGE,
    });
  });

  it('reports blocked (not enabled) from the predicate', async () => {
    expect(await isExecutionBlocked(broken)).toBe(true);
  });

  it('reports an unavailable state for read surfaces, never "open"', async () => {
    const state = await readExecutionSwitchState(broken);
    expect(state).toMatchObject({ enabled: false, source: 'unavailable', failClosed: true });
  });

  it('keeps the public refusal messages distinct and secret-free', () => {
    expect(AI_EXECUTION_DISABLED_MESSAGE).not.toBe(AI_AGENT_PAUSED_MESSAGE);
    expect(AI_AGENT_PAUSED_MESSAGE).not.toBe(AI_CONTROL_UNAVAILABLE_MESSAGE);
    for (const message of [
      AI_EXECUTION_DISABLED_MESSAGE,
      AI_AGENT_PAUSED_MESSAGE,
      AI_CONTROL_UNAVAILABLE_MESSAGE,
    ]) {
      expect(message).not.toMatch(/postgres|password|secret|token|key=/i);
    }
    expect(new ApiError(503, 'SERVICE_UNAVAILABLE', AI_CONTROL_UNAVAILABLE_MESSAGE).statusCode).toBe(503);
  });
});
