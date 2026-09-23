import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { coreMiddleware } from './middleware/core.js';
import { resolveCorsOrigin } from './lib/env.js';
import { securityHeaders } from './middleware/security-headers.js';
import { observabilityMiddleware } from './middleware/observability.js';
import { errorBody, errorHandlerMiddleware } from './middleware/errors.js';
import { getTraceId } from './lib/request-context.js';
import { authRoutes } from './modules/auth/routes.js';
import { healthRoutes } from './modules/health/routes.js';
import { productsRoutes } from './modules/products/routes.js';
import { ordersRoutes } from './modules/orders/routes.js';
import { suppliersRoutes } from './modules/suppliers/routes.js';
import { merchantRoutes } from './modules/merchants/routes.js';
import { companyRoutes } from './modules/companies/routes.js';
import { searchRoutes } from './modules/search/routes.js';
import { comparisonRoutes } from './modules/comparison/routes.js';
import { directoryRoutes } from './modules/directory/routes.js';
import { categoriesRoutes } from './modules/categories/routes.js';
import { inventoryRoutes } from './modules/inventory/routes.js';
import { messagingRoutes } from './modules/messaging/routes.js';
import { notificationRoutes } from './modules/notifications/routes.js';
import { verificationRoutes } from './modules/verification/routes.js';
import { trustRoutes } from './modules/trust/routes.js';
import { riskRoutes } from './modules/risk/routes.js';
import { disputeRoutes } from './modules/disputes/routes.js';
import { adminRoutes } from './modules/admin/routes.js';
import { adminEnginesRoutes } from './modules/admin/engines-routes.js';
import { adminAiRoutes } from './modules/admin/ai-routes.js';
import { adminAnalyticsRoutes } from './modules/admin/analytics-routes.js';
import { adminPolicyRoutes } from './modules/admin/policy-routes.js';
import { adminCountryRoutes } from './modules/admin/country-routes.js';
import { adsRoutes } from './modules/ads/routes.js';
import { aiRoutes } from './modules/ai/routes.js';
import { mediaRoutes } from './modules/media/routes.js';
import { analyticsRoutes } from './modules/analytics/routes.js';
import { revenueRoutes } from './modules/revenue/routes.js';
import { geoRoutes } from './modules/geo/routes.js';
import { subscriptionRoutes } from './modules/subscriptions/routes.js';
import { privacyRoutes, adminPrivacyRoutes } from './modules/privacy/routes.js';
import { customerLibraryRoutes } from './modules/customer-library/routes.js';
import { seoRoutes, seoApiRoutes } from './modules/seo/routes.js';
import { paymentsRoutes, paymentWebhookRoutes } from './modules/payments/routes.js';
import { metricsRoutes, adminObservabilityRoutes } from './modules/observability/routes.js';
import { catalogHeartbeat } from './lib/ai/routing.js';
import { getDb } from './lib/request-context.js';

export function createApp(): Hono {
  const app = new Hono();

  app.use('*', errorHandlerMiddleware);
  app.use('*', coreMiddleware);
  app.use('*', securityHeaders);
  // Structured request logging + metrics, tagged with the trace id. Replaces
  // Hono's `logger()` so there is exactly one log line per request.
  app.use('*', observabilityMiddleware());
  app.use(
    '*',
    cors({
      // Unset CORS_ORIGIN keeps the permissive dev/test behavior; a deployed
      // environment configures the allow-list so a foreign origin cannot read
      // credentialed responses.
      origin: (origin) => resolveCorsOrigin(origin),
      credentials: true,
    }),
  );

  app.onError((err, c) => errorBody(err, c));

  app.route('/api/auth', authRoutes);
  app.route('/api/health', healthRoutes);
  app.get('/api/health/ai', async (c) => {
    // Public non-credential AI health probe.
    const heartbeat = await catalogHeartbeat(getDb(c));
    return c.json({
      success: true,
      data: {
        ok: heartbeat.ok,
        models: heartbeat.models,
        provider: 'local-heuristic',
      },
    });
  });
  app.route('/api/products', productsRoutes);
  app.route('/api/orders', ordersRoutes);
  app.route('/api/suppliers', suppliersRoutes);
  app.route('/api/merchants', merchantRoutes);
  app.route('/api/companies', companyRoutes);
  app.route('/api/search', searchRoutes);
  app.route('/api/price-comparison', comparisonRoutes);
  app.route('/api/directory', directoryRoutes);
  app.route('/api/library', customerLibraryRoutes);
  app.route('/api/categories', categoriesRoutes);
  app.route('/api/inventory', inventoryRoutes);
  app.route('/api/ads', adsRoutes);
  app.route('/api/ai', aiRoutes);
  app.route('/api/media', mediaRoutes);
  app.route('/api/messages', messagingRoutes);
  app.route('/api/notifications', notificationRoutes);
  app.route('/api/verification', verificationRoutes);
  app.route('/api/trust', trustRoutes);
  app.route('/api/risk', riskRoutes);
  app.route('/api/disputes', disputeRoutes);
  app.route('/api/analytics', analyticsRoutes);
  app.route('/api/revenue', revenueRoutes);
  app.route('/api/geo', geoRoutes);
  app.route('/api/subscriptions', subscriptionRoutes);
  app.route('/api/privacy', privacyRoutes);
  app.route('/api/payments', paymentsRoutes);
  // Provider webhooks authenticate via HMAC signature, not a user session,
  // so they live on a separate mount path outside the session-guarded router.
  app.route('/api/payment-webhooks', paymentWebhookRoutes);
  app.route('/api/admin/privacy', adminPrivacyRoutes);
  app.route('/api/admin/policies', adminPolicyRoutes);
  app.route('/api/admin/countries', adminCountryRoutes);
  app.route('/api/admin', adminRoutes);
  app.route('/api/admin', adminEnginesRoutes);
  app.route('/api/admin/ai', adminAiRoutes);
  app.route('/api/admin/analytics', adminAnalyticsRoutes);
  app.route('/api/admin/observability', adminObservabilityRoutes);

  // Prometheus scrape endpoint at the root (outside /api), so a scrape config
  // is `metrics_path: /metrics`.
  app.route('/', metricsRoutes);

  // Crawler-facing surfaces (root-mounted: /sitemap.xml, /robots.txt).
  app.route('/', seoRoutes);
  app.route('/api/seo', seoApiRoutes);

  app.get('/', (c) =>
    c.json({
      name: 'WASIT Business Global API',
      version: '0.1.0',
      status: 'operational',
    }),
  );

  app.notFound((c) =>
    c.json(
      {
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Resource not found',
          statusCode: 404,
          traceId: getTraceId(c),
        },
      },
      404 as never,
    ),
  );

  return app;
}
