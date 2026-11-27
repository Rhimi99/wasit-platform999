import { z } from 'zod';

/**
 * Self-service update bodies.
 *
 * `.strict()` is the contract: a protected column (`verified`, `isActive`,
 * `slug`, `userId`, `registrationNumber`, `taxId` …) is a 422 with the offending
 * key named, never a silently ignored field. Clearing an optional text field is
 * expressed with `null`, not by omitting it.
 */
const optionalText = (max: number) => z.string().max(max).nullable().optional();

export const merchantUpdateSchema = z
  .object({
    storeName: z.string().min(2).max(200).optional(),
    countryId: optionalText(36),
    cityId: optionalText(36),
    description: optionalText(5000),
    logoUrl: z.string().url().max(2000).nullable().optional(),
  })
  .strict();

export const supplierUpdateSchema = z
  .object({
    companyName: z.string().min(2).max(200).optional(),
    countryId: optionalText(36),
    cityId: optionalText(36),
    description: optionalText(5000),
    logoUrl: z.string().url().max(2000).nullable().optional(),
  })
  .strict();

export const companyUpdateSchema = z
  .object({
    legalName: z.string().min(2).max(250).optional(),
    countryId: optionalText(36),
    cityId: optionalText(36),
    industry: optionalText(150),
    description: optionalText(5000),
    logoUrl: z.string().url().max(2000).nullable().optional(),
  })
  .strict();

export type MerchantUpdateInput = z.infer<typeof merchantUpdateSchema>;
export type SupplierUpdateInput = z.infer<typeof supplierUpdateSchema>;
export type CompanyUpdateInput = z.infer<typeof companyUpdateSchema>;
