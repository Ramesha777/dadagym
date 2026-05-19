/* ═══════════════════════════════════════
   DaDaGym — Trainer dashboard + chat (RTDB)
   ═══════════════════════════════════════ */

import { firebaseConfig } from './firebase-config.js';
import { isMemberPlanActive } from './membership-utils.js';
import { ensureGymPublicId, isValidGymPublicId } from './gym-public-id.js';
import { openIDCardModal } from './IDCard.js';
import { parseGymBookingCheckinRaw } from './booking-checkin-parse.js';

firebase.initializeApp(firebaseConfig);

var auth = firebase.auth();
var db   = firebase.firestore();
var rtdb = firebase.database();
var $ = function(id) { return document.getElementById(id); };

var currentUid = null;
var currentUser = null;
var trainerData = {};
var chatMsgUnsub = null;
var trainerClassRequestByClassId = {};
var trainerHtml5QrCode = null;
var trainerClassTrackWeekOffset = 0;
var trainerSessionLogModalInst = null;
var trainerSessionLogContext = null;

/** Booking class id for accepted 1:1 session requests (must match Firestore rules). */
var PERSONAL_1TO1_CLASS_ID = '__personal_1to1__';

function personalSessionSlotKey(memberId, date, timeRaw) {
    var t = String(timeRaw || '')
        .trim()
        .replace(/:/g, '-')
        .replace(/\//g, '_');
    if (!t) t = 'na';
    return memberId + '_' + PERSONAL_1TO1_CLASS_ID + '_' + date + '_' + t;
}

function randomFiveDigitBookingCode() {
    return Math.floor(10000 + Math.random() * 90000);
}

function refreshTrainerGymPublicIdUi(gymPid) {
    var side = $('sidebarGymPublicId');
    if (side) {
        if (gymPid && isValidGymPublicId(gymPid)) {
            side.textContent = 'Tutor ID · ' + gymPid;
            side.classList.remove('d-none');
        } else {
            side.textContent = '';
            side.classList.add('d-none');
        }
    }
    var heroBlk = $('trainerHeroPublicIdBlock');
    var heroCode = $('trainerHeroPublicId');
    if (heroBlk && heroCode) {
        if (gymPid && isValidGymPublicId(gymPid)) {
            heroBlk.classList.remove('is-pending');
            heroCode.textContent = gymPid;
        } else {
            heroBlk.classList.add('is-pending');
            heroCode.textContent = 'Assigning\u2026';
        }
        heroBlk.classList.remove('d-none');
        heroBlk.hidden = false;
    }
    var prof = $('trainerGymPublicId');
    if (prof) prof.value = gymPid && isValidGymPublicId(gymPid) ? gymPid : '';
}

function runEnsureTrainerGymPublicId(email) {
    if (!currentUid || !email) return;
    ensureGymPublicId(db, currentUid, email, 'trainer')
        .then(function(pid) {
            if (!pid) return;
            if (trainerData) trainerData.gymPublicId = pid;
            refreshTrainerGymPublicIdUi(pid);
        })
        .catch(function(err) {
            console.warn('Gym public ID:', err && err.message ? err.message : err);
        });
}

function escHtml(s) {
    if (s == null || s === '') return '';
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

function syncTrainerSidebarFooterName(user) {
    var el = $('userEmail');
    if (!el || !user) return;
    var d = trainerData || {};
    var nm =
        typeof d.displayName === 'string' && d.displayName.trim() ? d.displayName.trim() : '';
    if (!nm && user.displayName && String(user.displayName).trim()) {
        nm = String(user.displayName).trim();
    }
    if (!nm && user.email && user.email.indexOf('@') > 0) {
        nm = user.email.split('@')[0];
    }
    if (!nm) nm = 'Trainer';
    el.textContent = nm;
    if (user.email) el.title = user.email;
    else el.removeAttribute('title');
}

function showDashboard(user) {
    $('loadingGate').style.display = 'none';
    $('mainContent').style.display = 'block';
    syncTrainerSidebarFooterName(user);
    refreshTrainerGymPublicIdUi(
        trainerData && trainerData.gymPublicId && isValidGymPublicId(trainerData.gymPublicId)
            ? trainerData.gymPublicId
            : ''
    );
    loadTrainerProfile(user.uid);
    loadTrainerOverviewStats();
    loadTrainerClasses();
}

auth.onAuthStateChanged(function(user) {
    if (!user || !user.emailVerified) {
        window.location.href = 'login.html';
        return;
    }
    currentUid = user.uid;
    currentUser = user;

    db.collection('trainers').doc(user.uid).get().then(function(doc) {
        if (!doc.exists || doc.data().approvalStatus !== 'approved') {
            window.location.href = 'login.html';
            return;
        }
        trainerData = doc.data() || {};
        showDashboard(user);
    }).catch(function() {
        window.location.href = 'login.html';
    });
});

function doTrainerLogout() {
    auth.signOut().then(function() {
        window.location.href = 'login.html';
    });
}

if ($('btnLogout')) {
    $('btnLogout').addEventListener('click', function() {
        if (chatMsgUnsub) {
            chatMsgUnsub();
            chatMsgUnsub = null;
        }
        var modalEl = $('logoutConfirmModal');
        if (!modalEl || typeof bootstrap === 'undefined') {
            if (window.confirm('Are you sure you want to log out?')) doTrainerLogout();
            return;
        }
        bootstrap.Modal.getOrCreateInstance(modalEl).show();
    });
}
if ($('btnLogoutConfirm')) {
    $('btnLogoutConfirm').addEventListener('click', function() {
        if (chatMsgUnsub) {
            chatMsgUnsub();
            chatMsgUnsub = null;
        }
        var modalEl = $('logoutConfirmModal');
        if (modalEl && typeof bootstrap !== 'undefined') {
            var inst = bootstrap.Modal.getInstance(modalEl);
            if (inst) inst.hide();
        }
        doTrainerLogout();
    });
}

/* ─── Sidebar ─── */
var sidebarLinks = document.querySelectorAll('.sidebar-nav a[data-section]');
var sections = document.querySelectorAll('.trainer-section');
var titles = {
    overview: '<i class="fas fa-chart-pie me-2 text-info"></i>Trainer Dashboard',
    profile: '<i class="fas fa-user me-2"></i>My Profile',
    classes: '<i class="fas fa-dumbbell me-2"></i>My Classes',
    members: '<i class="fas fa-users me-2"></i>My Members',
    schedule: '<i class="fas fa-calendar-alt me-2"></i>Schedule',
    checkin: '<i class="fas fa-qrcode me-2"></i>Member Check-in',
    availability: '<i class="fas fa-clock me-2"></i>My Availability',
    chat: '<i class="fas fa-comments me-2"></i>Chat'
};

sidebarLinks.forEach(function(link) {
    link.addEventListener('click', function(e) {
        if (!this.getAttribute('data-section')) return;
        e.preventDefault();
        switchSection(this.getAttribute('data-section'));
        closeSidebar();
    });
});

function switchSection(name) {
    sidebarLinks.forEach(function(a) { a.classList.remove('active'); });
    sections.forEach(function(s) { s.classList.remove('active'); });
    var lnk = document.querySelector('.sidebar-nav a[data-section="' + name + '"]');
    if (lnk) lnk.classList.add('active');
    var sec = $('sec-' + name);
    if (sec) sec.classList.add('active');
    if ($('topbarTitle')) $('topbarTitle').innerHTML = titles[name] || name;

    if (name !== 'checkin') stopTrainerQrScanner();

    if (name === 'members') loadMyMembers();
    if (name === 'classes') loadTrainerClasses();
    if (name === 'schedule') loadTrainerOverviewStats();
    if (name === 'availability') loadAvailability();
    if (name === 'chat') openTrainerAdminChat();
}

var sidebar = $('sidebar');
var overlay = $('sidebarOverlay');
if ($('menuToggle')) {
    $('menuToggle').addEventListener('click', function() {
        sidebar.classList.add('open');
        overlay.classList.add('open');
    });
}
function closeSidebar() {
    sidebar.classList.remove('open');
    overlay.classList.remove('open');
}
if ($('sidebarClose')) $('sidebarClose').addEventListener('click', closeSidebar);
if (overlay) overlay.addEventListener('click', closeSidebar);

function getInitials(name, fallback) {
    var src = (name && String(name).trim()) || fallback || '';
    if (!src) return '?';
    return src.split(/\s+/).map(function(w) { return w[0]; }).join('').substring(0, 2).toUpperCase();
}

function renderTrainerAvatar(name, email, photoURL) {
    var box = $('trainerAvatar');
    var initEl = $('trainerAvatarInitials');
    if (!box || !initEl) return;
    var initials = getInitials(name, email);
    initEl.textContent = initials;
    var existing = box.querySelector('img');
    if (existing) existing.remove();
    if (photoURL && /^https?:\/\//i.test(photoURL)) {
        var img = document.createElement('img');
        img.alt = name || 'Profile photo';
        img.src = photoURL;
        initEl.style.display = 'none';
        img.onerror = function() {
            img.remove();
            initEl.style.display = '';
        };
        box.appendChild(img);
    } else {
        initEl.style.display = '';
    }
}

function loadTrainerProfile(uid) {
    db.collection('trainers').doc(uid).get()
        .then(function(doc) {
            if (!doc.exists) return;
            trainerData = doc.data();
            var d = trainerData;
            if ($('tProfName')) $('tProfName').value = d.displayName || '';
            if ($('tProfEmail')) $('tProfEmail').value = d.email || (currentUser && currentUser.email) || '';
            if ($('tProfPhone')) $('tProfPhone').value = d.phone || '';
            if ($('tProfSpec')) $('tProfSpec').value = d.specialization || '';
            if ($('tProfExp')) $('tProfExp').value = d.experience != null ? d.experience : '';
            if ($('tProfQual')) $('tProfQual').value = d.qualifications || '';
            if ($('tProfBio')) $('tProfBio').value = d.bio || '';
            if ($('tProfPhotoURL')) $('tProfPhotoURL').value = d.photoURL || '';

            if ($('trainerHeroName')) $('trainerHeroName').textContent = d.displayName || 'Trainer';
            if ($('trainerHeroEmail')) {
                $('trainerHeroEmail').textContent = d.email || (currentUser && currentUser.email) || '';
            }
            renderTrainerAvatar(
                d.displayName,
                d.email || (currentUser && currentUser.email) || '',
                d.photoURL
            );

            var status = d.approvalStatus || 'pending';
            var colors = { approved: 'success', pending: 'warning', rejected: 'danger' };
            if ($('trainerStatus')) {
                $('trainerStatus').innerHTML =
                    '<span class="badge bg-' + (colors[status] || 'secondary') + '">' +
                    status.charAt(0).toUpperCase() + status.slice(1) + '</span>';
            }
            if (currentUser) syncTrainerSidebarFooterName(currentUser);
            refreshTrainerGymPublicIdUi(
                d.gymPublicId && isValidGymPublicId(d.gymPublicId) ? d.gymPublicId : ''
            );
            var em = d.email || (currentUser && currentUser.email) || '';
            if (!(d.gymPublicId && isValidGymPublicId(d.gymPublicId)) && em) {
                runEnsureTrainerGymPublicId(em);
            }
        });
}

var trainerPhotoInput = $('tProfPhotoURL');
if (trainerPhotoInput) {
    trainerPhotoInput.addEventListener('input', function() {
        renderTrainerAvatar(
            ($('tProfName') && $('tProfName').value) || (trainerData && trainerData.displayName),
            (currentUser && currentUser.email) || '',
            trainerPhotoInput.value.trim()
        );
    });
}

var trainerForm = $('trainerProfileForm');
if (trainerForm) {
    trainerForm.addEventListener('submit', function(e) {
        e.preventDefault();
        if (!currentUid) return;
        var data = {
            displayName: $('tProfName').value.trim(),
            phone: $('tProfPhone').value.trim(),
            experience: parseInt($('tProfExp').value, 10) || 0,
            qualifications: $('tProfQual').value.trim(),
            bio: $('tProfBio').value.trim(),
            photoURL: ($('tProfPhotoURL') ? $('tProfPhotoURL').value.trim() : '')
        };

        db.collection('trainers').doc(currentUid).update(data)
            .then(function() {
                var a = $('trainerAlert');
                if (a) {
                    a.className = 'alert alert-success';
                    a.textContent = 'Profile updated!';
                    a.classList.remove('d-none');
                }
                loadTrainerProfile(currentUid);
            })
            .catch(function(err) {
                var a = $('trainerAlert');
                if (a) {
                    a.className = 'alert alert-danger';
                    a.textContent = err.message;
                    a.classList.remove('d-none');
                }
            });
    });
}

var btnGenerateTrainerIdCard = $('btnGenerateTrainerIdCard');
if (btnGenerateTrainerIdCard) {
    btnGenerateTrainerIdCard.addEventListener('click', function() {
        if (!currentUser) return;
        var d = trainerData || {};
        var nm =
            (d.displayName && String(d.displayName).trim()) ||
            (currentUser.displayName && String(currentUser.displayName).trim()) ||
            '';
        if (!nm && currentUser.email) nm = currentUser.email.split('@')[0];
        if (!nm) nm = 'Trainer';
        var pid =
            d.gymPublicId && isValidGymPublicId(d.gymPublicId) ? d.gymPublicId : '';
        openIDCardModal({
            name: nm,
            role: 'trainer',
            joinDate: d.createdAt || null,
            photoURL: (d.photoURL && String(d.photoURL).trim()) || (currentUser.photoURL || '') || '',
            firebaseUid: currentUser.uid,
            gymPublicId: pid,
            phone: (d.phone && String(d.phone).trim()) || '',
            specialization: (d.specialization && String(d.specialization).trim()) || '',
            gymLocation: 'RA1 2SU, 7 Krishal Road',
            gymWebsiteUrl: 'https://dadagym.netlify.app',
            gymWebsiteLabel: 'dadagym.netlify.app'
        });
    });
}

/* ═══════════════════════════════════════
   AVAILABILITY (weekly schedule editor)
   ═══════════════════════════════════════ */
var DAYS_OF_WEEK = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
var availabilityState = {};

function defaultAvailability() {
    var out = {};
    DAYS_OF_WEEK.forEach(function(day) {
        out[day] = { available: false, slots: [] };
    });
    return out;
}

function normalizeAvailability(raw) {
    var base = defaultAvailability();
    if (!raw || typeof raw !== 'object') return base;
    DAYS_OF_WEEK.forEach(function(day) {
        var src = raw[day];
        if (src == null) src = raw[day.toLowerCase()];
        if (src == null) return;

        if (typeof src === 'string') {
            base[day] = { available: true, slots: [{ start: src, end: '' }] };
            return;
        }
        if (typeof src !== 'object') return;

        var enabled = src.available !== false;
        var slots = [];
        var rawSlots = Array.isArray(src.slots) ? src.slots
            : Array.isArray(src.times) ? src.times
            : null;
        if (rawSlots) {
            rawSlots.forEach(function(s) {
                if (s == null) return;
                if (typeof s === 'string') {
                    slots.push({ start: s, end: '' });
                    return;
                }
                if (typeof s === 'object') {
                    var st = s.start != null ? s.start : s.from != null ? s.from : '';
                    var en = s.end != null ? s.end : s.to != null ? s.to : '';
                    slots.push({ start: String(st || ''), end: String(en || '') });
                }
            });
        }
        if (enabled && !slots.length) slots.push({ start: '09:00', end: '17:00' });
        base[day] = { available: enabled, slots: slots };
    });
    return base;
}

function showAvailAlert(msg, type) {
    var el = $('availAlert');
    if (!el) return;
    el.className = 'alert alert-' + type;
    el.textContent = msg;
    el.classList.remove('d-none');
    setTimeout(function() { el.classList.add('d-none'); }, 4000);
}

function buildSlotRow(day, idx, slot) {
    var row = document.createElement('div');
    row.className = 'avail-slot';
    row.dataset.day = day;
    row.dataset.idx = String(idx);
    row.innerHTML =
        '<input type="time" class="form-control form-control-sm avail-start" value="' + (slot.start || '') + '">' +
        '<span class="avail-to">to</span>' +
        '<input type="time" class="form-control form-control-sm avail-end" value="' + (slot.end || '') + '">' +
        '<button type="button" class="btn btn-sm btn-outline-danger avail-remove-slot" title="Remove">' +
            '<i class="fas fa-xmark"></i>' +
        '</button>';

    row.querySelector('.avail-start').addEventListener('input', function(e) {
        availabilityState[day].slots[idx].start = e.target.value;
    });
    row.querySelector('.avail-end').addEventListener('input', function(e) {
        availabilityState[day].slots[idx].end = e.target.value;
    });
    row.querySelector('.avail-remove-slot').addEventListener('click', function() {
        availabilityState[day].slots.splice(idx, 1);
        if (!availabilityState[day].slots.length) {
            availabilityState[day].slots.push({ start: '09:00', end: '17:00' });
        }
        renderAvailabilityGrid();
    });
    return row;
}

function buildDayRow(day) {
    var data = availabilityState[day];
    var row = document.createElement('div');
    row.className = 'avail-row';

    var toggleId = 'availToggle-' + day;
    var toggle = document.createElement('label');
    toggle.className = 'avail-day-toggle';
    toggle.htmlFor = toggleId;
    toggle.innerHTML =
        '<input type="checkbox" class="form-check-input" id="' + toggleId + '"' + (data.available ? ' checked' : '') + '>' +
        '<span class="avail-day-name">' + day + '</span>';
    toggle.querySelector('input').addEventListener('change', function(e) {
        availabilityState[day].available = e.target.checked;
        if (e.target.checked && !availabilityState[day].slots.length) {
            availabilityState[day].slots.push({ start: '09:00', end: '17:00' });
        }
        renderAvailabilityGrid();
    });

    var times = document.createElement('div');
    times.className = 'avail-times' + (data.available ? '' : ' disabled');

    if (!data.slots.length) {
        var hint = document.createElement('div');
        hint.className = 'text-muted small';
        hint.textContent = data.available ? 'Add a time slot below.' : 'Off — toggle to set hours.';
        times.appendChild(hint);
    } else {
        data.slots.forEach(function(slot, idx) {
            times.appendChild(buildSlotRow(day, idx, slot));
        });
    }

    var addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn btn-sm btn-outline-primary avail-add-slot mt-1';
    addBtn.title = 'Add time slot';
    addBtn.innerHTML = '<i class="fas fa-plus me-1"></i>Add slot';
    addBtn.addEventListener('click', function() {
        availabilityState[day].slots.push({ start: '09:00', end: '17:00' });
        if (!availabilityState[day].available) availabilityState[day].available = true;
        renderAvailabilityGrid();
    });
    times.appendChild(addBtn);

    row.appendChild(toggle);
    row.appendChild(times);
    return row;
}

function renderAvailabilityGrid() {
    var grid = $('availGrid');
    if (!grid) return;
    grid.innerHTML = '';
    DAYS_OF_WEEK.forEach(function(day) {
        grid.appendChild(buildDayRow(day));
    });
}

function loadAvailability() {
    var grid = $('availGrid');
    if (!grid) return;
    grid.innerHTML = '<div class="text-center text-muted py-4"><i class="fas fa-spinner fa-spin me-2"></i>Loading availability…</div>';

    var promise = currentUid
        ? db.collection('trainers').doc(currentUid).get()
        : Promise.resolve(null);

    promise.then(function(doc) {
        var raw = (doc && doc.exists) ? (doc.data().availability || doc.data().weeklyAvailability) : null;
        availabilityState = normalizeAvailability(raw);
        renderAvailabilityGrid();
    }).catch(function() {
        availabilityState = defaultAvailability();
        renderAvailabilityGrid();
        showAvailAlert('Could not load saved availability — starting fresh.', 'warning');
    });
}

function saveAvailability() {
    if (!currentUid) return;
    var payload = {};
    var hasInvalid = false;

    DAYS_OF_WEEK.forEach(function(day) {
        var d = availabilityState[day];
        var enabled = !!d.available;
        var cleanSlots = [];
        if (enabled) {
            d.slots.forEach(function(s) {
                var st = (s.start || '').trim();
                var en = (s.end || '').trim();
                if (!st && !en) return;
                if (st && en && st >= en) hasInvalid = true;
                cleanSlots.push({ start: st, end: en });
            });
        }
        payload[day] = { available: enabled && cleanSlots.length > 0, slots: cleanSlots };
    });

    if (hasInvalid) {
        showAvailAlert('Each slot needs a start time earlier than its end time.', 'danger');
        return;
    }

    var btn = $('btnSaveAvail');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin me-2"></i>Saving…'; }

    db.collection('trainers').doc(currentUid).set({ availability: payload }, { merge: true })
        .then(function() {
            showAvailAlert('Availability saved!', 'success');
            availabilityState = normalizeAvailability(payload);
            renderAvailabilityGrid();
        })
        .catch(function(err) {
            showAvailAlert(err.message || 'Failed to save availability.', 'danger');
        })
        .then(function() {
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-save me-2"></i>Save Availability'; }
        });
}

if ($('btnSaveAvail')) {
    $('btnSaveAvail').addEventListener('click', saveAvailability);
}
if ($('btnRefreshAvail')) {
    $('btnRefreshAvail').addEventListener('click', loadAvailability);
}

/* ─── My classes (assigned by admin + requests for open slots) ─── */
function pad2(n) {
    return (n < 10 ? '0' : '') + n;
}

function formatYYYYMMDDLocal(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function parseISODateLocal(iso) {
    var p = String(iso || '').split('-');
    if (p.length !== 3) return null;
    var y = parseInt(p[0], 10);
    var m = parseInt(p[1], 10) - 1;
    var day = parseInt(p[2], 10);
    if (isNaN(y) || isNaN(m) || isNaN(day)) return null;
    return new Date(y, m, day);
}

/** Map class schedule.day to JS weekday (0–6, Sun–Sat). */
function scheduleDayToJsWeekdayTrainer(dayStr) {
    if (dayStr == null || dayStr === '') return null;
    var k = String(dayStr).trim().toLowerCase().replace(/\./g, '');
    var map = {
        sun: 0, sunday: 0,
        mon: 1, monday: 1,
        tue: 2, tues: 2, tuesday: 2,
        wed: 3, weds: 3, wednesday: 3,
        thu: 4, thur: 4, thurs: 4, thursday: 4,
        fri: 5, friday: 5,
        sat: 6, saturday: 6
    };
    if (map[k] !== undefined) return map[k];
    var short = k.slice(0, 3);
    if (map[short] !== undefined) return map[short];
    return null;
}

function trainerStartOfWeekMonday(d) {
    var x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    var day = x.getDay();
    var diff = day === 0 ? -6 : 1 - day;
    x.setDate(x.getDate() + diff);
    return x;
}

function trainerEndOfWeekSunday(monday) {
    var d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate());
    d.setDate(d.getDate() + 6);
    return d;
}

function sessionDateForClassInWeek(weekMonday, scheduleDayRaw) {
    var wd = scheduleDayToJsWeekdayTrainer(scheduleDayRaw);
    if (wd === null) return null;
    var i;
    for (i = 0; i < 7; i++) {
        var d = new Date(weekMonday.getFullYear(), weekMonday.getMonth(), weekMonday.getDate());
        d.setDate(d.getDate() + i);
        if (d.getDay() === wd) return formatYYYYMMDDLocal(d);
    }
    return null;
}

function trainerClassCompletionDocId(classId, sessionDate) {
    return classId + '_' + sessionDate;
}

function formatWeekDayDateLabel(sessionDateIso) {
    var d = parseISODateLocal(sessionDateIso);
    return d ? d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : sessionDateIso;
}

function trainerEffectiveSessionStatus(comp) {
    if (!comp) return 'pending';
    var st = String(comp.sessionStatus || '').trim().toLowerCase();
    if (st === 'completed' || st === 'cancelled' || st === 'delayed' || st === 'missed') return st;
    if (comp.completedAt) return 'completed';
    return 'pending';
}

function trainerSessionStatusBadgeHtml(st) {
    switch (st) {
        case 'completed':
            return '<span class="badge bg-success">Completed</span>';
        case 'missed':
            return '<span class="badge bg-danger">Missed</span>';
        case 'cancelled':
            return '<span class="badge bg-secondary">Cancel</span>';
        case 'delayed':
            return '<span class="badge bg-warning text-dark">Delay</span>';
        default:
            return '<span class="badge bg-secondary text-dark">Pending</span>';
    }
}

function formatCompletedSessionTime(ts) {
    var sec = 0;
    if (!ts) return '—';
    if (typeof ts.seconds === 'number') sec = ts.seconds;
    else if (typeof ts.toMillis === 'function') sec = Math.floor(ts.toMillis() / 1000);
    if (!sec) return '—';
    var d = new Date(sec * 1000);
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

function trainerClassRequestDocId(classId) {
    return classId + '_' + currentUid;
}

function formatClassScheduleTrainer(c) {
    var s = c.schedule || {};
    var day = s.day || '—';
    var time = s.time || '—';
    var dur = s.duration ? s.duration + ' min' : '';
    var parts = [day, time];
    if (dur) parts.push(dur);
    return parts.join(' · ');
}

/** Defaults for "request to teach" modal from class.schedule. */
function defaultRequestTimeDurationFromClass(c) {
    var s = (c && c.schedule) || {};
    var timeStr = '';
    if (s.time != null) {
        if (typeof s.time === 'string') timeStr = s.time.trim();
        else if (typeof s.time === 'number') timeStr = String(s.time);
        else timeStr = '';
    }
    var dur = 60;
    if (s.duration != null && !isNaN(Number(s.duration))) {
        dur = Number(s.duration);
    }
    if (dur < 15) dur = 60;
    if (dur > 300) dur = 300;
    return { time: timeStr, duration: dur };
}

function escAttr(s) {
    if (s == null || s === '') return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;');
}

function showClassAssignAlert(msg, type) {
    var el = $('classAssignAlert');
    if (!el) return;
    el.className = 'alert alert-' + type;
    el.textContent = msg;
    el.classList.remove('d-none');
    setTimeout(function() { el.classList.add('d-none'); }, 5000);
}

function loadTrainerWeeklyCompletionCountStat(mon0, sun0) {
    var mon = mon0 || trainerStartOfWeekMonday(new Date());
    var sun = sun0 || trainerEndOfWeekSunday(mon);
    if (!currentUid) return Promise.resolve();

    return db.collection('classes')
        .get()
        .then(function(snapClasses) {
            var slots = [];
            snapClasses.forEach(function(doc) {
                var c = doc.data();
                if ((c.status || 'active') !== 'active') return;
                if ((c.trainerId || '').trim() !== currentUid) return;
                var sessionDate = sessionDateForClassInWeek(mon, (c.schedule || {}).day);
                if (!sessionDate) return;
                slots.push(trainerClassCompletionDocId(doc.id, sessionDate));
            });
            if (!slots.length) {
                var emptyEl = $('statCompleted');
                if (emptyEl) emptyEl.textContent = '0';
                return;
            }
            return Promise.all(
                slots.map(function(cid) {
                    return db.collection('trainerClassCompletions').doc(cid).get();
                })
            ).then(function(docSnaps) {
                var n = 0;
                docSnaps.forEach(function(d) {
                    if (!d.exists) return;
                    if (trainerEffectiveSessionStatus(d.data()) === 'completed') n++;
                });
                var el = $('statCompleted');
                if (el) el.textContent = String(n);
            });
        })
        .catch(function() {
            var el = $('statCompleted');
            if (el) el.textContent = '0';
        });
}

function renderTrainerBookingTableRows(tbody, rows, layout, emptyMsg) {
    tbody.innerHTML = '';
    var cols = layout === 'schedule' ? 6 : 5;

    function emptyHtml(msg) {


        tbody.innerHTML =


            '<tr><td colspan="' + cols + '" class="text-center text-muted py-3">' +


                escHtml(msg || 'No rows.') + '</td></tr>';


    }

    if (!rows.length) {
        emptyHtml(emptyMsg);
        return;
    }

    rows.forEach(function(r) {

        var tr = document.createElement('tr');


        function td(txt) {


            var c = document.createElement('td');

            c.textContent = txt;

            return c;

        }


        var mem = parseISODateLocal(r.date);

        var dateLabel = mem
            ? mem.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })

            : (r.date || '—');


        var status = r.status || 'confirmed';

        if (layout === 'schedule') {


            tr.appendChild(td(dateLabel));


            tr.appendChild(td(r.time || '—'));


            tr.appendChild(td(r.cls || '—'));


            tr.appendChild(td(r.member || '—'));


            tr.appendChild(td(status));


            var act = document.createElement('td');

            act.className = 'text-muted small';


            act.textContent = '—';


            tr.appendChild(act);


        } else {


            tr.appendChild(td(r.member || '—'));

            tr.appendChild(td(r.cls || '—'));

            tr.appendChild(td(dateLabel));


            tr.appendChild(td(r.time || '—'));


            tr.appendChild(td(status));


        }

        tbody.appendChild(tr);


    });


}

function loadTrainerOverviewStats() {
    if (!currentUid) return Promise.resolve();

    db.collection('classes')
        .where('trainerId', '==', currentUid)
        .get()
        .then(function(snap) {
            if ($('statClasses')) $('statClasses').textContent = snap.size;
        })
        .catch(function() {
            if ($('statClasses')) $('statClasses').textContent = '0';
        });

    db.collection('bookings')
        .where('trainerId', '==', currentUid)
        .get()
        .then(function(snap) {
            var members = {};
            var today = formatYYYYMMDDLocal(new Date());
            var upcoming = 0;
            var rows = [];

            snap.forEach(function(doc) {
                var b = doc.data();
                var st = (b.status || '').trim();
                if (st === 'cancelled') return;
                if (b.memberId) members[b.memberId] = true;
                rows.push({
                    member: (b.memberName || b.memberEmail || '').trim(),
                    cls: (b.className || '').trim(),
                    date: b.date || '',
                    time: b.time || '',
                    status: st || 'confirmed'
                });
                if (b.date && String(b.date) >= today) upcoming++;
            });

            if ($('statMembers')) $('statMembers').textContent = String(Object.keys(members).length);
            if ($('statUpcoming')) $('statUpcoming').textContent = String(upcoming);

            rows.sort(function(a, b) {
                var ad = String(a.date);
                var bd = String(b.date);
                if (ad !== bd) return ad < bd ? -1 : ad > bd ? 1 : 0;
                return String(a.time || '').localeCompare(String(b.time || ''));
            });

            var ob = $('overviewScheduleBody');
            var upcomingSlice = rows.filter(function(r) {
                return r.date && String(r.date) >= today;
            }).slice(0, 25);
            if (ob) {
                renderTrainerBookingTableRows(ob, upcomingSlice, 'overview', 'No upcoming bookings.');
            }

            var sb = $('scheduleBody');
            if (sb) {
                renderTrainerBookingTableRows(sb, rows, 'schedule', 'No bookings for your classes yet.');
            }
        })
        .catch(function() {
            if ($('statMembers')) $('statMembers').textContent = '0';
            if ($('statUpcoming')) $('statUpcoming').textContent = '0';
            var ob = $('overviewScheduleBody');
            var sb = $('scheduleBody');
            if (ob) ob.innerHTML = '<tr><td colspan="5" class="text-center text-danger small py-3">Could not load bookings.</td></tr>';
            if (sb) sb.innerHTML = '<tr><td colspan="6" class="text-center text-danger small py-3">Could not load bookings.</td></tr>';
        });

    return loadTrainerWeeklyCompletionCountStat();
}

function loadTrainerWeekSessions() {
    var tbody = $('trainerWeekSessionsBody');
    var lbl = $('trainerWeekRangeLabel');
    if (!tbody || !currentUid) return;

    var base = new Date();
    var mon = trainerStartOfWeekMonday(base);
    mon.setDate(mon.getDate() + trainerClassTrackWeekOffset * 7);
    var sun = trainerEndOfWeekSunday(mon);
    var w0 = formatYYYYMMDDLocal(mon);
    var w1 = formatYYYYMMDDLocal(sun);

    if (lbl) {
        lbl.textContent =
            mon.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
            ' – ' +
            sun.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    }

    tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted py-3">Loading…</td></tr>';

    db.collection('classes')
        .get()
        .then(function(snapClasses) {
            var assigned = [];
            snapClasses.forEach(function(doc) {
                var c = doc.data();
                if ((c.status || 'active') !== 'active') return;
                if ((c.trainerId || '').trim() !== currentUid) return;
                var dayRaw = (c.schedule || {}).day;
                var sessionDate = sessionDateForClassInWeek(mon, dayRaw);
                if (!sessionDate) return;
                if (sessionDate < w0 || sessionDate > w1) return;
                assigned.push({
                    classId: doc.id,
                    sessionDate: sessionDate,
                    className: c.name || '',
                    scheduleDay: dayRaw || '',
                    time: (c.schedule || {}).time || '',
                    completion: null
                });
            });

            assigned.sort(function(a, b) {
                if (a.sessionDate !== b.sessionDate) return a.sessionDate < b.sessionDate ? -1 : 1;
                return String(a.time || '').localeCompare(String(b.time || ''));
            });

            tbody.innerHTML = '';
            if (!assigned.length) {
                tbody.innerHTML =
                    '<tr><td colspan="7" class="text-muted text-center py-4">No recurring sessions this week — check classes have a weekday in admin, or browse another week.</td></tr>';
                return Promise.resolve();
            }

            return Promise.all(
                assigned.map(function(row) {
                    return db.collection('trainerClassCompletions')
                        .doc(trainerClassCompletionDocId(row.classId, row.sessionDate))
                        .get();
                })
            ).then(function(docSnaps) {
                docSnaps.forEach(function(docSnap, i) {
                    if (docSnap.exists) assigned[i].completion = docSnap.data();
                });

                assigned.forEach(function(row) {
                var eff = trainerEffectiveSessionStatus(row.completion);
                var tr = document.createElement('tr');
                var tdD = document.createElement('td');
                tdD.textContent = formatWeekDayDateLabel(row.sessionDate);
                var tdT = document.createElement('td');
                tdT.textContent = row.time || '—';
                var tdN = document.createElement('td');
                tdN.textContent = row.className || '—';
                var tdS = document.createElement('td');
                tdS.innerHTML = trainerSessionStatusBadgeHtml(eff);

                var tdCt = document.createElement('td');
                tdCt.className = 'small text-muted font-monospace';
                if (eff === 'completed' && row.completion && row.completion.completedAt) {
                    tdCt.textContent = formatCompletedSessionTime(row.completion.completedAt);
                } else {
                    tdCt.textContent = '—';
                }

                var tdNotes = document.createElement('td');
                tdNotes.className = 'small';
                var noteTxt = (row.completion && row.completion.notes) ? String(row.completion.notes).trim() : '';
                if (noteTxt.length > 80) {
                    tdNotes.textContent = noteTxt.slice(0, 77) + '…';
                    tdNotes.title = noteTxt;
                } else {
                    tdNotes.textContent = noteTxt || '—';
                    if (noteTxt) tdNotes.title = noteTxt;
                }

                var tdA = document.createElement('td');
                var b = document.createElement('button');
                b.type = 'button';
                b.className = 'btn btn-sm btn-outline-info trainer-session-log-btn';
                b.setAttribute('data-class-id', row.classId);
                b.setAttribute('data-session-date', row.sessionDate);
                b.setAttribute('data-class-name', row.className || '');
                b.setAttribute('data-day', row.scheduleDay);
                b.setAttribute('data-time', row.time || '');
                b.innerHTML = eff === 'pending' ? '<i class="fas fa-edit me-1"></i>Log' : '<i class="fas fa-edit me-1"></i>Edit';
                tdA.appendChild(b);

                tr.appendChild(tdD);
                tr.appendChild(tdT);
                tr.appendChild(tdN);
                tr.appendChild(tdS);
                tr.appendChild(tdCt);
                tr.appendChild(tdNotes);
                tr.appendChild(tdA);
                tbody.appendChild(tr);
            });
            });
        })
        .catch(function(err) {
            console.error(err);
            tbody.innerHTML =
                '<tr><td colspan="7" class="text-danger text-center py-3">Could not load sessions (network or Firestore rules).</td></tr>';
        });
}

function getTrainerResolvedName() {
    var tname = '';
    if (trainerData && trainerData.displayName) tname = String(trainerData.displayName).trim();
    if (!tname && currentUser && currentUser.email) tname = currentUser.email;
    if (!tname) tname = 'Trainer';
    return tname;
}

function trainerValidateWeekSessionClass(classId, sessionDate) {
    return db.collection('classes').doc(classId).get().then(function(cdoc) {
        if (!cdoc.exists) throw new Error('Class not found.');
        var c = cdoc.data();
        var tid = (c.trainerId || '').trim();
        if (tid !== currentUid) throw new Error('You are no longer assigned to this class.');
        var monSel = trainerStartOfWeekMonday(new Date());
        monSel.setDate(monSel.getDate() + trainerClassTrackWeekOffset * 7);
        var expect = sessionDateForClassInWeek(monSel, (c.schedule || {}).day);
        if (!expect || expect !== sessionDate) {
            throw new Error('Session does not match this class weekday for the week you\'re viewing.');
        }
        return c;
    });
}

/** Persists trainer session status + optional notes for the weekly template row (admin visibility). */
function saveTrainerSessionLog(classId, sessionDate, className, scheduleDay, timeSlot, sessionStatus, notesRaw) {
    if (!currentUid || !classId || !sessionDate) {
        return Promise.reject(new Error('Missing session.'));
    }
    if (!sessionStatus) {
        return Promise.reject(new Error('Choose a status.'));
    }
    var notes = (notesRaw || '').trim();
    var Fdel = firebase.firestore.FieldValue;

    return trainerValidateWeekSessionClass(classId, sessionDate).then(function(c) {
        var payload = {
            classId: classId,
            sessionDate: sessionDate,
            className: className || c.name || '',
            scheduleDay: scheduleDay || (c.schedule || {}).day || '',
            time: timeSlot || (c.schedule || {}).time || '',
            trainerId: currentUid,
            trainerName: getTrainerResolvedName(),
            sessionStatus: sessionStatus,
            updatedAt: Fdel.serverTimestamp()
        };
        if (notes) {
            payload.notes = notes;
        } else {
            payload.notes = Fdel.delete();
        }
        if (sessionStatus === 'completed') {
            payload.completedAt = Fdel.serverTimestamp();
        } else {
            payload.completedAt = Fdel.delete();
        }
        return db.collection('trainerClassCompletions').doc(trainerClassCompletionDocId(classId, sessionDate)).set(payload, { merge: true });
    }).then(function() {
        showClassAssignAlert('Session log saved for admin.', 'success');
        loadTrainerWeekSessions();
        loadTrainerOverviewStats();
    });
}

function unmarkTrainerWeekSession(classId, sessionDate) {
    var ref = db.collection('trainerClassCompletions').doc(trainerClassCompletionDocId(classId, sessionDate));

    return ref.get()
        .then(function(doc) {
            if (!doc.exists) return false;
            var d = doc.data();
            if ((d.trainerId || '').trim() !== currentUid) {
                showClassAssignAlert('You can only clear your own entries.', 'warning');
                return false;
            }
            return ref.delete().then(function() {
                return true;
            });
        })
        .then(function(ok) {
            if (!ok) return false;
            showClassAssignAlert('Session log cleared.', 'secondary');
            loadTrainerWeekSessions();
            loadTrainerOverviewStats();
            return true;
        })
        .catch(function(err) {
            showClassAssignAlert(err.message || 'Could not remove.', 'danger');
            return false;
        });
}

function getTrainerSessionLogModal() {
    if (trainerSessionLogModalInst) return trainerSessionLogModalInst;
    var el = $('trainerSessionLogModal');
    if (!el || typeof bootstrap === 'undefined') return null;
    trainerSessionLogModalInst = new bootstrap.Modal(el);
    return trainerSessionLogModalInst;
}

function openTrainerSessionLogModalFromRow(row) {
    trainerSessionLogContext = row;
    var sub = $('trainerSessionLogModalSubtitle');
    var stSel = $('trainerSessionLogStatus');
    var notesEl = $('trainerSessionLogNotes');
    if (!sub || !stSel || !notesEl) return;

    sub.textContent =
        (row.className || 'Class') +
        ' · ' +
        formatWeekDayDateLabel(row.sessionDate) +
        (row.time ? ' · ' + row.time : '');

    var eff = trainerEffectiveSessionStatus(row.completion);
    stSel.value = eff === 'pending' ? 'completed' : eff;

    notesEl.value = row.completion && row.completion.notes ? String(row.completion.notes) : '';

    var m = getTrainerSessionLogModal();
    if (m) m.show();
}

function bindTrainerSessionLogModal() {
    var btnSave = $('trainerSessionLogSave');
    var btnClear = $('trainerSessionLogClear');
    if (btnSave) {
        btnSave.addEventListener('click', function() {
            var ctx = trainerSessionLogContext;
            if (!ctx) return;
            var stEl = $('trainerSessionLogStatus');
            var notesEl = $('trainerSessionLogNotes');
            var st = (stEl && stEl.value) || 'completed';
            var notes = notesEl ? notesEl.value : '';
            saveTrainerSessionLog(
                ctx.classId,
                ctx.sessionDate,
                ctx.className,
                ctx.scheduleDay,
                ctx.time,
                st,
                notes
            )
                .then(function() {
                    var modal = getTrainerSessionLogModal();
                    if (modal) modal.hide();
                })
                .catch(function(err) {
                    showClassAssignAlert(err.message || 'Could not save.', 'danger');
                });
        });
    }
    if (btnClear) {
        btnClear.addEventListener('click', function() {
            var ctx = trainerSessionLogContext;
            if (!ctx || !ctx.completion) {
                var m0 = getTrainerSessionLogModal();
                if (m0) m0.hide();
                return;
            }
            if (!confirm('Remove this session log? The admin will see this slot as Pending.')) return;
            unmarkTrainerWeekSession(ctx.classId, ctx.sessionDate).then(function(ok) {
                if (!ok) return;
                var modal = getTrainerSessionLogModal();
                if (modal) modal.hide();
            });
        });
    }
}

function loadTrainerClassRequestsMap() {
    return db.collection('trainerClassRequests').where('trainerId', '==', currentUid).get()
        .then(function(snap) {
            trainerClassRequestByClassId = {};
            snap.forEach(function(doc) {
                var d = doc.data();
                if (d.classId) {
                    trainerClassRequestByClassId[d.classId] = {
                        id: doc.id,
                        status: d.status || 'pending',
                        proposedTime: d.proposedTime != null ? String(d.proposedTime).trim() : '',
                        pendingProposedDuration:
                            d.proposedDurationMinutes != null && !isNaN(Number(d.proposedDurationMinutes))
                                ? Number(d.proposedDurationMinutes)
                                : null
                    };
                }
            });
        });
}

function trainerTimestampSeconds(ts) {
    if (!ts) return 0;
    if (typeof ts.seconds === 'number') return ts.seconds;
    if (typeof ts.toMillis === 'function') return Math.floor(ts.toMillis() / 1000);
    return 0;
}

function formatTrainerReqDate(ts) {
    var sec = trainerTimestampSeconds(ts);
    if (!sec) return '—';
    return new Date(sec * 1000).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

function formatTrainerPersonalSessionWhen(d) {
    var date = (d.preferredDate != null ? String(d.preferredDate) : '').trim();
    var time = (d.preferredTime != null ? String(d.preferredTime) : '').trim();
    var dur =
        d.preferredDurationMinutes != null && !isNaN(Number(d.preferredDurationMinutes))
            ? Number(d.preferredDurationMinutes)
            : null;
    var when = '';
    if (!date && !time) when = '—';
    else if (!time) when = date;
    else if (!date) when = time;
    else when = date + ' · ' + time;
    if (dur != null && dur > 0) {
        if (when === '—') when = dur + ' min';
        else when += ' · ' + dur + ' min';
    }
    return when;
}

function resolveTrainerPersonalSession(docId, accept) {
    if (!docId) return;
    if (!accept) {
        if (!confirm('Decline this session request?')) return;
        db.collection('trainerSessionRequests')
            .doc(docId)
            .update({
                status: 'declined',
                trainerResolvedAt: firebase.firestore.FieldValue.serverTimestamp(),
                trainerResolvedBy: currentUid
            })
            .then(function() {
                showClassAssignAlert('Marked declined.', 'secondary');
                loadTrainerPersonalSessionRequests();
            })
            .catch(function(err) {
                showClassAssignAlert(err.message || 'Could not update request.', 'danger');
            });
        return;
    }

    if (
        !confirm(
            'Accept this 1:1 session? It will be added to the member\'s My Bookings with a reference number for check-in.'
        )
    ) {
        return;
    }

    db.collection('trainerSessionRequests')
        .doc(docId)
        .get()
        .then(function(reqSnap) {
            if (!reqSnap.exists) throw new Error('Request not found.');
            var req = reqSnap.data();
            if ((req.status || 'pending') !== 'pending') {
                throw new Error('This request was already resolved.');
            }
            var memberId = req.memberId;
            var date = req.preferredDate;
            var timeRaw = req.preferredTime;
            if (!memberId || !date || !timeRaw) throw new Error('Request is missing date or time.');

            var slotId = personalSessionSlotKey(memberId, date, timeRaw);
            var trainerName = (trainerData && trainerData.displayName) ? trainerData.displayName.trim() : '';
            if (!trainerName && currentUser && currentUser.email) trainerName = currentUser.email;
            if (!trainerName) trainerName = 'Trainer';

            var durationMin = req.preferredDurationMinutes;
            if (durationMin != null && typeof durationMin !== 'number') {
                durationMin = parseInt(durationMin, 10);
            }
            if (durationMin != null && isNaN(durationMin)) durationMin = null;

            function commitWithCode(code) {
                var batch = db.batch();
                var reqRef = db.collection('trainerSessionRequests').doc(docId);
                var bookRef = db.collection('bookings').doc(slotId);
                var lookupRef = db.collection('bookingLookups').doc(String(code));

                batch.update(reqRef, {
                    status: 'accepted',
                    trainerResolvedAt: firebase.firestore.FieldValue.serverTimestamp(),
                    trainerResolvedBy: currentUid,
                    bookingId: slotId,
                    bookingCode: code,
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                });

                var bookPayload = {
                    memberId: memberId,
                    memberName: req.memberName || '',
                    memberEmail: req.memberEmail || '',
                    trainerId: currentUid,
                    trainerName: trainerName,
                    classId: PERSONAL_1TO1_CLASS_ID,
                    className: '1:1 Personal session',
                    scheduleDay: '',
                    date: date,
                    time: timeRaw,
                    slotKey: slotId,
                    bookingCode: code,
                    status: 'confirmed',
                    guestTrialBooking: false,
                    personalSession: true,
                    personalSessionRequestId: docId,
                    createdAt: firebase.firestore.FieldValue.serverTimestamp()
                };
                if (durationMin != null) bookPayload.durationMinutes = durationMin;

                batch.set(bookRef, bookPayload);
                batch.set(lookupRef, {
                    bookingId: slotId,
                    memberId: memberId,
                    trainerId: currentUid,
                    trainerName: trainerName,
                    className: '1:1 Personal session',
                    date: date,
                    time: timeRaw
                });

                return batch.commit();
            }

            var code1 = randomFiveDigitBookingCode();
            return commitWithCode(code1).catch(function(err) {
                if (err && err.code === 'already-exists') {
                    return commitWithCode(randomFiveDigitBookingCode());
                }
                throw err;
            });
        })
        .then(function() {
            showClassAssignAlert('Session accepted — the member will see it under My Bookings.', 'success');
            loadTrainerPersonalSessionRequests();
        })
        .catch(function(err) {
            console.error(err);
            showClassAssignAlert(err.message || 'Could not accept session.', 'danger');
        });
}

function loadTrainerPersonalSessionRequests() {
    var tbody = $('trainerPersonalSessionBody');
    if (!tbody) return;
    tbody.innerHTML =
        '<tr><td colspan="5" class="text-center text-muted py-3">Loading…</td></tr>';

    db.collection('trainerSessionRequests')
        .where('trainerId', '==', currentUid)
        .get()
        .then(function(snap) {
            var rows = [];
            snap.forEach(function(doc) {
                var d = doc.data();
                if ((d.status || 'pending') !== 'pending') return;
                rows.push({ id: doc.id, d: d });
            });
            rows.sort(function(a, b) {
                return trainerTimestampSeconds(b.d.createdAt) - trainerTimestampSeconds(a.d.createdAt);
            });

            tbody.innerHTML = '';
            if (!rows.length) {
                tbody.innerHTML =
                    '<tr><td colspan="5" class="text-center text-muted py-4">No pending personal session requests.</td></tr>';
                return;
            }

            rows.forEach(function(row) {
                var d = row.d;
                var tr = document.createElement('tr');

                var tdM = document.createElement('td');
                tdM.textContent = d.memberName || d.memberEmail || '—';

                var tdW = document.createElement('td');
                tdW.className = 'small text-nowrap';
                tdW.textContent = formatTrainerPersonalSessionWhen(d);

                var tdR = document.createElement('td');
                tdR.className = 'small';
                var reason = (d.reason != null ? String(d.reason).trim() : '') || '';
                if (reason.length > 72) {
                    tdR.textContent = reason.slice(0, 69) + '…';
                    tdR.title = reason;
                } else {
                    tdR.textContent = reason || '—';
                    if (reason) tdR.title = reason;
                }

                var tdT = document.createElement('td');
                tdT.className = 'small text-muted';
                tdT.textContent = formatTrainerReqDate(d.createdAt);

                var tdA = document.createElement('td');
                var y = document.createElement('button');
                y.type = 'button';
                y.className = 'btn btn-sm btn-success me-1';
                y.title = 'Accept';
                y.innerHTML = '<i class="fas fa-check"></i>';
                (function(pid) {
                    y.addEventListener('click', function() {
                        resolveTrainerPersonalSession(pid, true);
                    });
                })(row.id);

                var n = document.createElement('button');
                n.type = 'button';
                n.className = 'btn btn-sm btn-outline-danger';
                n.title = 'Decline';
                n.innerHTML = '<i class="fas fa-times"></i>';
                (function(pid2) {
                    n.addEventListener('click', function() {
                        resolveTrainerPersonalSession(pid2, false);
                    });
                })(row.id);

                tdA.appendChild(y);
                tdA.appendChild(n);

                tr.appendChild(tdM);
                tr.appendChild(tdW);
                tr.appendChild(tdR);
                tr.appendChild(tdT);
                tr.appendChild(tdA);
                tbody.appendChild(tr);
            });
        })
        .catch(function(err) {
            console.error(err);
            tbody.innerHTML =
                '<tr><td colspan="5" class="text-center text-danger py-3">Could not load personal session requests.</td></tr>';
        });
}

function renderTrainerClassCard(item, isAssigned) {
    var c = item.data;
    var name = c.name || 'Untitled';
    var type = c.type || '—';
    var sched = formatClassScheduleTrainer(c);
    var desc = (c.description || '').trim();
    if (desc.length > 140) desc = desc.substring(0, 140) + '…';

    var col = document.createElement('div');
    col.className = 'col-md-6 col-lg-4';

    var inner = document.createElement('div');
    inner.className = 'dash-card h-100';

    var body = document.createElement('div');
    body.className = 'card-body';

    body.innerHTML =
        '<div class="d-flex justify-content-between align-items-start mb-2">' +
            '<h6 class="text-white fw-bold mb-0">' + escHtml(name) + '</h6>' +
            '<span class="badge bg-info">' + escHtml(type) + '</span>' +
        '</div>' +
        (desc ? '<p class="text-muted small mb-2">' + escHtml(desc) + '</p>' : '<p class="text-muted small mb-2">No description</p>') +
        '<div class="small text-muted mb-2"><i class="fas fa-calendar me-1"></i>' + escHtml(sched) + '</div>' +
        '<div class="small text-muted mb-0"><i class="fas fa-users me-1"></i>' +
            (c.enrolled || 0) + ' / ' + (c.capacity || 0) + ' enrolled</div>';

    if (isAssigned) {
        var badgeRow = document.createElement('div');
        badgeRow.className = 'mt-3';
        badgeRow.innerHTML = '<span class="badge bg-success"><i class="fas fa-check me-1"></i>Assigned to you</span>';
        body.appendChild(badgeRow);
    } else {
        var req = trainerClassRequestByClassId[item.id];
        var st = req ? req.status : null;
        var defTd = defaultRequestTimeDurationFromClass(c);
        var actions = document.createElement('div');
        actions.className = 'mt-3';

        var reqBtnAttrs =
            ' data-class-id="' + escAttr(item.id) + '"' +
            ' data-class-name="' + escAttr(name) + '"' +
            ' data-default-time="' + escAttr(defTd.time) + '"' +
            ' data-default-duration="' + escAttr(String(defTd.duration)) + '"';

        if (st === 'pending') {
            var extra = '';
            if (req && (req.proposedTime || req.pendingProposedDuration != null)) {
                extra = '<div class="small text-white-50 mt-1">';
                if (req.proposedTime) {
                    extra += escHtml(req.proposedTime);
                }
                if (req.pendingProposedDuration != null) {
                    extra +=
                        (req.proposedTime ? ' · ' : '') +
                        escHtml(String(req.pendingProposedDuration)) +
                        ' min';
                }
                extra += '</div>';
            }
            actions.innerHTML =
                '<span class="badge bg-warning text-dark"><i class="fas fa-clock me-1"></i>Request pending admin review</span>' +
                extra;
        } else if (st === 'rejected') {
            actions.innerHTML =
                '<span class="badge bg-secondary me-2 mb-2">Not approved</span>' +
                '<button type="button" class="btn btn-sm btn-outline-primary request-class-btn"' +
                reqBtnAttrs +
                '><i class="fas fa-redo me-1"></i>Request again</button>';
        } else if (st === 'approved') {
            actions.innerHTML =
                '<span class="badge bg-success">Approved — reload if this still shows here.</span>';
        } else {
            actions.innerHTML =
                '<button type="button" class="btn btn-sm btn-primary request-class-btn"' +
                reqBtnAttrs +
                '><i class="fas fa-paper-plane me-1"></i>Request to teach</button>';
        }
        body.appendChild(actions);
    }

    inner.appendChild(body);
    col.appendChild(inner);
    return col;
}

function loadTrainerClasses() {
    var assignedGrid = $('trainerAssignedClassesGrid');
    var openGrid = $('trainerOpenClassesGrid');
    if (!assignedGrid || !openGrid) return;
    assignedGrid.innerHTML = '<div class="col-12 text-center text-muted py-4">Loading…</div>';
    openGrid.innerHTML = '<div class="col-12 text-center text-muted py-4">Loading…</div>';

    db.collection('classes').get()
        .then(function(snap) {
            return loadTrainerClassRequestsMap()
                .catch(function(err) {
                    console.warn('trainerClassRequests:', err);
                    trainerClassRequestByClassId = {};
                })
                .then(function() { return snap; });
        })
        .then(function(snap) {
        var assigned = [];
        var openList = [];

        snap.forEach(function(doc) {
            var c = doc.data();
            var st = c.status || 'active';
            if (st !== 'active') return;

            var tid = (c.trainerId || '').trim();
            if (tid === currentUid) {
                assigned.push({ id: doc.id, data: c });
            } else if (!tid) {
                openList.push({ id: doc.id, data: c });
            }
        });

        assigned.sort(function(a, b) {
            return (a.data.name || '').localeCompare(b.data.name || '');
        });
        openList.sort(function(a, b) {
            return (a.data.name || '').localeCompare(b.data.name || '');
        });

        assignedGrid.innerHTML = '';
        if (!assigned.length) {
            assignedGrid.innerHTML =
                '<div class="col-12 text-center text-muted py-4">No classes assigned to you yet. When admin assigns you as the trainer, they appear here. You can also request open classes below.</div>';
        } else {
            assigned.forEach(function(item) {
                assignedGrid.appendChild(renderTrainerClassCard(item, true));
            });
        }

        openGrid.innerHTML = '';
        if (!openList.length) {
            openGrid.innerHTML =
                '<div class="col-12 text-center text-muted py-4">There are no open classes without a trainer right now.</div>';
        } else {
            openList.forEach(function(item) {
                openGrid.appendChild(renderTrainerClassCard(item, false));
            });
        }

        loadTrainerPersonalSessionRequests();
        loadTrainerWeekSessions();
        loadTrainerOverviewStats();
    }).catch(function(err) {
        console.error(err);
        assignedGrid.innerHTML = '<div class="col-12 text-center text-danger py-4">Could not load classes.</div>';
        openGrid.innerHTML = '';
    });
}

function openTrainerRequestTeachModal(btn) {
    if (!btn || !window.bootstrap) return;
    var id = btn.getAttribute('data-class-id');
    if (!id) return;
    var name = btn.getAttribute('data-class-name') || '';
    var defTime = btn.getAttribute('data-default-time') || '';
    var defDur = btn.getAttribute('data-default-duration') || '60';
    var hid = $('trtClassId');
    var lab = $('trtClassLabel');
    var timeInp = $('trtProposedTime');
    var durInp = $('trtProposedDuration');
    if (!hid || !lab || !timeInp || !durInp) return;
    hid.value = id;
    lab.textContent = name ? 'Request to teach: ' + name : 'Request to teach this class';
    timeInp.value = defTime;
    var d = parseInt(defDur, 10);
    durInp.value = !isNaN(d) && d >= 15 ? String(d) : '60';
    bootstrap.Modal.getOrCreateInstance($('trainerRequestTeachModal')).show();
}

function submitTrainerClassRequestFromModal() {
    if (!currentUid) return;
    var hid = $('trtClassId');
    var classId = hid ? String(hid.value || '').trim() : '';
    if (!classId) return;

    var proposedTimeEl = $('trtProposedTime');
    var proposedDurEl = $('trtProposedDuration');
    var proposedTime = proposedTimeEl ? String(proposedTimeEl.value || '').trim() : '';
    var proposedDuration = proposedDurEl ? parseInt(proposedDurEl.value, 10) : NaN;

    if (!proposedTime) {
        showClassAssignAlert('Enter the time you can teach this class (e.g. 09:00).', 'warning');
        return;
    }
    if (isNaN(proposedDuration) || proposedDuration < 15 || proposedDuration > 300) {
        showClassAssignAlert('Duration must be between 15 and 300 minutes.', 'warning');
        return;
    }

    var tname = (trainerData && trainerData.displayName) ? trainerData.displayName.trim() : '';
    if (!tname && currentUser && currentUser.email) tname = currentUser.email;
    if (!tname) tname = 'Trainer';
    var temail = (currentUser && currentUser.email) || '';
    var rid = trainerClassRequestDocId(classId);

    db.collection('classes')
        .doc(classId)
        .get()
        .then(function(doc) {
            if (!doc.exists) {
                showClassAssignAlert('This class could not be found.', 'danger');
                return null;
            }
            var c = doc.data();
            var tid = (c.trainerId || '').trim();
            if (tid && tid !== currentUid) {
                showClassAssignAlert('This class already has a trainer assigned.', 'warning');
                return null;
            }
            if (tid === currentUid) {
                showClassAssignAlert('You are already assigned to this class.', 'info');
                return null;
            }

            return db
                .collection('trainerClassRequests')
                .doc(rid)
                .set(
                    {
                        classId: classId,
                        className: c.name || '',
                        classType: c.type || '',
                        trainerId: currentUid,
                        trainerName: tname,
                        trainerEmail: temail,
                        proposedTime: proposedTime,
                        proposedDurationMinutes: proposedDuration,
                        status: 'pending',
                        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                    },
                    { merge: true }
                )
                .then(function() {
                    return true;
                });
        })
        .then(function(saved) {
            if (!saved) return;
            var m = $('trainerRequestTeachModal');
            if (m) {
                var inst = bootstrap.Modal.getInstance(m);
                if (inst) inst.hide();
            }
            showClassAssignAlert('Request submitted. A gym admin will review it.', 'success');
            loadTrainerClasses();
        })
        .catch(function(err) {
            showClassAssignAlert(err.message || 'Could not submit request.', 'danger');
        });
}

var secClassesEl = $('sec-classes');
if (secClassesEl) {
    secClassesEl.addEventListener('click', function(e) {
        var mLog = e.target.closest('.trainer-session-log-btn');

        if (mLog && mLog.getAttribute('data-class-id') && mLog.getAttribute('data-session-date')) {
            var cid = mLog.getAttribute('data-class-id');
            var sdt = mLog.getAttribute('data-session-date');
            var row = {
                classId: cid,
                sessionDate: sdt,
                className: mLog.getAttribute('data-class-name') || '',
                scheduleDay: mLog.getAttribute('data-day') || '',
                time: mLog.getAttribute('data-time') || '',
                completion: null
            };
            db.collection('trainerClassCompletions')
                .doc(trainerClassCompletionDocId(cid, sdt))
                .get()
                .then(function(doc) {
                    if (doc.exists) row.completion = doc.data();
                    openTrainerSessionLogModalFromRow(row);
                })
                .catch(function(err) {
                    console.error(err);
                    showClassAssignAlert('Could not open session log.', 'danger');
                });

            return;
        }

        var btn = e.target.closest('.request-class-btn');

        if (!btn || !btn.getAttribute('data-class-id')) return;

        openTrainerRequestTeachModal(btn);

    });
}

if ($('btnTrtSubmit')) {
    $('btnTrtSubmit').addEventListener('click', function() {
        submitTrainerClassRequestFromModal();
    });
}

function bindTrainerWeekNav() {

    function goto(offset) {


        trainerClassTrackWeekOffset = offset;

        loadTrainerWeekSessions();


    }

    if ($('btnTrainerWeekPrev')) {


        $('btnTrainerWeekPrev').addEventListener('click', function() {


            goto(trainerClassTrackWeekOffset - 1);


        });

    }


    if ($('btnTrainerWeekNext')) {


        $('btnTrainerWeekNext').addEventListener('click', function() {


            goto(trainerClassTrackWeekOffset + 1);


        });

    }


    if ($('btnTrainerWeekToday')) {


        $('btnTrainerWeekToday').addEventListener('click', function() {


            trainerClassTrackWeekOffset = 0;

            loadTrainerWeekSessions();


        });

    }


    if ($('btnRefreshWeekSessions')) {


        $('btnRefreshWeekSessions').addEventListener('click', loadTrainerWeekSessions);


    }


}

bindTrainerWeekNav();

bindTrainerSessionLogModal();

if ($('btnRefreshClasses')) {
    $('btnRefreshClasses').addEventListener('click', loadTrainerClasses);
}

if ($('btnRefreshOverview')) {
    $('btnRefreshOverview').addEventListener('click', loadTrainerOverviewStats);
}
if ($('btnRefreshSchedule')) {
    $('btnRefreshSchedule').addEventListener('click', loadTrainerOverviewStats);
}

/* ─── Members (from bookings) ─── */
function loadMyMembers() {
    var tbody = $('myMembersBody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">Loading…</td></tr>';

    db.collection('bookings').where('trainerId', '==', currentUid).get()
        .then(function(snap) {
            var map = {};
            snap.forEach(function(doc) {
                var b = doc.data();
                var mid = b.memberId;
                if (!mid) return;
                if (!map[mid]) {
                    map[mid] = {
                        name: (b.memberName && String(b.memberName).trim()) || (b.memberEmail && String(b.memberEmail).trim()) || '',
                        email: b.memberEmail || '',
                        className: b.className || '—'
                    };
                }
            });
            var keys = Object.keys(map);
            if (!keys.length) {
                tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">No members with bookings yet.</td></tr>';
                return null;
            }
            var fetchNames = keys.map(function(memberId) {
                if (map[memberId].name) return Promise.resolve();
                return db.collection('members').doc(memberId).get().then(function(d) {
                    if (d.exists()) {
                        var x = d.data();
                        map[memberId].name = (x.displayName || x.email || memberId).trim();
                    } else {
                        map[memberId].name = memberId;
                    }
                });
            });
            return Promise.all(fetchNames).then(function() { return { keys: keys, map: map }; });
        })
        .then(function(payload) {
            if (!payload || !payload.keys || !payload.keys.length) return;
            var keys = payload.keys;
            var map = payload.map;
            tbody.innerHTML = '';
            keys.forEach(function(memberId) {
                var m = map[memberId];
                var tr = document.createElement('tr');
                var nameCell = document.createElement('td');
                nameCell.textContent = m.name || memberId;
                var emailCell = document.createElement('td');
                emailCell.textContent = m.email || '—';
                var classCell = document.createElement('td');
                classCell.textContent = m.className || '—';
                var sessCell = document.createElement('td');
                sessCell.textContent = '—';
                var actCell = document.createElement('td');
                actCell.textContent = '—';
                tr.appendChild(nameCell);
                tr.appendChild(emailCell);
                tr.appendChild(classCell);
                tr.appendChild(sessCell);
                tr.appendChild(actCell);
                tbody.appendChild(tr);
            });
        })
        .catch(function() {
            tbody.innerHTML = '<tr><td colspan="5" class="text-center text-danger">Could not load members.</td></tr>';
        });
}

if ($('btnRefreshMembers')) {
    $('btnRefreshMembers').addEventListener('click', loadMyMembers);
}

/* ─── Chat with Admin (single thread at adminChats/{trainerUid}) ─── */
function openTrainerAdminChat() {
    if (chatMsgUnsub) {
        chatMsgUnsub();
        chatMsgUnsub = null;
    }

    var list = $('chatRoomsList');
    if (list) {
        list.innerHTML = '';
        var div = document.createElement('div');
        div.className = 'chat-room-item active';
        div.innerHTML =
            '<div class="chat-room-avatar">A</div>' +
            '<div class="chat-room-info">' +
                '<div class="chat-room-name">Admin</div>' +
                '<div class="chat-room-last">DaDaGym support</div>' +
            '</div>';
        list.appendChild(div);
    }

    if ($('chatHeaderBar')) {
        $('chatHeaderBar').innerHTML = '<span><i class="fas fa-user-shield me-2"></i>Admin</span>';
    }
    if ($('chatInputArea')) $('chatInputArea').classList.remove('d-none');

    var msgs = $('chatMessages');
    if (!msgs) return;
    msgs.innerHTML = '<div class="text-muted small p-3">Loading messages…</div>';

    var ref = rtdb.ref('adminChats/' + currentUid).orderByChild('timestamp');
    var render = function(snapshot) {
        msgs.innerHTML = '';
        if (!snapshot.exists()) {
            msgs.innerHTML = '<div class="chat-empty">No messages yet. Say hi to the admin!</div>';
            return;
        }
        var arr = [];
        snapshot.forEach(function(c) { arr.push(c.val()); });
        arr.sort(function(a, b) { return (a.timestamp || 0) - (b.timestamp || 0); });
        arr.forEach(function(m) {
            var div = document.createElement('div');
            var isSent = m.senderId === currentUid;
            div.className = 'chat-msg ' + (isSent ? 'sent' : 'received');
            var time = m.timestamp ? new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
            var who = '';
            if (!isSent && m.senderName) {
                who = '<div class="msg-sender small text-white-50 mb-1">' + escHtml(m.senderName) + '</div>';
            }
            div.innerHTML = who + escHtml(m.text || '') + '<div class="msg-time">' + time + '</div>';
            msgs.appendChild(div);
        });
        msgs.scrollTop = msgs.scrollHeight;
    };
    ref.on('value', render, function(err) {
        console.error('Chat read error:', err);
        msgs.innerHTML = '<div class="text-danger small p-3">Could not load messages.</div>';
    });
    chatMsgUnsub = function() { ref.off('value', render); };
}

function sendTrainerMessage() {
    var input = $('chatInput');
    if (!input) return;
    var text = input.value.trim();
    if (!text || !currentUid) return;

    var msg = {
        senderId: currentUid,
        senderName: trainerData.displayName || (currentUser && currentUser.email) || 'Trainer',
        senderRole: 'trainer',
        text: text,
        timestamp: firebase.database.ServerValue.TIMESTAMP
    };

    input.disabled = true;
    rtdb.ref('adminChats/' + currentUid).push(msg)
        .then(function() {
            input.value = '';
            input.disabled = false;
            input.focus();
        })
        .catch(function(err) {
            console.error('Send error:', err);
            alert(err.message || 'Failed to send.');
            input.disabled = false;
            input.focus();
        });
}

if ($('btnSendChat')) {
    $('btnSendChat').addEventListener('click', sendTrainerMessage);
}
if ($('chatInput')) {
    $('chatInput').addEventListener('keydown', function(e) {
        if (e.key === 'Enter') sendTrainerMessage();
    });
}

/* ═══ Member check-in (reference / QR) ═══ */

function stopTrainerQrScanner() {
    if (!trainerHtml5QrCode) return;
    var inst = trainerHtml5QrCode;
    trainerHtml5QrCode = null;
    inst.stop().then(function() {
        inst.clear();
    }).catch(function() {
        try { inst.clear(); } catch (e) { /* ignore */ }
    });
}

function trainerCheckinSetResult(html) {
    var el = $('trainerCheckinResult');
    if (el) el.innerHTML = html;
}

/**
 * Read a booking assigned to this trainer using a constrained query so Firestore rules
 * that allow only filtered list reads (not bare document gets) still work.
 */
function trainerFetchBookingIfAssigned(bookingFirestoreId) {
    if (!bookingFirestoreId || !currentUid) return Promise.resolve(null);
    return db
        .collection('bookings')
        .where(firebase.firestore.FieldPath.documentId(), '==', bookingFirestoreId)
        .where('trainerId', '==', currentUid)
        .limit(1)
        .get()
        .then(function(q) {
            return q.empty ? null : q.docs[0];
        });
}

function trainerCheckinFriendlyPermissionErr(err) {
    var msg = (err && err.message) ? String(err.message) : 'Lookup failed.';
    if (
        (err && err.code === 'permission-denied') ||
        String((err && err.code) || '').indexOf('permission-denied') !== -1 ||
        /missing or insufficient permissions/i.test(msg)
    ) {
        return (
            'Your Firestore setup blocked this lookup. Deploy rules so trainers may read bookings tied to them (queries ' +
            'use `trainerId` + booking id/code), tap the index link Firebase shows if prompted, ' +
            'and allow trainers to read `bookingLookups` when the reference is not a plain number.'
        );
    }
    return msg;
}

function trainerStartQrScanner() {
    if (typeof Html5Qrcode === 'undefined') {
        alert('QR scanner library did not load. Enter the reference number manually.');
        return;
    }
    var hostId = 'trainerQrReader';
    if (!$(hostId)) return;

    stopTrainerQrScanner();
    trainerHtml5QrCode = new Html5Qrcode(hostId);
    trainerHtml5QrCode.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 220, height: 220 } },
        function(decodedText) {
            stopTrainerQrScanner();
            trainerResolveBooking(decodedText);
        },
        function() { /* frame discard */ }
    ).catch(function(err) {
        trainerHtml5QrCode = null;
        alert(err.message || 'Could not start camera. Check permissions.');
    });
}

