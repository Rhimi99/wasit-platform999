import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { coreMiddleware } from './middleware/core.js';
import { resolveCorsOrigin, env } from './lib/env.js';
import { securityHeaders } from './middleware/security-headers.js';
import { csrfProtection } from './middleware/csrf.js';
import { requestBodyLimit } from './middleware/body-limit.js';
import { rateLimit } from './middleware/rate-limit.js';
import { requireStaffMfa } from './middleware/mfa.js';
import { requireLegalAcceptance } from './modules/legal/enforcement.js';
import { observabilityMiddleware } from './middleware/observability.js';
import { errorBody, errorHandlerMiddleware } from './middleware/errors.js';
import { getTraceId } from './lib/request-context.js';
import { authRoutes } from './modules/auth/routes.js';
import { healthRoutes } from './modules/health/routes.js';
import { productsRoutes } from './modules/products/routes.js';
import { ordersRoutes } from './modules/orders/routes.js';
import { rfqRoutes } from './modules/rfq/routes.js';
import { suppliersRoutes } from './modules/suppliers/routes.js';
import { merchantRoutes } from './modules/merchants/routes.js';
import { companyRoutes } from './modules/companies/routes.js';
import { entityRoutes } from './modules/entities/routes.js';
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
import { disputeRoutes, publicDisputeRoutes } from './modules/disputes/routes.js';
import { adminRoutes } from './modules/admin/routes.js';
import { staffRoutes } from './modules/staff/routes.js';
import { adminEnginesRoutes } from './modules/admin/engines-routes.js';
import { adminAiRoutes } from './modules/admin/ai-routes.js';
import { adminAiProviderRoutes } from './modules/admin/ai-provider-routes.js';
import { adminAiSpendRoutes } from './modules/admin/ai-spend-routes.js';
import { adminAnalyticsRoutes } from './modules/admin/analytics-routes.js';
import { adminPolicyRoutes } from './modules/admin/policy-routes.js';
import { adminCountryRoutes } from './modules/admin/country-routes.js';
import { adsRoutes } from './modules/ads/routes.js';
import { aiRoutes } from './modules/ai/routes.js';
import { mediaRoutes } from './modules/media/routes.js';
import { PRODUCT_IMAGE_UPLOAD_ENVELOPE_BYTES } from './modules/media/images.js';
import { analyticsRoutes } from './modules/analytics/routes.js';
import { revenueRoutes } from './modules/revenue/routes.js';
import { geoRoutes } from './modules/geo/routes.js';
import { subscriptionRoutes } from './modules/subscriptions/routes.js';
import { privacyRoutes, adminPrivacyRoutes } from './modules/privacy/routes.js';
import { publicLegalRoutes, legalRoutes } from './modules/legal/routes.js';
import { customerLibraryRoutes } from './modules/customer-library/routes.js';
import { seoRoutes, seoApiRoutes } from './modules/seo/routes.js';
import { paymentsRoutes, paymentWebhookRoutes } from './modules/payments/routes.js';
import { metricsRoutes, adminObservabilityRoutes } from './modules/observability/routes.js';
import { taxRoutes } from './modules/tax/routes.js';
import { financeRoutes } from './modules/finance/routes.js';
import { catalogHeartbeat } from './lib/ai/routing.js';
import { getDb } from './lib/request-context.js';

