export const PERMISSIONS = {
  // Auth & profile
  AUTH_READ_OWN: 'auth:read:own',
  AUTH_UPDATE_OWN: 'auth:update:own',

  // Users
  USER_READ: 'user:read',
  USER_READ_OWN: 'user:read:own',
  USER_CREATE: 'user:create',
  USER_UPDATE: 'user:update',
  USER_DELETE: 'user:delete',
  USER_LIST: 'user:list',

  // Products
  PRODUCT_CREATE: 'product:create',
  PRODUCT_READ: 'product:read',
  PRODUCT_UPDATE: 'product:update',
  PRODUCT_DELETE: 'product:delete',
  PRODUCT_LIST: 'product:list',
  PRODUCT_MANAGE: 'product:manage',

  // Suppliers
  SUPPLIER_CREATE: 'supplier:create',
  SUPPLIER_READ: 'supplier:read',
  SUPPLIER_UPDATE: 'supplier:update',
  SUPPLIER_DELETE: 'supplier:delete',
  SUPPLIER_LIST: 'supplier:list',

  // Merchants
  MERCHANT_CREATE: 'merchant:create',
  MERCHANT_READ: 'merchant:read',
  MERCHANT_UPDATE: 'merchant:update',
  MERCHANT_DELETE: 'merchant:delete',
  MERCHANT_LIST: 'merchant:list',

  // Companies
  COMPANY_CREATE: 'company:create',
  COMPANY_READ: 'company:read',
  COMPANY_UPDATE: 'company:update',
  COMPANY_DELETE: 'company:delete',
  COMPANY_LIST: 'company:list',

  // Orders
  ORDER_CREATE: 'order:create',
  ORDER_READ: 'order:read',
  ORDER_READ_OWN: 'order:read:own',
  ORDER_UPDATE: 'order:update',
  ORDER_DELETE: 'order:delete',
  ORDER_LIST: 'order:list',

  // Transactions
  TRANSACTION_READ: 'transaction:read',
  TRANSACTION_LIST: 'transaction:list',
  LEDGER_READ: 'ledger:read',
  COMMISSION_READ: 'commission:read',
  COMMISSION_MANAGE: 'commission:manage',

  // Payments
  PAYMENT_CREATE: 'payment:create',
  PAYMENT_READ: 'payment:read',
  REFUND_MANAGE: 'refund:manage',

  // Inventory
  INVENTORY_READ: 'inventory:read',
  INVENTORY_UPDATE: 'inventory:update',
  INVENTORY_MOVEMENT_CREATE: 'inventory:movement:create',

  // Admin
  ADMIN_USERS: 'admin:users',
  ADMIN_ADS: 'admin:ads',
  ADMIN_AI: 'admin:ai',
  ADMIN_ANALYTICS: 'admin:analytics',
  ADMIN_SYSTEM: 'admin:system',
  ADMIN_POLICIES: 'admin:policies',
  ADMIN_COMMISSIONS: 'admin:commissions',
  ADMIN_SUBSCRIPTIONS: 'admin:subscriptions',
  ADMIN_VERIFICATION: 'admin:verification',
  ADMIN_TRUST: 'admin:trust',
  ADMIN_RISK: 'admin:risk',
  ADMIN_DISPUTES: 'admin:disputes',
  ADMIN_REPORTS: 'admin:reports',
  AUDIT_LOG_READ: 'audit:log:read',
  AUDIT_LOG_EXPORT: 'audit:log:export',

  // Messaging
  MESSAGE_SEND: 'message:send',
  MESSAGE_READ_OWN: 'message:read:own',

  // Verification
  VERIFICATION_SUBMIT: 'verification:submit',
  VERIFICATION_READ: 'verification:read',
  VERIFICATION_REVIEW: 'verification:review',
  VERIFICATION_APPROVE: 'verification:approve',
  VERIFICATION_REJECT: 'verification:reject',
  VERIFICATION_MANAGE: 'verification:manage',

  // Trust & Risk
  TRUST_READ_OWN: 'trust:read:own',
  TRUST_READ: 'trust:read',
  TRUST_READ_ALL: 'trust:read:all',
  RISK_MANAGE: 'risk:manage',
  RISK_READ: 'risk:read',
  RISK_REVIEW: 'risk:review',

  // Disputes
  DISPUTE_CREATE: 'dispute:create',
  DISPUTE_READ: 'dispute:read',
  DISPUTE_READ_OWN: 'dispute:read:own',
  DISPUTE_ASSIGN: 'dispute:assign',
  DISPUTE_REVIEW: 'dispute:review',
  DISPUTE_MANAGE: 'dispute:manage',
  DISPUTE_DECIDE: 'dispute:decide',
  DISPUTE_RESOLVE: 'dispute:resolve',

  // Ads
  AD_CREATE: 'ad:create',
  AD_MANAGE: 'ad:manage',
  CAMPAIGN_CREATE: 'campaign:create',
  CAMPAIGN_MANAGE: 'campaign:manage',

  // AI
  AI_USE: 'ai:use',
  AI_MANAGE: 'ai:manage',
  AI_COST_READ: 'ai:cost:read',

  // Media assets (marketing videos, generated media)
  MEDIA_UPLOAD: 'media:upload',
  MEDIA_READ_OWN: 'media:read:own',
  MEDIA_DELETE_OWN: 'media:delete:own',
  MEDIA_DELETE_ANY: 'media:delete:any',

  // Analytics
  ANALYTICS_READ_OWN: 'analytics:read:own',
  ANALYTICS_READ_ALL: 'analytics:read:all',

  // Search
  SEARCH_PUBLIC: 'search:public',
  SEARCH_ADVANCED: 'search:advanced',

  // Favorites, saved items & search history (per-user)
  FAVORITE_MANAGE: 'favorite:manage',
  SAVED_ITEM_MANAGE: 'saved:manage',
  SEARCH_HISTORY_MANAGE: 'search:history:manage',

  // Subscriptions
  SUBSCRIPTION_READ_OWN: 'subscription:read:own',
  SUBSCRIPTION_MANAGE: 'subscription:manage',
  SUBSCRIPTION_CREATE: 'subscription:create',
  SUBSCRIPTION_UPDATE: 'subscription:update',
  SUBSCRIPTION_CANCEL: 'subscription:cancel',

  // Revenue & Profitability
  REVENUE_READ: 'revenue:read',
  REVENUE_MANAGE: 'revenue:manage',
  REVENUE_SIMULATE: 'revenue:simulate',

  // Reports
  REPORT_READ: 'report:read',
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;
export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];