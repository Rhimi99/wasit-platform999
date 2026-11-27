/**
 * The authoritative GLOBAL control row, as the database returns it.
 *
 * DB-free unit harnesses must model the kill switch the runtime now reads on
 * every execution entry point: an absent row is treated as "control
 * unavailable" (fail-closed), which is correct in production but would make a
 * fake handle refuse everything. Seeding this row keeps the fake honest.
 */
export function openGlobalSwitchRow(): Record<string, unknown> {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    scope: 'GLOBAL',
    targetKey: '*',
    stopped: false,
    reason: null,
    actorId: null,
    version: 1,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}
