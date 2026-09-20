import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

export const verificationLevelEnum = pgEnum('verification_level', [
  'NONE',
  'BASIC',
  'VERIFIED',
  'BUSINESS_VERIFIED',
  'INTERNATIONAL_VERIFIED',
]);

export const verificationStatusEnum = pgEnum('verification_status', [
  'PENDING',
  'SUBMITTED',
  'IN_REVIEW',
  'APPROVED',
  'REJECTED',
  'EXPIRED',
  'REVOKED',
]);

export const verificationRequests = pgTable(
  'verification_requests',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    userId: varchar('user_id', { length: 36 }).notNull(),
    targetLevel: verificationLevelEnum('target_level').notNull(),
    status: verificationStatusEnum('status').notNull().default('PENDING'),
    documentType: varchar('document_type', { length: 100 }),
    documentRef: varchar('document_ref', { length: 200 }),
    isBusiness: boolean('is_business').notNull().default(false),
    businessId: varchar('business_id', { length: 36 }),
    reviewedById: varchar('reviewed_by_id', { length: 36 }),
    reviewNotes: text('review_notes'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('verification_user_idx').on(t.userId),
    statusIdx: index('verification_status_idx').on(t.status),
  }),
);

export const verificationDocuments = pgTable(
  'verification_documents',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    requestId: varchar('request_id', { length: 36 }).notNull(),
    type: varchar('type', { length: 100 }).notNull(),
    fileRef: text('file_ref').notNull(),
    ocrData: jsonb('ocr_data'),
    aiReview: jsonb('ai_review'),
    uploadedById: varchar('uploaded_by_id', { length: 36 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    requestIdx: index('verification_docs_request_idx').on(t.requestId),
  }),
);

export const trustScores = pgTable(
  'trust_scores',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    userId: varchar('user_id', { length: 36 }).notNull(),
    score: integer('score').notNull().default(50),
    // Level derived from score: LOW <40, BASIC 40-59, GOOD 60-79, EXCELLENT >=80
    level: varchar('level', { length: 30 }).notNull().default('BASIC'),
    factors: jsonb('factors'),
    summary: varchar('summary', { length: 500 }),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('trust_scores_user_idx').on(t.userId),
    effectiveIdx: index('trust_scores_effective_idx').on(t.effectiveAt),
  }),
);

// Rating & reviews
export const reviews = pgTable(
  'reviews',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    reviewerId: varchar('reviewer_id', { length: 36 }).notNull(),
    subjectId: varchar('subject_id', { length: 36 }).notNull(),
    subjectType: varchar('subject_type', { length: 40 }).notNull(),
    transactionId: varchar('transaction_id', { length: 36 }),
    rating: integer('rating').notNull(),
    comment: text('comment'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    subjectIdx: index('reviews_subject_idx').on(t.subjectType, t.subjectId),
    reviewerIdx: index('reviews_reviewer_idx').on(t.reviewerId),
  }),
);