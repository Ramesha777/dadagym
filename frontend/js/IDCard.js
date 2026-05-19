/**
 * Dada Gym — digital ID card modal (vanilla JS).
 *
 * Props:
 *   name              — full name
 *   role              — 'member' | 'trainer' | 'admin' (case-insensitive; 'tutor' → trainer)
 *   joinDate          — Date | Firestore Timestamp-like | ISO string | null
 *   photoURL          — optional image URL
 *   firebaseUid       — Auth UID; encoded in QR as DaDaGym|id|{uid} (Html5Qrcode-friendly plain text)
 *   gymPublicId       — optional 6-char Gym ID; shown on card face (QR still uses firebaseUid)
 *   userId            — deprecated: only used if firebaseUid empty and value looks like a UID (not Gym ID)
 *   specialization    — optional; trainer only
 *   phone             — shown on all cards (— if empty)
 *   membershipStatus  — member only; e.g. plan + Active/Expired
 *   gymLocation       — footer; default RA1 2SU…
 *   gymWebsiteUrl     — footer href; default https://dadagym.netlify.app
 *   gymWebsiteLabel   — footer link text; default hostname from URL
 */

import { buildDigitalIdQrPayload, isValidGymPublicId } from './gym-public-id.js';

var CSS_ONCE = false;
var QR_SCRIPT_PROMISE = null;

var ROLE_META = {
  trainer: { label: 'Trainer', bannerClass: 'id-card-banner--trainer' },
  member: { label: 'Member', bannerClass: 'id-card-banner--member' },
  admin: { label: 'Admin', bannerClass: 'id-card-banner--admin' }
};

function normalizeIdCardRole(role) {
  var r = String(role || '')
    .toLowerCase()
    .trim();
  if (r === 'tutor') r = 'trainer';
  if (r !== 'trainer' && r !== 'admin' && r !== 'member') r = 'member';
  return r;
}

/** @param {unknown} raw */
export function coerceJoinDate(raw) {
  if (raw == null || raw === '') return null;
  if (raw instanceof Date) return isNaN(raw.getTime()) ? null : raw;
  if (raw && typeof raw === 'object' && typeof /** @type {{ toDate?: () => Date }} */ (raw).toDate === 'function') {
    try {
      var d = /** @type {{ toDate: () => Date }} */ (raw).toDate();
      return d instanceof Date && !isNaN(d.getTime()) ? d : null;
    } catch (e) {
      return null;
    }
  }
  if (
    typeof raw === 'object' &&
    raw !== null &&
    typeof /** @type {{ seconds?: number }} */ (raw).seconds === 'number'
  ) {
    return new Date(/** @type {{ seconds: number }} */ (raw).seconds * 1000);
  }
  var parsed = new Date(/** @type {string | number} */ (raw));
  return isNaN(parsed.getTime()) ? null : parsed;
}

/** @param {unknown} raw */
export function formatJoinDateForId(raw) {
  var d = coerceJoinDate(raw);
  if (!d) return '—';
  try {
    return new Intl.DateTimeFormat(undefined, {
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    }).format(d);
  } catch (e) {
    return d.toLocaleDateString();
  }
}

function ensureIdCardCss() {
  if (CSS_ONCE || typeof document === 'undefined') return;
  CSS_ONCE = true;
  var href = new URL('../CSS/id-card.css', import.meta.url).href;
  var link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
}

function ensureQrCodeGlobal() {
  if (typeof window !== 'undefined' && window.QRCode) {
    return Promise.resolve(window.QRCode);
  }
  if (QR_SCRIPT_PROMISE) return QR_SCRIPT_PROMISE;
  QR_SCRIPT_PROMISE = new Promise(function(resolve, reject) {
    var s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
    s.async = true;
    s.onload = function() {
      if (window.QRCode) resolve(window.QRCode);
      else reject(new Error('QRCode global missing after load'));
    };
    s.onerror = function() {
      reject(new Error('Failed to load QRCode script'));
    };
    document.head.appendChild(s);
  });
  return QR_SCRIPT_PROMISE;
}

function initialsFromName(name) {
  var s = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!s.length) return '?';
  if (s.length === 1) return s[0].charAt(0).toUpperCase();
  return (s[0].charAt(0) + s[s.length - 1].charAt(0)).toUpperCase();
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** @param {HTMLElement} slot @param {string} name */
function mountIdCardPhoto(slot, name, photoURL) {
  slot.innerHTML = '';
  var trimmed = String(photoURL || '').trim();
  var valid = /^https?:\/\//i.test(trimmed);

  function showPlaceholder() {
    slot.innerHTML = '';
    var ph = document.createElement('div');
    ph.className = 'digital-id-card__photo digital-id-card__photo--placeholder';
    ph.setAttribute('role', 'img');
    ph.setAttribute('aria-label', 'Initials');
    ph.textContent = initialsFromName(name);
    slot.appendChild(ph);
  }

  if (!valid) {
    showPlaceholder();
    return;
  }

  var img = document.createElement('img');
  img.className = 'digital-id-card__photo';
  img.alt = '';
  img.decoding = 'async';
  img.loading = 'eager';
  img.onerror = showPlaceholder;
  img.src = trimmed;
  slot.appendChild(img);
}

