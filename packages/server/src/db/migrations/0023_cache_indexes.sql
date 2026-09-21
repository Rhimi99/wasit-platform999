CREATE INDEX IF NOT EXISTS "products_public_created_idx" ON "products" USING btree ("is_published","status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_public_category_created_idx" ON "products" USING btree ("category_id","is_published","status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_buyer_created_idx" ON "orders" USING btree ("buyer_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_seller_created_idx" ON "orders" USING btree ("seller_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_thread_created_idx" ON "messages" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_user_created_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoices_status_due_idx" ON "invoices" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoices_subscription_status_idx" ON "invoices" USING btree ("subscription_id","status");