import { db, closeDb } from '../db/client';
import {
  rolePermissions,
  roles,
  permissions,
} from '../db/schema/auth';
import {
  subscriptionPlans,
} from '../db/schema/subscriptions';
import {
  countries,
  regions,
  cities,
  currencies,
  languages,
} from '../db/schema/geo';
import {
  categories,
} from '../db/schema/products';
import {
  commissionPolicies,
  paymentFeePolicies,
  policies,
} from '../db/schema/engine';
import { aiModels } from '../db/schema/ai';
import { newId } from '../lib/ids';
import { USER_ROLES } from '@wasit/shared';
import { ROLE_PERMISSIONS, PERMISSIONS } from '@wasit/shared';

const P = PERMISSIONS;

async function seedPermissions(): Promise<Map<string, string>> {
  const idMap = new Map<string, string>();
  const existing = await db.select().from(permissions);
  for (const p of existing) idMap.set(p.name, p.id);

  for (const [key, name] of Object.entries(P) as [string, string][]) {
    if (!idMap.has(name)) {
      const id = newId();
      await db.insert(permissions).values({ id, name, description: key });
      idMap.set(name, id);
    }
  }
  return idMap;
}

async function seedRoles(permMap: Map<string, string>): Promise<Map<string, string>> {
  const roleMap = new Map<string, string>();
  const existing = await db.select().from(roles);
  for (const r of existing) roleMap.set(r.name, r.id);

  for (const roleName of USER_ROLES) {
    let roleId = roleMap.get(roleName);
    if (!roleId) {
      roleId = newId();
      await db.insert(roles).values({
        id: roleId,
        name: roleName,
        description: `System role: ${roleName}`,
        system: true,
      });
      roleMap.set(roleName, roleId);
    }

    const permSet = ROLE_PERMISSIONS[roleName];
    const existingLinks = await import('drizzle-orm').then(({ eq }) =>
      db.select().from(rolePermissions).where(eq(rolePermissions.roleId, roleId)),
    );
    const linked = new Set(existingLinks.map((l) => l.permissionId));
    for (const perm of permSet) {
      const permId = permMap.get(perm);
      if (permId && !linked.has(permId)) {
        await db.insert(rolePermissions).values({ id: newId(), roleId, permissionId: permId });
        linked.add(permId);
      }
    }
  }
  return roleMap;
}

async function seedGeo(): Promise<void> {
  const langCount = await import('drizzle-orm').then(({ eq }) =>
    db.select().from(languages).where(eq(languages.code, 'ar')),
  );
  if (langCount.length === 0) {
    await db.insert(languages).values([
      { id: newId(), code: 'ar', name: 'Arabic', nativeName: 'العربية', isRtl: true, isActive: true, isDefault: true, sortOrder: 1 },
      { id: newId(), code: 'fr', name: 'French', nativeName: 'Français', isRtl: false, isActive: true, isDefault: false, sortOrder: 2 },
      { id: newId(), code: 'en', name: 'English', nativeName: 'English', isRtl: false, isActive: true, isDefault: false, sortOrder: 3 },
    ]);
  }

  const curCount = await import('drizzle-orm').then(({ eq }) =>
    db.select().from(currencies).where(eq(currencies.code, 'TND')),
  );
  if (curCount.length === 0) {
    await db.insert(currencies).values([
      { id: newId(), code: 'TND', name: 'Tunisian Dinar', symbol: 'د.ت', decimals: 3, isActive: true },
      { id: newId(), code: 'USD', name: 'US Dollar', symbol: '$', decimals: 2, isActive: true },
      { id: newId(), code: 'EUR', name: 'Euro', symbol: '€', decimals: 2, isActive: true },
      { id: newId(), code: 'CNY', name: 'Chinese Yuan', symbol: '¥', decimals: 2, isActive: true },
      { id: newId(), code: 'TRY', name: 'Turkish Lira', symbol: '₺', decimals: 2, isActive: true },
    ]);
  }

  const tn = await import('drizzle-orm').then(({ eq }) =>
    db.select().from(countries).where(eq(countries.code, 'TN')),
  );
  if (tn.length === 0) {
    const tunisiaId = newId();
    await db.insert(countries).values({
      id: tunisiaId,
      code: 'TN',
      iso3: 'TUN',
      name: 'Tunisia',
      nameAr: 'تونس',
      nameFr: 'Tunisie',
      phonePrefix: '+216',
      currencyCode: 'TND',
      defaultLanguage: 'ar',
      isActive: true,
      activatedAt: new Date(),
      policyConfig: JSON.stringify({
        verificationLevels: ['BASIC', 'VERIFIED', 'BUSINESS_VERIFIED'],
        commission: { enabled: true },
      }),
    });

    // Governorates
    const govs = [
      'Tunis', 'Ariana', 'Ben Arous', 'Manouba', 'Nabeul', 'Zaghouan', 'Bizerte',
      'Béja', 'Jendouba', 'Le Kef', 'Siliana', 'Sousse', 'Monastir', 'Mahdia',
      'Sfax', 'Kairouan', 'Kasserine', 'Sidi Bouzid', 'Gabès', 'Médenine',
      'Gafsa', 'Tozeur', 'Kébili', 'Tataouine',
    ];
    for (const gov of govs) {
      const regionId = newId();
      await db.insert(regions).values({
        id: regionId,
        countryId: tunisiaId,
        name: gov,
        code: gov.toUpperCase().slice(0, 6),
        isActive: true,
      });
      const cityNames: string[] =
        gov === 'Tunis' ? ['Tunis', 'La Marsa', 'Le Bardo', 'Carthage'] :
        gov === 'Sfax' ? ['Sfax', 'Sakiet Ezzit', 'Kerkennah'] :
        gov === 'Nabeul' ? ['Nabeul', 'Hammamet', 'Dar Chaabane'] :
        gov === 'Sousse' ? ['Sousse', 'Hammam Sousse', 'Msaken'] :
        [gov];
      for (const cityName of cityNames) {
        await db.insert(cities).values({ id: newId(), regionId, name: cityName, isActive: true });
      }
    }
  }

  // Second market seeded as a candidate (inactive). Activating it and defining any
  // country-specific rules is a business/legal decision — not made here. Its
  // presence lets the Policy Engine demonstrate country layering + gap tracking.
  const fr = await import('drizzle-orm').then(({ eq }) =>
    db.select().from(countries).where(eq(countries.code, 'FR')),
  );
  if (fr.length === 0) {
    const franceId = newId();
    await db.insert(countries).values({
      id: franceId,
      code: 'FR',
      iso3: 'FRA',
      name: 'France',
      nameAr: 'فرنسا',
      nameFr: 'France',
      phonePrefix: '+33',
      currencyCode: 'EUR',
      defaultLanguage: 'fr',
      isActive: false,
      policyConfig: null,
    });
    await db.insert(regions).values({
      id: newId(),
      countryId: franceId,
      name: 'Île-de-France',
      code: 'IDF',
      isActive: true,
    });
  }
}