/**
 * Open a Bootstrap 5 modal with the ID card. Removes itself when hidden.
 * @param {{ name?: string, role?: string, joinDate?: unknown, photoURL?: string, firebaseUid?: string, gymPublicId?: string, userId?: string, specialization?: string, phone?: string, membershipStatus?: string, gymLocation?: string, gymWebsiteUrl?: string, gymWebsiteLabel?: string }} props
 */
export function openIDCardModal(props) {
  ensureIdCardCss();
  var name = String((props && props.name) || 'Member').trim() || 'Member';
  var roleKey = normalizeIdCardRole(props && props.role);
  var meta = ROLE_META[roleKey];
  var joinLabel = formatJoinDateForId(props && props.joinDate);
  var photoURL = String((props && props.photoURL) || '').trim();
  var firebaseUid = String((props && props.firebaseUid) || '').trim();
  if (!firebaseUid && props && props.userId) {
    var legacyUid = String(props.userId).trim();
    if (legacyUid.length >= 10 && /^[A-Za-z0-9_-]+$/.test(legacyUid) && !isValidGymPublicId(legacyUid)) {
      firebaseUid = legacyUid;
    }
  }
  var gymPublicId = '';
  if (props && props.gymPublicId && isValidGymPublicId(String(props.gymPublicId).trim())) {
    gymPublicId = String(props.gymPublicId).trim();
  }
  var spec = String((props && props.specialization) || '').trim();
  var phone = String((props && props.phone) || '').trim();
  var trainerSpecHtml = '';
  if (roleKey === 'trainer' && spec) {
    trainerSpecHtml =
      '<div class="digital-id-card__spec">' +
      '<span class="digital-id-card__spec-label">Specialization</span>' +
      '<span class="digital-id-card__spec-value">' +
      escapeAttr(spec) +
      '</span>' +
      '</div>';
  }

  var membershipRowHtml = '';
  if (roleKey === 'member') {
    var membershipStatus = String((props && props.membershipStatus) || '').trim() || '—';
    membershipRowHtml =
      '<div class="digital-id-card__row digital-id-card__row--membership">' +
      '<span class="digital-id-card__row-label">Membership</span>' +
      '<span class="digital-id-card__row-value">' +
      escapeAttr(membershipStatus) +
      '</span>' +
      '</div>';
  }

  var phoneRowHtml =
    '<div class="digital-id-card__row digital-id-card__row--phone">' +
    '<span class="digital-id-card__row-label">Phone</span>' +
    '<span class="digital-id-card__row-value">' +
    escapeAttr(phone || '—') +
    '</span>' +
    '</div>';

  var gymIdRowHtml = '';
  if (gymPublicId) {
    gymIdRowHtml =
      '<div class="digital-id-card__row digital-id-card__row--gym-id">' +
      '<span class="digital-id-card__row-label">Gym ID</span>' +
      '<span class="digital-id-card__row-value font-monospace">' +
      escapeAttr(gymPublicId) +
      '</span>' +
      '</div>';
  }

  var gymLoc = String((props && props.gymLocation) || 'RA1 2SU, 7 Krishal Road').trim();
  var gymWebUrl = String((props && props.gymWebsiteUrl) || 'https://dadagym.netlify.app').trim();
  var gymWebLabel = String((props && props.gymWebsiteLabel) || '').trim();
  if (!/^https?:\/\//i.test(gymWebUrl)) gymWebUrl = 'https://' + gymWebUrl;
  if (!gymWebLabel) gymWebLabel = gymWebUrl.replace(/^https?:\/\//i, '');
  var footerHtml =
    '<footer class="digital-id-card__footer">' +
    '<div class="digital-id-card__footer-loc">' +
    '<i class="fas fa-location-dot" aria-hidden="true"></i>' +
    '<span>' +
    escapeAttr(gymLoc) +
    '</span></div>' +
    '<a class="digital-id-card__footer-web" href="' +
    escapeAttr(gymWebUrl) +
    '" target="_blank" rel="noopener noreferrer">' +
    escapeAttr(gymWebLabel) +
    '</a>' +
    '</footer>';

  var idCardLogoSrc = 'images/logo.png';
  try {
    idCardLogoSrc = new URL('../images/logo.png', import.meta.url).href;
  } catch (e) {
    /* keep relative fallback */
  }

  var ModalCtor = typeof window !== 'undefined' && window.bootstrap && window.bootstrap.Modal;
  if (!ModalCtor) {
    console.error('IDCard: Bootstrap Modal not found (load bootstrap.bundle.min.js).');
    return;
  }

  var wrap = document.createElement('div');
  wrap.className = 'modal fade id-card-modal-wrap';
  wrap.setAttribute('tabindex', '-1');
  wrap.setAttribute('aria-hidden', 'true');
  wrap.innerHTML =
    '<div class="modal-dialog modal-dialog-centered">' +
    '  <div class="modal-content">' +
    '    <div class="modal-header py-2 px-3">' +
    '      <h5 class="modal-title text-white small mb-0"><i class="fas fa-id-card me-2 text-warning"></i>Gym ID</h5>' +
    '      <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal" aria-label="Close"></button>' +
    '    </div>' +
    '    <div class="modal-body id-card-modal-body py-3">' +
    '      <div class="id-card-modal-loading" id="idCardLoading">Preparing your card…</div>' +
    '    </div>' +
    '    <div class="modal-footer border-0 pt-0 pb-3 justify-content-center">' +
    '      <button type="button" class="btn btn-outline-light btn-sm" data-bs-dismiss="modal">Close</button>' +
    '    </div>' +
    '  </div>' +
    '</div>';

  document.body.appendChild(wrap);
  var bodyEl = wrap.querySelector('.id-card-modal-body');
  var loadingEl = wrap.querySelector('#idCardLoading');

  var modal = ModalCtor.getOrCreateInstance(wrap);

  wrap.addEventListener(
    'hidden.bs.modal',
    function() {
      modal.dispose();
      wrap.remove();
    },
    { once: true }
  );

  modal.show();

  function renderCard() {
    if (!bodyEl) return;
    bodyEl.innerHTML =
      '<div class="digital-id-card digital-id-card--' +
      escapeAttr(roleKey) +
      '" role="region" aria-label="Dada Gym member identification">' +
      '  <div class="digital-id-card__header">' +
      '    <span class="digital-id-card__header-brand">' +
      '      <img class="digital-id-card__header-logo" src="' +
      escapeAttr(idCardLogoSrc) +
      '" alt="" width="44" height="44" decoding="async">' +
      '      <span class="digital-id-card__header-text">Dada Gym</span>' +
      '    </span>' +
      '  </div>' +
      '  <div class="digital-id-card__body">' +
      '    <div class="digital-id-card__photo-wrap">' +
      '      <div class="digital-id-card__photo-slot" data-photo-slot></div>' +
      '    </div>' +
      '    <div class="digital-id-card__name">' +
      escapeAttr(name) +
      '</div>' +
      '    <div class="digital-id-card__banner ' +
      meta.bannerClass +
      '">' +
      escapeAttr(meta.label) +
      '</div>' +
      trainerSpecHtml +
      phoneRowHtml +
      gymIdRowHtml +
      membershipRowHtml +
      '    <div class="digital-id-card__joined">' +
      '      <i class="fas fa-calendar-plus"></i>' +
      '      <span>Joined <strong>' +
      escapeAttr(joinLabel) +
      '</strong></span>' +
      '    </div>' +
      '    <div class="digital-id-card__lower">' +
      '    <div class="digital-id-card__qr-stack">' +
      '      <div class="digital-id-card__qr-chip">' +
      '        <div class="digital-id-card__qr-host" id="idCardQrHost"></div>' +
      '      </div>' +
      '    </div>' +
      '    </div>' +
      footerHtml +
      '  </div>' +
      '</div>';

    var slot = bodyEl.querySelector('[data-photo-slot]');
    if (slot) mountIdCardPhoto(/** @type {HTMLElement} */ (slot), name, photoURL);

    var host = bodyEl.querySelector('#idCardQrHost');
    if (!host) return;

    ensureQrCodeGlobal()
      .then(function(QRCode) {
        host.innerHTML = '';
        var qrText = buildDigitalIdQrPayload(firebaseUid);
        if (!qrText) {
          host.innerHTML =
            '<p class="digital-id-card__qr-fallback small mb-0">No account ID — sign in again and retry.</p>';
          return;
        }
        var qrPx = qrText.length > 48 ? 168 : 148;
        new QRCode(host, {
          text: qrText,
          width: qrPx,
          height: qrPx,
          colorDark: '#0a0a0a',
          colorLight: '#f8fafc',
          correctLevel:
            QRCode.CorrectLevel != null ? QRCode.CorrectLevel.H : 0
        });
      })
      .catch(function() {
        host.innerHTML =
          '<p class="digital-id-card__qr-fallback small mb-0">QR code could not be generated.</p>';
      });
  }

  if (loadingEl) loadingEl.remove();
  renderCard();
}

export { normalizeIdCardRole, ROLE_META };