export function createApp(): Hono {
  const app = new Hono();

  app.use('*', errorHandlerMiddleware);
  app.use('*', coreMiddleware);
  app.use('*', securityHeaders);
  // Reject an oversized request body before any handler (or the JSON parse)
  // reads it, so a large payload cannot be buffered by an expensive route.
  // The product-image upload is the only route that carries a binary, so it
  // gets its own ceiling (image limit + multipart envelope) rather than a
  // blanket raise that would also widen every JSON endpoint.
  app.use(
    '*',
    requestBodyLimit((path) =>
      path === '/api/media/product-images'
        ? env.MEDIA_MAX_IMAGE_BYTES + PRODUCT_IMAGE_UPLOAD_ENVELOPE_BYTES
        : env.MAX_REQUEST_BODY_BYTES,
    ),
  );
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

  // CSRF: reject cookie-authenticated state-changing requests whose origin is
  // not our own front-end (see `middleware/csrf.ts`). Runs after CORS so the
  // rejection still carries CORS headers, and before routing so no write route
  // can be reached first.
  app.use('*', csrfProtection());

  // Resource-exhaustion backstop (011.4). A generous general limit over `/api`
  // plus tighter limits on the expensive surfaces (AI, search, video render).
  // These are additions to — never replacements for — auth/RBAC/approval, and
  // they run before the MFA/legal gates so a flood is shed before any of that
  // work happens. `/api/auth` and `/api/health` are exempt: the former carries
  // its own per-action limits, the latter is a cheap operational probe.
  app.use(
    '/api/*',
    rateLimit({
      windowSeconds: env.RATE_LIMIT_API_WINDOW_SECONDS,
      max: () => env.RATE_LIMIT_API_MAX,
      keyPrefix: 'api',
      exemptPaths: ['/api/auth', '/api/health'],
    }),
  );
  // AI: a tight per-user limit plus a per-IP backstop (an attacker rotating
  // accounts from one host still trips the host limit).
  app.use(
    '/api/ai/*',
    rateLimit({
      windowSeconds: env.RATE_LIMIT_AI_WINDOW_SECONDS,
      max: () => env.RATE_LIMIT_AI_MAX,
      keyPrefix: 'ai-user',
      subject: 'user',
    }),
  );
  app.use(
    '/api/ai/*',
    rateLimit({
      windowSeconds: env.RATE_LIMIT_AI_WINDOW_SECONDS,
      max: () => env.RATE_LIMIT_AI_IP_MAX,
      keyPrefix: 'ai-ip',
      subject: 'ip',
    }),
  );
  // Search is public and relatively costly → limit per trusted client IP.
  app.use(
    '/api/search/*',
    rateLimit({
      windowSeconds: env.RATE_LIMIT_SEARCH_WINDOW_SECONDS,
      max: () => env.RATE_LIMIT_SEARCH_MAX,
      keyPrefix: 'search-ip',
      subject: 'ip',
    }),
  );
  // Video generation renders synchronously with ffmpeg → the tightest per-user
  // limit, on top of the in-process concurrency cap in the media service.
  app.use(
    '/api/media/marketing-videos',
    rateLimit({
      windowSeconds: env.RATE_LIMIT_VIDEO_WINDOW_SECONDS,
      max: () => env.RATE_LIMIT_VIDEO_MAX,
      keyPrefix: 'media-video',
      subject: 'user',
    }),
  );

  // Mandatory MFA for internal staff (LC-06). Mounted once over the whole /api
  // surface, after CSRF and before any router, so a staff account without an
  // enabled second factor is refused on *every* staff-reachable route — admin,
  // the desks (verification/trust/risk/disputes), revenue, and the mixed routes a
  // staff role can reach (orders, payments, subscriptions, ai, media, analytics,
  // tax, finance, observability, …). It only ever blocks the five staff roles, so
  // customers, merchants, suppliers, companies and marketers are untouched; it is
  // inert unless `STAFF_MFA_ENFORCEMENT` resolves to enforced. `/api/auth` and
  // `/api/health` are exempt so a staff member can sign in and enroll a factor.
  app.use('/api/*', requireStaffMfa());

  // Mandatory legal-document acceptance (LC-01). Mounted over the whole `/api`
  // surface, after CSRF. It is **inert by default** (`LEGAL_ACCEPTANCE_ENFORCEMENT`
  // defaults to `off`) and, even when switched on, it only blocks once a document
  // is actually published-and-in-force — so an unapproved draft can never lock
  // anyone out or be presented as binding. `/api/auth`, `/api/health` and the
  // legal module's own routes are exempt so a user can sign in, read the pending
  // list, and record acceptance without first clearing the gate.
  app.use('/api/*', requireLegalAcceptance());

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
  app.route('/api/rfqs', rfqRoutes);
  app.route('/api/suppliers', suppliersRoutes);
  app.route('/api/merchants', merchantRoutes);
  app.route('/api/companies', companyRoutes);
  app.route('/api/entities', entityRoutes);
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
  // Public refund/dispute policy summary: no session, no case data, disclosure
  // only. Kept on its own prefix so it is obviously outside the auth boundary.
  app.route('/api/public/disputes', publicDisputeRoutes);
  // Public legal documents: published texts only, no session. Same boundary
  // rationale as the public dispute policy above.
  app.route('/api/public/legal', publicLegalRoutes);
  app.route('/api/analytics', analyticsRoutes);
  app.route('/api/revenue', revenueRoutes);
  app.route('/api/geo', geoRoutes);
  app.route('/api/subscriptions', subscriptionRoutes);
  app.route('/api/privacy', privacyRoutes);
  app.route('/api/legal', legalRoutes);
  app.route('/api/payments', paymentsRoutes);
  // Provider webhooks authenticate via HMAC signature, not a user session,
  // so they live on a separate mount path outside the session-guarded router.
  app.route('/api/payment-webhooks', paymentWebhookRoutes);
  app.route('/api/admin/privacy', adminPrivacyRoutes);
  app.route('/api/admin/policies', adminPolicyRoutes);
  app.route('/api/admin/countries', adminCountryRoutes);
  // Registered before the broad `/api/admin` mounts: Hono dispatches to the
  // first mount that matches, so a later one would answer 404 for these paths.
  app.route('/api/admin/ai/providers', adminAiProviderRoutes);
  app.route('/api/admin/ai/spend', adminAiSpendRoutes);
  app.route('/api/admin/staff', staffRoutes);
  app.route('/api/admin', adminRoutes);
  app.route('/api/admin', adminEnginesRoutes);
  app.route('/api/admin/ai', adminAiRoutes);
  app.route('/api/admin/analytics', adminAnalyticsRoutes);
  app.route('/api/admin/observability', adminObservabilityRoutes);
  app.route('/api/admin/tax', taxRoutes);
  app.route('/api/admin/finance', financeRoutes);

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
