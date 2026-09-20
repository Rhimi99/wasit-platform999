CREATE TYPE "public"."user_role" AS ENUM('CUSTOMER', 'MERCHANT', 'SUPPLIER', 'COMPANY', 'MARKETER', 'SUPPORT', 'RISK', 'DISPUTE', 'ADMIN', 'SUPER_ADMIN');--> statement-breakpoint
CREATE TYPE "public"."purchase_intent" AS ENUM('B2B', 'B2C');--> statement-breakpoint
CREATE TYPE "public"."product_status" AS ENUM('DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED', 'SUSPENDED');--> statement-breakpoint
CREATE TYPE "public"."seller_type" AS ENUM('MERCHANT', 'SUPPLIER', 'COMPANY');--> statement-breakpoint
CREATE TYPE "public"."buyer_type" AS ENUM('CUSTOMER', 'MERCHANT', 'COMPANY');--> statement-breakpoint
CREATE TYPE "public"."ledger_direction" AS ENUM('DEBIT', 'CREDIT');--> statement-breakpoint
CREATE TYPE "public"."ledger_entry_type" AS ENUM('TRANSACTION_VALUE', 'COMMISSION', 'PAYMENT_FEE', 'REFUND', 'SETTLEMENT');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('DRAFT', 'PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'DISPUTED');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('UNPAID', 'PENDING', 'PROCESSING', 'PAID', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED');--> statement-breakpoint
CREATE TYPE "public"."refund_status" AS ENUM('NONE', 'REQUESTED', 'APPROVED', 'REJECTED', 'PROCESSING', 'COMPLETED');--> statement-breakpoint
CREATE TYPE "public"."settlement_status" AS ENUM('PENDING', 'PROCESSING', 'SETTLED', 'HELD', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."inventory_movement_type" AS ENUM('PURCHASE', 'SALE', 'ADJUSTMENT', 'RETURN', 'RESERVATION', 'RELEASE');--> statement-breakpoint
CREATE TYPE "public"."commission_policy_type" AS ENUM('BASE', 'ACCOUNT_TYPE', 'B2B_B2C', 'TRANSACTION_VALUE', 'VOLUME', 'COUNTRY', 'CURRENCY', 'SECTOR', 'PRODUCT', 'SUBSCRIPTION', 'VERIFICATION', 'ACTIVITY');--> statement-breakpoint
CREATE TYPE "public"."policy_scope" AS ENUM('COMMISSION', 'LIMITS', 'VERIFICATION', 'RISK', 'DISPUTE', 'ADVERTISING', 'SUBSCRIPTION', 'COUNTRY', 'CATEGORY', 'TRADE');--> statement-breakpoint
CREATE TYPE "public"."verification_level" AS ENUM('NONE', 'BASIC', 'VERIFIED', 'BUSINESS_VERIFIED', 'INTERNATIONAL_VERIFIED');--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('PENDING', 'SUBMITTED', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'EXPIRED', 'REVOKED');--> statement-breakpoint
CREATE TYPE "public"."risk_level" AS ENUM('LOW', 'MEDIUM', 'HIGH', 'SEVERE');--> statement-breakpoint
CREATE TYPE "public"."dispute_decision" AS ENUM('NONE', 'IN_FAVOR_OF_BUYER', 'IN_FAVOR_OF_SELLER', 'SPLIT', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."dispute_status" AS ENUM('OPEN', 'UNDER_REVIEW', 'REQUESTED_FURTHER_EVIDENCE', 'ESCALATED', 'DECIDED', 'CLOSED', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."ad_event_type" AS ENUM('IMPRESSION', 'CLICK', 'CONVERSION');--> statement-breakpoint
CREATE TYPE "public"."advertiser_type" AS ENUM('MERCHANT', 'SUPPLIER', 'COMPANY');--> statement-breakpoint
CREATE TYPE "public"."campaign_objective" AS ENUM('PRODUCT_ADS', 'STORE_ADS', 'SUPPLIER_ADS', 'COMPANY_ADS', 'B2B_ADS', 'B2C_ADS', 'TOP_ADS', 'SPONSORED_SEARCH');--> statement-breakpoint
CREATE TYPE "public"."campaign_status" AS ENUM('DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."plan_target" AS ENUM('CUSTOMER', 'MERCHANT', 'SUPPLIER', 'COMPANY', 'GLOBAL');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('ACTIVE', 'TRIAL', 'PAST_DUE', 'CANCELLED', 'EXPIRED');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "authenticator_apps" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"secret" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "consents" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"consent_type" varchar(100) NOT NULL,
	"granted" boolean DEFAULT false NOT NULL,
	"given_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "email_verification_tokens" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "password_reset_tokens" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "permissions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "role_permissions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"role_id" varchar(36) NOT NULL,
	"permission_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "roles" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"name" varchar(50) NOT NULL,
	"description" text,
	"system" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "security_settings" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"require_2fa" boolean DEFAULT false NOT NULL,
	"login_notifications" boolean DEFAULT false NOT NULL,
	"device_tracking" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sessions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"token_hash" text NOT NULL,
	"ip_address" varchar(64),
	"user_agent" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_roles" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"role_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"email" varchar(320) NOT NULL,
	"phone" varchar(32),
	"password_hash" text NOT NULL,
	"first_name" varchar(100),
	"last_name" varchar(100),
	"email_verified" boolean DEFAULT false NOT NULL,
	"phone_verified" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_locked" boolean DEFAULT false NOT NULL,
	"locale" varchar(10) DEFAULT 'ar' NOT NULL,
	"mfa_enabled" boolean DEFAULT false NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cities" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"region_id" varchar(36) NOT NULL,
	"name" varchar(200) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "countries" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"code" varchar(2) NOT NULL,
	"iso3" varchar(3),
	"name" varchar(200) NOT NULL,
	"name_ar" varchar(200),
	"name_fr" varchar(200),
	"phone_prefix" varchar(10) NOT NULL,
	"currency_code" varchar(3) NOT NULL,
	"default_language" varchar(10) DEFAULT 'ar' NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"activated_at" timestamp with time zone,
	"policy_config" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "exchange_rates" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"from_code" varchar(3) NOT NULL,
	"to_code" varchar(3) NOT NULL,
	"rate" text NOT NULL,
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "currencies" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"code" varchar(3) NOT NULL,
	"name" varchar(100) NOT NULL,
	"symbol" varchar(10) NOT NULL,
	"decimals" integer DEFAULT 2 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "languages" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"code" varchar(10) NOT NULL,
	"name" varchar(100) NOT NULL,
	"native_name" varchar(100) NOT NULL,
	"is_rtl" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "regions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"country_id" varchar(36) NOT NULL,
	"name" varchar(200) NOT NULL,
	"code" varchar(50),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "companies" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"legal_name" varchar(250) NOT NULL,
	"slug" varchar(250) NOT NULL,
	"registration_number" varchar(100),
	"tax_id" varchar(100),
	"country_id" varchar(36),
	"city_id" varchar(36),
	"industry" varchar(150),
	"description" text,
	"logo_url" text,
	"verified" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_branches" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"company_id" varchar(36) NOT NULL,
	"name" varchar(200) NOT NULL,
	"address" text,
	"country_id" varchar(36),
	"city_id" varchar(36),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "merchants" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"store_name" varchar(200) NOT NULL,
	"slug" varchar(250) NOT NULL,
	"country_id" varchar(36),
	"city_id" varchar(36),
	"description" text,
	"logo_url" text,
	"verified" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "profiles" (
	"user_id" varchar(36) PRIMARY KEY NOT NULL,
	"display_name" varchar(150),
	"avatar_url" text,
	"bio" text,
	"country_id" varchar(36),
	"city_id" varchar(36),
	"default_currency_id" varchar(36),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "supplier_contacts" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"supplier_id" varchar(36) NOT NULL,
	"full_name" varchar(150) NOT NULL,
	"email" varchar(320),
	"phone" varchar(32),
	"position" varchar(100),
	"is_primary" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "suppliers" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"company_name" varchar(200) NOT NULL,
	"slug" varchar(250) NOT NULL,
	"country_id" varchar(36),
	"city_id" varchar(36),
	"description" text,
	"logo_url" text,
	"verified" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "categories" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"parent_id" varchar(36),
	"name" varchar(200) NOT NULL,
	"name_ar" varchar(200),
	"name_fr" varchar(200),
	"slug" varchar(250) NOT NULL,
	"description" text,
	"icon" varchar(200),
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "product_images" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"product_id" varchar(36) NOT NULL,
	"url" text NOT NULL,
	"alt_text" varchar(200),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "product_variants" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"product_id" varchar(36) NOT NULL,
	"name" varchar(200) NOT NULL,
	"sku" varchar(100) NOT NULL,
	"price" numeric(18, 4) NOT NULL,
	"attributes" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "products" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"seller_id" varchar(36) NOT NULL,
	"seller_type" "seller_type" NOT NULL,
	"category_id" varchar(36) NOT NULL,
	"name" varchar(250) NOT NULL,
	"name_ar" varchar(250),
	"name_fr" varchar(250),
	"slug" varchar(300) NOT NULL,
	"description" text,
	"brand" varchar(150),
	"sku" varchar(100) NOT NULL,
	"barcode" varchar(100),
	"country_id" varchar(36),
	"currency_code" varchar(3) DEFAULT 'TND' NOT NULL,
	"base_price" numeric(18, 4) NOT NULL,
	"moq" integer DEFAULT 1 NOT NULL,
	"unit" varchar(30) DEFAULT 'piece' NOT NULL,
	"status" "product_status" DEFAULT 'DRAFT' NOT NULL,
	"is_published" boolean DEFAULT false NOT NULL,
	"tags" jsonb,
	"specifications" jsonb,
	"purchase_intent" varchar(10) DEFAULT 'B2B' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "order_items" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"order_id" varchar(36) NOT NULL,
	"product_id" varchar(36) NOT NULL,
	"product_variant_id" varchar(36),
	"unit_price" numeric(18, 4) NOT NULL,
	"quantity" integer NOT NULL,
	"line_total" numeric(18, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "orders" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"order_number" varchar(40) NOT NULL,
	"buyer_id" varchar(36) NOT NULL,
	"buyer_type" "buyer_type" DEFAULT 'CUSTOMER' NOT NULL,
	"seller_id" varchar(36) NOT NULL,
	"seller_type" "seller_type" NOT NULL,
	"currency_code" varchar(3) DEFAULT 'TND' NOT NULL,
	"items_total" numeric(18, 4) NOT NULL,
	"commission" numeric(18, 4) DEFAULT '0' NOT NULL,
	"payment_fee" numeric(18, 4) DEFAULT '0' NOT NULL,
	"grand_total" numeric(18, 4) NOT NULL,
	"status" "order_status" DEFAULT 'DRAFT' NOT NULL,
	"payment_status" "payment_status" DEFAULT 'UNPAID' NOT NULL,
	"refund_status" "refund_status" DEFAULT 'NONE' NOT NULL,
	"settlement_status" "settlement_status" DEFAULT 'PENDING' NOT NULL,
	"notes" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payments" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"transaction_id" varchar(36) NOT NULL,
	"order_id" varchar(36) NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"currency_code" varchar(3) NOT NULL,
	"provider" varchar(100),
	"external_ref" varchar(200),
	"status" "payment_status" DEFAULT 'PENDING' NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "refunds" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"payment_id" varchar(36) NOT NULL,
	"order_id" varchar(36) NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"currency_code" varchar(3) NOT NULL,
	"reason" text,
	"status" "refund_status" DEFAULT 'REQUESTED' NOT NULL,
	"requested_by_id" varchar(36),
	"processed_by_id" varchar(36),
	"external_ref" varchar(200),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "transaction_ledger" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"transaction_id" varchar(36) NOT NULL,
	"entry_type" "ledger_entry_type" NOT NULL,
	"direction" "ledger_direction" NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"currency_code" varchar(3) NOT NULL,
	"payer_id" varchar(36),
	"beneficiary_id" varchar(36),
	"payment_provider" varchar(100),
	"status" "settlement_status" DEFAULT 'PENDING' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "transactions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"transaction_number" varchar(40) NOT NULL,
	"order_id" varchar(36),
	"buyer_id" varchar(36) NOT NULL,
	"seller_id" varchar(36) NOT NULL,
	"product_id" varchar(36),
	"quantity" integer,
	"unit_price" numeric(18, 4),
	"total_value" numeric(18, 4) NOT NULL,
	"currency_code" varchar(3) DEFAULT 'TND' NOT NULL,
	"commission" numeric(18, 4) DEFAULT '0' NOT NULL,
	"payment_fee" numeric(18, 4) DEFAULT '0' NOT NULL,
	"status" "payment_status" DEFAULT 'PENDING' NOT NULL,
	"payment_provider" varchar(100),
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inventory_items" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"product_id" varchar(36) NOT NULL,
	"product_variant_id" varchar(36),
	"merchant_id" varchar(36) NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"reserved_quantity" integer DEFAULT 0 NOT NULL,
	"low_stock_threshold" integer DEFAULT 5 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inventory_movements" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"inventory_item_id" varchar(36) NOT NULL,
	"movement_type" "inventory_movement_type" NOT NULL,
	"quantity_change" integer NOT NULL,
	"reason" text,
	"reference_type" varchar(60),
	"reference_id" varchar(36),
	"created_by_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "commission_policies" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"policy_type" "commission_policy_type" DEFAULT 'BASE' NOT NULL,
	"rate" numeric(9, 6) NOT NULL,
	"conditions" jsonb,
	"priority" integer DEFAULT 100 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"created_by_id" varchar(36),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "commissions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"transaction_id" varchar(36) NOT NULL,
	"policy_id" varchar(36),
	"rate" numeric(9, 6) NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"currency_code" varchar(3) NOT NULL,
	"payer_id" varchar(36) NOT NULL,
	"beneficiary_id" varchar(36),
	"status" varchar(30) DEFAULT 'PENDING' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_fee_policies" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"provider" varchar(100) NOT NULL,
	"percent_rate" numeric(9, 6) DEFAULT '0' NOT NULL,
	"flat_fee" numeric(18, 4) DEFAULT '0' NOT NULL,
	"currency_code" varchar(3) DEFAULT 'USD' NOT NULL,
	"conditions" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "policies" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"scope" "policy_scope" NOT NULL,
	"code" varchar(120) NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" text,
	"rules" jsonb NOT NULL,
	"country_id" varchar(36),
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_id" varchar(36),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reviews" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"reviewer_id" varchar(36) NOT NULL,
	"subject_id" varchar(36) NOT NULL,
	"subject_type" varchar(40) NOT NULL,
	"transaction_id" varchar(36),
	"rating" integer NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trust_scores" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"score" integer DEFAULT 50 NOT NULL,
	"level" varchar(30) DEFAULT 'BASIC' NOT NULL,
	"factors" jsonb,
	"summary" varchar(500),
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "verification_documents" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"request_id" varchar(36) NOT NULL,
	"type" varchar(100) NOT NULL,
	"file_ref" text NOT NULL,
	"ocr_data" jsonb,
	"ai_review" jsonb,
	"uploaded_by_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "verification_requests" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"target_level" "verification_level" NOT NULL,
	"status" "verification_status" DEFAULT 'PENDING' NOT NULL,
	"document_type" varchar(100),
	"document_ref" varchar(200),
	"is_business" boolean DEFAULT false NOT NULL,
	"business_id" varchar(36),
	"reviewed_by_id" varchar(36),
	"review_notes" text,
	"submitted_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "risk_events" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"event_type" varchar(100) NOT NULL,
	"severity" "risk_level" DEFAULT 'LOW' NOT NULL,
	"risk_score" integer DEFAULT 0 NOT NULL,
	"reason_code" varchar(100) NOT NULL,
	"recommended_action" varchar(200),
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "risk_profiles" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"current_score" integer DEFAULT 0 NOT NULL,
	"level" "risk_level" DEFAULT 'LOW' NOT NULL,
	"last_evaluated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"flags" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dispute_appeals" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"dispute_id" varchar(36) NOT NULL,
	"appealed_by_id" varchar(36) NOT NULL,
	"reason" text NOT NULL,
	"status" varchar(30) DEFAULT 'PENDING' NOT NULL,
	"decided_by" varchar(36),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dispute_evidence" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"dispute_id" varchar(36) NOT NULL,
	"uploaded_by_id" varchar(36) NOT NULL,
	"file_ref" text NOT NULL,
	"description" text,
	"content_type" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dispute_messages" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"dispute_id" varchar(36) NOT NULL,
	"sender_id" varchar(36) NOT NULL,
	"body" text NOT NULL,
	"is_evidence" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "disputes" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"dispute_number" varchar(40) NOT NULL,
	"order_id" varchar(36) NOT NULL,
	"opened_by_id" varchar(36) NOT NULL,
	"reason_code" varchar(100) NOT NULL,
	"description" text NOT NULL,
	"status" "dispute_status" DEFAULT 'OPEN' NOT NULL,
	"decision" "dispute_decision" DEFAULT 'NONE' NOT NULL,
	"decision_note" text,
	"decided_by" varchar(36),
	"decided_at" timestamp with time zone,
	"appeal_allowed" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messages" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"thread_id" varchar(36) NOT NULL,
	"sender_id" varchar(36) NOT NULL,
	"body" text NOT NULL,
	"message_type" varchar(40) DEFAULT 'TEXT' NOT NULL,
	"attachments" jsonb,
	"is_reported" boolean DEFAULT false NOT NULL,
	"report_reason" text,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification_preferences" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"channel" varchar(30) DEFAULT 'IN_APP' NOT NULL,
	"category" varchar(60) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notifications" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"type" varchar(60) NOT NULL,
	"title" varchar(250) NOT NULL,
	"body" text,
	"data" jsonb,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "thread_participants" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"thread_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"last_read_at" timestamp with time zone,
	"is_muted" boolean DEFAULT false NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "threads" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"participant_ids" jsonb NOT NULL,
	"subject" varchar(200),
	"related_entity_type" varchar(60),
	"related_entity_id" varchar(36),
	"is_blocked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ad_creatives" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"campaign_id" varchar(36) NOT NULL,
	"type" varchar(60) NOT NULL,
	"title" varchar(250) NOT NULL,
	"body" text,
	"media_url" text,
	"target_url" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ad_events" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"campaign_id" varchar(36) NOT NULL,
	"creative_id" varchar(36),
	"event_type" "ad_event_type" NOT NULL,
	"user_id" varchar(36),
	"session_id" varchar(100),
	"ip_hash" varchar(64),
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "campaigns" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"advertiser_id" varchar(36) NOT NULL,
	"advertiser_type" "advertiser_type" NOT NULL,
	"title" varchar(200) NOT NULL,
	"objective" "campaign_objective" NOT NULL,
	"status" "campaign_status" DEFAULT 'DRAFT' NOT NULL,
	"budget" numeric(18, 4) NOT NULL,
	"spent" numeric(18, 4) DEFAULT '0' NOT NULL,
	"currency_code" varchar(3) DEFAULT 'TND' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"targeting" jsonb,
	"ad_units" jsonb,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invoices" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"subscription_id" varchar(36) NOT NULL,
	"invoice_number" varchar(40) NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"currency_code" varchar(3) NOT NULL,
	"status" varchar(30) DEFAULT 'PENDING' NOT NULL,
	"external_ref" varchar(200),
	"due_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subscription_plans" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"code" varchar(60) NOT NULL,
	"name" varchar(150) NOT NULL,
	"name_ar" varchar(150),
	"name_fr" varchar(150),
	"plan_target" "plan_target" NOT NULL,
	"price_monthly" numeric(18, 4) DEFAULT '0' NOT NULL,
	"price_yearly" numeric(18, 4) DEFAULT '0' NOT NULL,
	"currency_code" varchar(3) DEFAULT 'TND' NOT NULL,
	"features" jsonb,
	"limits" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subscriptions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"plan_id" varchar(36) NOT NULL,
	"status" "subscription_status" DEFAULT 'TRIAL' NOT NULL,
	"billing_cycle" varchar(20) DEFAULT 'MONTHLY' NOT NULL,
	"auto_renew" boolean DEFAULT true NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_budgets" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36),
	"role_target" varchar(50),
	"period" varchar(20) DEFAULT 'MONTHLY' NOT NULL,
	"max_requests" integer,
	"max_tokens_input" integer,
	"max_tokens_output" integer,
	"max_cost" numeric(18, 10),
	"currency_code" varchar(3) DEFAULT 'USD' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_requests" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"request_type" varchar(100) NOT NULL,
	"model" varchar(100) NOT NULL,
	"tokens_input" integer DEFAULT 0 NOT NULL,
	"tokens_output" integer DEFAULT 0 NOT NULL,
	"cost" numeric(18, 10) DEFAULT '0' NOT NULL,
	"currency_code" varchar(3) DEFAULT 'USD' NOT NULL,
	"status" varchar(30) DEFAULT 'SUCCESS' NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_usage" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"tokens_input" integer DEFAULT 0 NOT NULL,
	"tokens_output" integer DEFAULT 0 NOT NULL,
	"cost" numeric(18, 10) DEFAULT '0' NOT NULL,
	"currency_code" varchar(3) DEFAULT 'USD' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "analytics_events" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"event_name" varchar(100) NOT NULL,
	"user_id" varchar(36),
	"session_id" varchar(100),
	"properties" jsonb,
	"ip_hash" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "daily_kpis" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"date" timestamp with time zone NOT NULL,
	"metric_name" varchar(100) NOT NULL,
	"metric_value" numeric(18, 4) NOT NULL,
	"dimensions" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dashboard_reports" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"report_code" varchar(100) NOT NULL,
	"title" varchar(200) NOT NULL,
	"report_data" jsonb,
	"generated_by_id" varchar(36),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_logs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"actor_id" varchar(36),
	"action" varchar(120) NOT NULL,
	"entity_type" varchar(100) NOT NULL,
	"entity_id" varchar(36),
	"before" jsonb,
	"after" jsonb,
	"ip_address" varchar(64),
	"user_agent" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "favorites" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"entity_type" varchar(40) NOT NULL,
	"entity_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "saved_items" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"item_type" varchar(40) NOT NULL,
	"item_id" varchar(36) NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "search_history" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"query" varchar(400) NOT NULL,
	"filters" jsonb,
	"results_count" varchar(20),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "authenticator_user_idx" ON "authenticator_apps" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "consent_user_type_idx" ON "consents" USING btree ("user_id","consent_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evt_user_idx" ON "email_verification_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evt_token_idx" ON "email_verification_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prt_user_idx" ON "password_reset_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prt_token_idx" ON "password_reset_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "permissions_name_idx" ON "permissions" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "role_perm_idx" ON "role_permissions" USING btree ("role_id","permission_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "role_permissions_role_idx" ON "role_permissions" USING btree ("role_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "roles_name_idx" ON "roles" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "security_settings_user_idx" ON "security_settings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_token_hash_idx" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_role_idx" ON "user_roles" USING btree ("user_id","role_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_roles_role_idx" ON "user_roles" USING btree ("role_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_phone_idx" ON "users" USING btree ("phone");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cities_region_idx" ON "cities" USING btree ("region_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cities_name_idx" ON "cities" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "countries_code_idx" ON "countries" USING btree ("code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "exchange_rates_pair_idx" ON "exchange_rates" USING btree ("from_code","to_code");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "currencies_code_idx" ON "currencies" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "languages_code_idx" ON "languages" USING btree ("code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "regions_country_idx" ON "regions" USING btree ("country_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "regions_name_idx" ON "regions" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "companies_user_idx" ON "companies" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "companies_slug_idx" ON "companies" USING btree ("slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "companies_country_idx" ON "companies" USING btree ("country_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_branches_company_idx" ON "company_branches" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "merchants_user_idx" ON "merchants" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "merchants_slug_idx" ON "merchants" USING btree ("slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchants_country_idx" ON "merchants" USING btree ("country_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "profiles_country_idx" ON "profiles" USING btree ("country_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_contacts_supplier_idx" ON "supplier_contacts" USING btree ("supplier_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "suppliers_user_idx" ON "suppliers" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "suppliers_slug_idx" ON "suppliers" USING btree ("slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "suppliers_country_idx" ON "suppliers" USING btree ("country_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "categories_slug_idx" ON "categories" USING btree ("slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "categories_parent_idx" ON "categories" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "images_product_idx" ON "product_images" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "variants_product_idx" ON "product_variants" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "variants_sku_idx" ON "product_variants" USING btree ("sku");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_slug_idx" ON "products" USING btree ("slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_seller_idx" ON "products" USING btree ("seller_id","seller_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_category_idx" ON "products" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_country_idx" ON "products" USING btree ("country_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_status_idx" ON "products" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "orders_order_number_idx" ON "orders" USING btree ("order_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_buyer_idx" ON "orders" USING btree ("buyer_id","buyer_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_seller_idx" ON "orders" USING btree ("seller_id","seller_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_status_idx" ON "orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payments_tx_idx" ON "payments" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payments_order_idx" ON "payments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refunds_payment_idx" ON "refunds" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refunds_order_idx" ON "refunds" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ledger_tx_idx" ON "transaction_ledger" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ledger_payer_idx" ON "transaction_ledger" USING btree ("payer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ledger_beneficiary_idx" ON "transaction_ledger" USING btree ("beneficiary_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "transactions_tx_number_idx" ON "transactions" USING btree ("transaction_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transactions_order_idx" ON "transactions" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transactions_buyer_idx" ON "transactions" USING btree ("buyer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transactions_seller_idx" ON "transactions" USING btree ("seller_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_product_merchant_idx" ON "inventory_items" USING btree ("product_id","merchant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_merchant_idx" ON "inventory_items" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_movements_item_idx" ON "inventory_movements" USING btree ("inventory_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_movements_ref_idx" ON "inventory_movements" USING btree ("reference_type","reference_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commission_policies_name_idx" ON "commission_policies" USING btree ("name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commission_policies_active_idx" ON "commission_policies" USING btree ("is_active");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "commissions_tx_idx" ON "commissions" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commissions_policy_idx" ON "commissions" USING btree ("policy_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_fee_policies_name_idx" ON "payment_fee_policies" USING btree ("name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "policies_scope_idx" ON "policies" USING btree ("scope");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "policies_code_idx" ON "policies" USING btree ("code","country_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reviews_subject_idx" ON "reviews" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reviews_reviewer_idx" ON "reviews" USING btree ("reviewer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trust_scores_user_idx" ON "trust_scores" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trust_scores_effective_idx" ON "trust_scores" USING btree ("effective_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verification_docs_request_idx" ON "verification_documents" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verification_user_idx" ON "verification_requests" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verification_status_idx" ON "verification_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "risk_events_user_idx" ON "risk_events" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "risk_events_severity_idx" ON "risk_events" USING btree ("severity");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "risk_events_type_idx" ON "risk_events" USING btree ("event_type");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "risk_profiles_user_idx" ON "risk_profiles" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dispute_appeals_dispute_idx" ON "dispute_appeals" USING btree ("dispute_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dispute_evidence_dispute_idx" ON "dispute_evidence" USING btree ("dispute_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dispute_messages_dispute_idx" ON "dispute_messages" USING btree ("dispute_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "disputes_number_idx" ON "disputes" USING btree ("dispute_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "disputes_order_idx" ON "disputes" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "disputes_opened_idx" ON "disputes" USING btree ("opened_by_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "disputes_status_idx" ON "disputes" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_thread_idx" ON "messages" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_sender_idx" ON "messages" USING btree ("sender_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_prefs_user_idx" ON "notification_preferences" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_user_idx" ON "notifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_read_idx" ON "notifications" USING btree ("user_id","read_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "thread_participants_thread_idx" ON "thread_participants" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "thread_participants_user_idx" ON "thread_participants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "threads_entity_idx" ON "threads" USING btree ("related_entity_type","related_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ad_creatives_campaign_idx" ON "ad_creatives" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ad_events_campaign_idx" ON "ad_events" USING btree ("campaign_id","event_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ad_events_created_idx" ON "ad_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaigns_advertiser_idx" ON "campaigns" USING btree ("advertiser_id","advertiser_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaigns_status_idx" ON "campaigns" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoices_subscription_idx" ON "invoices" USING btree ("subscription_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscription_plans_code_idx" ON "subscription_plans" USING btree ("code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscriptions_user_idx" ON "subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscriptions_status_idx" ON "subscriptions" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_budgets_user_idx" ON "ai_budgets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_requests_user_idx" ON "ai_requests" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_requests_type_idx" ON "ai_requests" USING btree ("request_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_requests_created_idx" ON "ai_requests" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_usage_user_period_idx" ON "ai_usage" USING btree ("user_id","period_start","period_end");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "analytics_events_name_idx" ON "analytics_events" USING btree ("event_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "analytics_events_created_idx" ON "analytics_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "analytics_events_user_idx" ON "analytics_events" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "daily_kpis_date_name_idx" ON "daily_kpis" USING btree ("date","metric_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dashboard_reports_code_idx" ON "dashboard_reports" USING btree ("report_code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_actor_idx" ON "audit_logs" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_action_idx" ON "audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_created_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "favorites_user_entity_idx" ON "favorites" USING btree ("user_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "saved_items_user_idx" ON "saved_items" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "search_history_user_idx" ON "search_history" USING btree ("user_id");