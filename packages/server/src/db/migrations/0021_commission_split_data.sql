-- C-1: WASIT base commission becomes 4% of the transaction value, split
-- 2% seller + 2% buyer (payment-provider fees stay a separate policy).
--
-- This is non-destructive: it only rewrites the legacy seeded BASE policy that
-- still carries the old 3% seller-only shape, leaving any Admin-customised
-- policy untouched. Historical orders/transactions keep their recorded figures
-- (buyer_commission defaults to 0 for them) so past settlements are not rewritten.

UPDATE "commission_policies"
SET
  "rate" = '0.04',
  "seller_rate" = '0.02',
  "buyer_rate" = '0.02',
  "name" = 'WASIT Base Commission 4% (2% seller + 2% buyer)',
  "updated_at" = now()
WHERE "policy_type" = 'BASE'
  AND "rate" = '0.03'
  AND "seller_rate" = '0'
  AND "buyer_rate" = '0';