async function seedCategories(): Promise<void> {
  const count = await import('drizzle-orm').then(({ count }) => db.select({ c: count() }).from(categories));
  if ((count[0]?.c ?? 0) > 0) return;

  const cats = [
    { name: 'Food & Agriculture', nameAr: 'المواد الغذائية والزراعة', slug: 'food-agriculture' },
    { name: 'Textiles & Clothing', nameAr: 'المنسوجات والملابس', slug: 'textiles-clothing' },
    { name: 'Electronics', nameAr: 'الإلكترونيات', slug: 'electronics' },
    { name: 'Machinery & Equipment', nameAr: 'الآلات والمعدات', slug: 'machinery-equipment' },
    { name: 'Chemicals', nameAr: 'المواد الكيميائية', slug: 'chemicals' },
    { name: 'Construction Materials', nameAr: 'مواد البناء', slug: 'construction-materials' },
    { name: 'Automotive', nameAr: 'السيارات وقطع الغيار', slug: 'automotive' },
    { name: 'Cosmetics & Personal Care', nameAr: 'مستحضرات التجميل', slug: 'cosmetics-personal-care' },
    { name: 'Home & Furniture', nameAr: 'الأثاث والمنزل', slug: 'home-furniture' },
    { name: 'Sports & Leisure', nameAr: 'الرياضة والترفيه', slug: 'sports-leisure' },
  ];
  for (let i = 0; i < cats.length; i++) {
    const c = cats[i];
    await db.insert(categories).values({
      id: newId(),
      name: c.name,
      nameAr: c.nameAr,
      slug: c.slug,
      isActive: true,
      sortOrder: i,
    });
  }
}