function trainerRenderOtherTrainerNotice(L) {
    var tname = L.trainerName && String(L.trainerName).trim() ? L.trainerName : 'Another trainer';
    var cname = L.className != null && String(L.className).trim() !== '' ? String(L.className).trim() : '—';
    var dat = L.date != null && String(L.date).trim() !== '' ? String(L.date).trim() : '—';
    var tim = L.time != null && String(L.time).trim() !== '' ? String(L.time).trim() : '—';
    var whenLine = dat !== '—' || tim !== '—' ? escHtml(dat) + ' · ' + escHtml(tim) : '—';
    trainerCheckinSetResult(
        '<div class="alert alert-warning border-0 mb-0">' +
            '<div class="fw-bold mb-2"><i class="fas fa-user-friends me-2"></i>This booking is not with you</div>' +
            '<p class="small mb-1 text-white-50">Assigned trainer, class, and session time are shown so you can direct the member.</p>' +
            '<hr class="border-secondary">' +
            '<div><span class="text-muted small text-uppercase">Trainer</span><div class="fw-semibold">' + escHtml(tname) + '</div></div>' +
            '<div class="mt-2"><span class="text-muted small text-uppercase">Class</span><div class="fw-semibold">' + escHtml(cname) + '</div></div>' +
            '<div class="mt-2"><span class="text-muted small text-uppercase">When</span><div class="fw-semibold">' + whenLine + '</div></div>' +
        '</div>'
    );
}

