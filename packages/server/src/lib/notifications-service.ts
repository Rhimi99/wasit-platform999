import type { DB } from '../db/client';
import { notifications } from '../db/schema/messaging';
import { newId } from './ids';

export async function createNotification(
  db: DB,
  input: {
    userId: string;
    type: string;
    title: string;
    body?: string;
    data?: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(notifications).values({
    id: newId(),
    userId: input.userId,
    type: input.type,
    title: input.title,
    body: input.body ?? null,
    data: input.data ?? null,
  });
}