import { eq } from 'drizzle-orm';
import type { DB } from '../db/client';
import { users } from '../db/schema/auth';
import { profiles, supplierContacts, suppliers } from '../db/schema/trade';
import { hashToken } from './security';

/**
 * Result of scrubbing one account. `fields` names every column replaced, so the
 * audit log proves what was removed without storing the removed values.
 */
export interface AnonymizationResult {
  userId: string;
  fields: string[];
}

/** Stable, non-reversible placeholder derived from the user id (never the old value). */
function placeholder(userId: string, label: string): string {
  const digest = hashToken(`${userId}:${label}`).slice(0, 16);
  return `anon-${digest}`;
}

/**
 * Executes the ANONYMIZED stage for real: replaces personal data with
 * non-reversible placeholders while preserving the identifiers that financial
 * and audit records reference (user id, order/ledger foreign keys).
 *
 * Deliberately preserved:
 *   - the users row itself (transactions/ledger/disputes reference it),
 *   - password hash is replaced with an unusable sentinel so the account can
 *     never be logged into, rather than deleted,
 *   - all audit and financial records.
 *
 * The caller must have already checked the retention window (legal hold).
 */
export async function anonymizeUser(db: DB, userId: string): Promise<AnonymizationResult> {
  const fields: string[] = [];
  const tag = placeholder(userId, 'user');

  // Neutralise credentials and contact data on the account row. The email must
  // stay unique, so it becomes a reserved example.invalid address keyed by id.
  await db
    .update(users)
    .set({
      email: `${tag}@anonymized.invalid`,
      phone: null,
      passwordHash: 'ANONYMIZED',
      firstName: null,
      lastName: null,
      emailVerified: false,
      phoneVerified: false,
      isActive: false,
      isLocked: true,
      mfaEnabled: false,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));
  fields.push('users.email', 'users.phone', 'users.password_hash', 'users.first_name', 'users.last_name');

  // Profile: free-text identity fields only; country/city are non-identifying.
  await db
    .update(profiles)
    .set({
      displayName: `Anonymized ${tag}`,
      avatarUrl: null,
      bio: null,
      updatedAt: new Date(),
    })
    .where(eq(profiles.userId, userId));
  fields.push('profiles.display_name', 'profiles.avatar_url', 'profiles.bio');

  // Contact persons are keyed by supplier, which is keyed by user. Scrub any
  // contact rows belonging to this user's supplier(s).
  const supplierRow = await db
    .select({ id: suppliers.id })
    .from(suppliers)
    .where(eq(suppliers.userId, userId))
    .limit(1);
  if (supplierRow.length > 0) {
    const contacts = await db
      .update(supplierContacts)
      .set({ fullName: `Anonymized ${tag}`, email: null, phone: null, position: null })
      .where(eq(supplierContacts.supplierId, supplierRow[0].id))
      .returning({ id: supplierContacts.id });
    if (contacts.length > 0) {
      fields.push('supplier_contacts.full_name', 'supplier_contacts.email', 'supplier_contacts.phone');
    }
  }

  return { userId, fields };
}