function trainerRenderFullBooking(bookingId, b) {
    var st = (b.status || '').trim();
    var sessionOn = b.sessionStarted === true;
    var refNum = b.bookingCode != null ? String(b.bookingCode) : '—';

    var lines = [
        '<div class="mb-2"><span class="text-muted small text-uppercase">Reference</span><div class="fw-bold fs-5">' + escHtml(refNum) + '</div></div>',
        '<div class="mb-2"><span class="text-muted small text-uppercase">Member</span><div class="fw-semibold">' + escHtml(b.memberName || '—') + '</div>' +
            '<div class="small text-muted">' + escHtml(b.memberEmail || '') + '</div></div>',
        '<div class="mb-2"><span class="text-muted small text-uppercase">Class</span><div class="fw-semibold">' + escHtml(b.className || '—') + '</div></div>',
        '<div class="mb-2"><span class="text-muted small text-uppercase">Date</span><div class="fw-semibold">' + escHtml(b.date || '—') + '</div></div>',
        '<div class="mb-2"><span class="text-muted small text-uppercase">Class time</span><div class="fw-semibold">' + escHtml(b.time || '—') + '</div></div>',
        '<div class="mb-3"><span class="text-muted small text-uppercase">Status</span><div>' + escHtml(st || '—') +
            (sessionOn ? ' <span class="badge bg-success ms-1">Session started</span>' : '') + '</div></div>'
    ];

    var actions = '';
    if (st === 'confirmed' && !sessionOn) {
        actions =
            '<button type="button" class="btn btn-success w-100" id="btnTrainerStartSession" data-booking-id="' +
            escHtml(bookingId) + '"><i class="fas fa-play-circle me-2"></i>Start session</button>' +
            '<p class="small text-muted mt-2 mb-0">After you start the session, the member cannot cancel or remove this booking.</p>';
    } else if (st === 'confirmed' && sessionOn) {
        actions = '<div class="alert alert-success border-0 mb-0 py-2 small"><i class="fas fa-check me-1"></i>Session already started.</div>';
    } else if (st === 'cancelled') {
        actions = '<div class="alert alert-secondary border-0 mb-0 py-2 small">This booking was cancelled.</div>';
    }

    trainerCheckinSetResult(
        '<div class="trainer-checkin-detail">' + lines.join('') + actions + '</div>'
    );

    var btn = $('btnTrainerStartSession');
    if (btn) {
        btn.addEventListener('click', function() {
            var bid = btn.getAttribute('data-booking-id');
            if (!bid) return;
            if (!confirm('Start this session? The member will no longer be able to cancel or delete this booking.')) return;
            db.collection('bookings').doc(bid).update({
                sessionStarted: true,
                sessionStartedAt: firebase.firestore.FieldValue.serverTimestamp(),
                sessionStartedBy: currentUid
            }).then(function() {
                return db.collection('bookings').doc(bid).get();
            }).then(function(doc) {
                if (!doc.exists) return;
                var b = doc.data();
                trainerRenderFullBooking(bid, b);
                var mid = b.memberId;
                if (!mid) return;
                return db.collection('members').doc(mid).get().then(function(mdoc) {
                    var md = mdoc.exists ? mdoc.data() : {};
                    if (isMemberPlanActive(md)) return null;
                    var quotaRef = db.collection('members').doc(mid).collection('bookingQuota').doc('usage');
                    return quotaRef.set({
                        completedSessions: firebase.firestore.FieldValue.increment(1)
                    }, { merge: true }).catch(function(e) {
                        console.error('bookingQuota increment failed', e);
                    });
                });
            }).catch(function(err) {
                alert(err.message || 'Could not start session.');
            });
        });
    }
}

