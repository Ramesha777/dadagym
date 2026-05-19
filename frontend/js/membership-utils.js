/**
 * Shared membership state (member doc fields written by payment.js).
 * Keeps trainer check-in / booking gate / checkout aligned.
 */
export function isMemberPlanActive(d) {
    if (!d || !d.planId) return false;

    var expMs = null;
    if (d.planExpiresAt && typeof d.planExpiresAt.toMillis === 'function') {
        expMs = d.planExpiresAt.toMillis();
    }
    var notExpired = expMs === null ? true : expMs > Date.now();

    if (!notExpired) return false;

    if (d.planStatus === 'active') return true;

    // Cancelled but still entitled until paid-through date.
    if (d.planStatus === 'cancelled' && d.cancelAtPeriodEnd === true) return true;

    return false;
}
