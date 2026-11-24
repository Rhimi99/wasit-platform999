import type { EntityType } from './types.js';

/**
 * The only columns a party may change about itself.
 *
 * Everything else on the row is either operational (`isActive`), derived
 * (`slug`), an ownership key (`userId`), a review outcome (`verified`) or a
 * legal identifier whose change has to go through verification again
 * (`registrationNumber`, `taxId`). Those are refused rather than silently
 * dropped, so a client never believes it wrote something it did not.
 */
export const EDITABLE_FIELDS: Record<EntityType, readonly string[]> = {
  merchant: ['storeName', 'countryId', 'cityId', 'description', 'logoUrl'],
  supplier: ['companyName', 'countryId', 'cityId', 'description', 'logoUrl'],
  company: ['legalName', 'countryId', 'cityId', 'industry', 'description', 'logoUrl'],
};

/** Rejected on every self-service write, even if a route forgets to validate. */
export const PROTECTED_ENTITY_FIELDS = [
  'id',
  'userId',
  'slug',
  'verified',
  'isActive',
  'createdAt',
  'updatedAt',
  'registrationNumber',
  'taxId',
] as const;

export function isEditableField(type: EntityType, field: string): boolean {
  return EDITABLE_FIELDS[type].includes(field);
}