function trainerResolveBooking(refRaw) {
    if (!currentUid) return;
    var parsed = parseGymBookingCheckinRaw(refRaw);

    if (parsed.kind === 'v2') {
        trainerCheckinSetResult('<p class="text-muted small mb-0"><i class="fas fa-spinner fa-spin me-2"></i>Looking up…</p>');
        trainerFetchBookingIfAssigned(parsed.bookingId)
            .then(function(bsnap) {
                if (!bsnap) {
                    trainerCheckinSetResult(
                        '<p class="text-warning small mb-0">No booking on your schedule matched this QR—confirm it is your class ' +
                            'or use manual reference lookup.</p>'
                    );
                    return;
                }
                var b = bsnap.data();
                if ((b.memberId || '') !== parsed.memberId) {
                    trainerCheckinSetResult(
                        '<p class="text-warning small mb-0">QR data does not match this booking (member ID mismatch).</p>'
                    );
                    return;
                }
                trainerRenderFullBooking(bsnap.id, b);
            })
            .catch(function(err) {
                console.error(err);
                trainerCheckinSetResult(
                    '<p class="text-danger small mb-0">' + escHtml(trainerCheckinFriendlyPermissionErr(err)) + '</p>'
                );
            });
        return;
    }

    var codeKey = String(parsed.codeKey || '').trim();
    if (!codeKey) {
        trainerCheckinSetResult('<p class="text-warning small mb-0">Enter or scan a valid reference.</p>');
        return;
    }

    trainerCheckinSetResult('<p class="text-muted small mb-0"><i class="fas fa-spinner fa-spin me-2"></i>Looking up…</p>');

    function trainerFinishByBookingCodeNum(num) {
        return db
            .collection('bookings')
            .where('bookingCode', '==', num)
            .where('trainerId', '==', currentUid)
            .limit(1)
            .get()
            .then(function(q) {
                if (q.empty) {
                    trainerCheckinSetResult(
                        '<p class="text-warning small mb-0">No booking found for this reference on your account. ' +
                            'If this member trains with someone else, only their trainer name and time would appear.</p>'
                    );
                    return;
                }
                var doc = q.docs[0];
                trainerRenderFullBooking(doc.id, doc.data());
            });
    }

    if (/^\d+$/.test(codeKey)) {
        trainerFinishByBookingCodeNum(parseInt(codeKey, 10)).catch(function(err) {
            console.error(err);
            trainerCheckinSetResult(
                '<p class="text-danger small mb-0">' + escHtml(trainerCheckinFriendlyPermissionErr(err)) + '</p>'
            );
        });
        return;
    }

    db.collection('bookingLookups').doc(codeKey).get()
        .then(function(lsnap) {
            if (lsnap.exists) {
                var L = lsnap.data();
                var ltid = (L.trainerId || '').trim();
                if (ltid !== currentUid) {
                    trainerRenderOtherTrainerNotice(L);
                    return null;
                }
                return trainerFetchBookingIfAssigned(L.bookingId).then(function(bsnap) {
                    if (!bsnap) {
                        trainerCheckinSetResult('<p class="text-danger small mb-0">Booking record missing. Ask admin.</p>');
                        return;
                    }
                    trainerRenderFullBooking(bsnap.id, bsnap.data());
                });
            }
            var numParsed = parseInt(codeKey, 10);
            if (!isNaN(numParsed)) {
                return trainerFinishByBookingCodeNum(numParsed);
            }
            return trainerFetchBookingIfAssigned(codeKey).then(function(bsnap) {
                if (!bsnap) {
                    trainerCheckinSetResult(
                        '<p class="text-warning small mb-0">No booking found for this reference.</p>'
                    );
                    return;
                }
                trainerRenderFullBooking(bsnap.id, bsnap.data());
            });
        })
        .catch(function(err) {
            console.error(err);
            trainerCheckinSetResult(
                '<p class="text-danger small mb-0">' + escHtml(trainerCheckinFriendlyPermissionErr(err)) + '</p>'
            );
        });
}

if ($('btnTrainerLookupRef')) {
    $('btnTrainerLookupRef').addEventListener('click', function() {
        var inp = $('trainerBookingRefInput');
        trainerResolveBooking(inp ? inp.value : '');
    });
}
if ($('trainerBookingRefInput')) {
    $('trainerBookingRefInput').addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            trainerResolveBooking(this.value);
        }
    });
}
if ($('btnTrainerScanStart')) {
    $('btnTrainerScanStart').addEventListener('click', function() { trainerStartQrScanner(); });
}
if ($('btnTrainerScanStop')) {
    $('btnTrainerScanStop').addEventListener('click', function() { stopTrainerQrScanner(); });
}