async function seedPolicies(): Promise<void> {
  // WASIT base commission: 4% of the transaction value, split 2% seller + 2% buyer.
  // Stored as a policy (never hardcoded in the engine). Existing installations
  // created before the split get the legacy 3% seller-only BASE row migrated in
  // place, so no Admin-customised policy is overwritten.
  const existing = await import('drizzle-orm').then(({ eq }) =>
    db.select().from(commissionPolicies).where(eq(commissionPolicies.policyType, 'BASE')),
  );
  if (existing.length === 0) {
    await db.insert(commissionPolicies).values({
      id: newId(),
      name: 'WASIT Base Commission 4% (2% seller + 2% buyer)',
      policyType: 'BASE',
      rate: '0.04',
      sellerRate: '0.02',
      buyerRate: '0.02',
      conditions: {},
      priority: 1000,
      isActive: true,
    });
  } else {
    for (const p of existing) {
      if (p.rate === '0.03' && p.sellerRate === '0' && p.buyerRate === '0') {
        const { eq } = await import('drizzle-orm');
        await db
          .update(commissionPolicies)
          .set({
            name: 'WASIT Base Commission 4% (2% seller + 2% buyer)',
            rate: '0.04',
            sellerRate: '0.02',
            buyerRate: '0.02',
            updatedAt: new Date(),
          })
          .where(eq(commissionPolicies.id, p.id));
      }
    }
  }

  // Payment fee policy (separate from WASIT commission). Default dev provider fee: 2% of
  // items total. Managed from the DB/Admin — never hardcoded in source.
  const feeExisting = await import('drizzle-orm').then(({ eq }) =>
    db.select().from(paymentFeePolicies).limit(1),
  );
  if (feeExisting.length === 0) {
    await db.insert(paymentFeePolicies).values({
      id: newId(),
      name: 'WASIT Default Processing Fee',
      provider: 'default',
      percentRate: '0.02',
      flatFee: '0',
      currencyCode: 'TND',
      conditions: {},
      isActive: true,
    });
  }

  const policyCode = await import('drizzle-orm').then(({ eq }) =>
    db.select().from(policies).where(eq(policies.code, 'ANTI_FEE_EVASION')),
  );
  if (policyCode.length === 0) {
    await db.insert(policies).values({
      id: newId(),
      scope: 'TRADE',
      code: 'ANTI_FEE_EVASION',
      name: 'Anti Fee Evasion Policy',
      description: 'Prohibits attempts to move transactions outside WASIT',
      rules: {
        offPlatformContact: 'prohibited',
        penalty: 'account_suspension',
      },
      isActive: true,
      version: 1,
    });
  }

  // --- Verification policies (admin-manageable, per country optional) ---
  const verPolicyCount = await import('drizzle-orm').then(({ eq }) =>
    db.select().from(policies).where(eq(policies.code, 'VERIFICATION_BASIC')),
  );
  if (verPolicyCount.length === 0) {
    await db.insert(policies).values([
      {
        id: newId(),
        scope: 'VERIFICATION',
        code: 'VERIFICATION_BASIC',
        name: 'Basic Verification',
        description: 'Requirements for BASIC verification level',
        rules: {
          level: 'BASIC',
          requirements: { emailVerified: true, phoneVerified: true },
          resubmissionWaitDays: 7,
        },
        isActive: true,
        version: 1,
      },
      {
        id: newId(),
        scope: 'VERIFICATION',
        code: 'VERIFICATION_VERIFIED',
        name: 'Verified Account',
        description: 'Requirements for VERIFIED level',
        rules: {
          level: 'VERIFIED',
          requirements: { emailVerified: true, phoneVerified: true, idDocument: true, selfie: true },
          resubmissionWaitDays: 7,
        },
        isActive: true,
        version: 1,
      },
      {
        id: newId(),
        scope: 'VERIFICATION',
        code: 'VERIFICATION_BUSINESS',
        name: 'Business Verified',
        description: 'Requirements for BUSINESS_VERIFIED level',
        rules: {
          level: 'BUSINESS_VERIFIED',
          requirements: {
            emailVerified: true,
            phoneVerified: true,
            idDocument: true,
            businessRegistration: true,
            taxId: true,
            bankAccount: true,
          },
          resubmissionWaitDays: 14,
        },
        isActive: true,
        version: 1,
      },
      {
        id: newId(),
        scope: 'VERIFICATION',
        code: 'VERIFICATION_INTERNATIONAL',
        name: 'International Verified',
        description: 'Requirements for INTERNATIONAL_VERIFIED level',
        rules: {
          level: 'INTERNATIONAL_VERIFIED',
          requirements: {
            emailVerified: true,
            phoneVerified: true,
            idDocument: true,
            businessRegistration: true,
            taxId: true,
            bankAccount: true,
            passport: true,
            compliance: true,
          },
          resubmissionWaitDays: 30,
        },
        isActive: true,
        version: 1,
      },
    ]);
  }

  // --- Dispute resolution policy (per-country adaptable) ---
  const disputePolicyCount = await import('drizzle-orm').then(({ eq }) =>
    db.select().from(policies).where(eq(policies.code, 'DISPUTE_RESOLUTION')),
  );
  if (disputePolicyCount.length === 0) {
    await db.insert(policies).values([
      {
        id: newId(),
        scope: 'DISPUTE',
        code: 'DISPUTE_RESOLUTION',
        name: 'Dispute Resolution Policy',
        description: 'Default dispute resolution rules (per-country override supported)',
        rules: {
          openWindowDays: 30,
          evidenceDeadlineDays: 14,
          decisionDeadlineDays: 30,
          appealWindowDays: 7,
          maxAppeals: 1,
          autoEscalateDays: 7,
        },
        isActive: true,
        version: 1,
      },
    ]);
  }

  // --- Data retention policy (Privacy). Governs the deletion retention window
  // and the country-specific records that must be preserved. Per-country
  // overrides are supported and recorded as gaps when absent. ---
  const retentionPolicyCount = await import('drizzle-orm').then(({ eq }) =>
    db.select().from(policies).where(eq(policies.code, 'DATA_RETENTION')),
  );
  if (retentionPolicyCount.length === 0) {
    await db.insert(policies).values([
      {
        id: newId(),
        scope: 'PRIVACY',
        code: 'DATA_RETENTION',
        name: 'Data Retention Policy',
        description: 'Default data-retention rules for deletion requests (per-country override supported)',
        rules: {
          defaultRetentionDays: 90,
          legalHoldFinanciallyRequired: true,
          // Extra record classes beyond the always-preserved financial/audit set.
          preserves: [],
        },
        isActive: true,
        version: 1,
      },
    ]);
  }
}

