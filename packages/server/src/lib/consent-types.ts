/**
 * Consent types shared by more than one module.
 *
 * `CONSENT_TYPES` in `modules/privacy/service.ts` is the single registry of every
 * accepted type; the constants here exist so a consumer (e.g. the RFQ module)
 * never repeats a bare string literal that a typo could silently break — an
 * unknown type is rejected by the privacy route, not stored as `CUSTOM`.
 */

/**
 * B2B-01 — a seller's standing opt-in to receive requests for quotation.
 *
 * Deliberately separate from `B2B_PARTNER_DISCOVERY`: that consent was granted
 * for being *suggested as a partner*, not for receiving a company's request and
 * quoting on it. Reusing it would widen a consent the user never gave.
 */
export const RFQ_PARTICIPATION_CONSENT = 'RFQ_PARTICIPATION';