async function seedSubscriptionPlans(): Promise<void> {
  const existing = await import('drizzle-orm').then(({ eq }) =>
    db.select().from(subscriptionPlans).where(eq(subscriptionPlans.code, 'CUSTOMER_FREE')),
  );
  if (existing.length === 0) {
    await db.insert(subscriptionPlans).values([
      {
        id: newId(), code: 'CUSTOMER_FREE', name: 'Customer Free', nameAr: 'عميل مجاني', nameFr: 'Client Gratuit',
        planTarget: 'CUSTOMER', priceMonthly: '0', priceYearly: '0', currencyCode: 'TND',
        features: { products: 0, aiCosts: 0, support: 'basic' }, limits: { aiPerDay: 5 }, isActive: true, isDefault: true, sortOrder: 1,
      },
      {
        id: newId(), code: 'SMALL_MERCHANT', name: 'Small Merchant', nameAr: 'تاجر صغير', nameFr: 'Petit Marchand',
        planTarget: 'MERCHANT', priceMonthly: '19', priceYearly: '190', currencyCode: 'TND',
        features: { products: 50, aiCosts: 50 }, limits: { aiPerDay: 50 }, isActive: true, sortOrder: 2,
      },
      {
        id: newId(), code: 'COMPANY', name: 'Company', nameAr: 'شركة', nameFr: 'Entreprise',
        planTarget: 'COMPANY', priceMonthly: '99', priceYearly: '990', currencyCode: 'TND',
        features: { products: 1000, aiCosts: 200, employees: 10 }, limits: { aiPerDay: 200 }, isActive: true, sortOrder: 3,
      },
      {
        id: newId(), code: 'PRO_MAX', name: 'Pro Max', nameAr: 'احترافي ماكس', nameFr: 'Pro Max',
        planTarget: 'GLOBAL', priceMonthly: '299', priceYearly: '2990', currencyCode: 'TND',
        features: { products: 10000, aiCosts: 1000, employees: 50, advertising: true }, limits: { aiPerDay: 1000 }, isActive: true, sortOrder: 4,
      },
    ]);
  }
}

async function seedAIModels(): Promise<void> {
  const existing = await import('drizzle-orm').then(({ eq }) =>
    db.select().from(aiModels).where(eq(aiModels.key, 'local-heuristic')),
  );
  if (existing.length > 0) return;
  await db.insert(aiModels).values([
    {
      id: newId(), key: 'local-heuristic', displayName: 'Local Heuristic (WASIT Analytics)',
      provider: 'local', contextWindow: 0, maxOutputTokens: 0,
      inputPer1k: '0', outputPer1k: '0', currencyCode: 'USD', isActive: true,
    },
    {
      id: newId(), key: 'openai-gpt-4o-mini', displayName: 'GPT-4o mini',
      provider: 'openai', contextWindow: 128000, maxOutputTokens: 16384,
      inputPer1k: '0.00015', outputPer1k: '0.0006', currencyCode: 'USD', isActive: true,
    },
    {
      id: newId(), key: 'anthropic-claude-sonnet-4', displayName: 'Claude Sonnet 4',
      provider: 'anthropic', contextWindow: 200000, maxOutputTokens: 64000,
      inputPer1k: '0.003', outputPer1k: '0.015', currencyCode: 'USD', isActive: true,
    },
  ]);
}

async function main(): Promise<void> {
  console.log('Seeding database...');
  const permMap = await seedPermissions();
  await seedRoles(permMap);
  await seedGeo();
  await seedCategories();
  await seedPolicies();
  await seedSubscriptionPlans();
  await seedAIModels();
  console.log('Seed complete.');
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());