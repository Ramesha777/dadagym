/**
 * Gym public ID: three a–z letters derived from the email local part + three digits.
 * Stored in gymPublicIds/{id} (registry) and mirrored as gymPublicId on members/trainers/users.
 */

/** Digital ID card + punch kiosk — same style as booking QRs (Html5Qrcode decodes plain text). */
export var DIGITAL_ID_QR_PREFIX = 'DaDaGym|id|';

export function buildDigitalIdQrPayload(firebaseUid) {
    var uid = String(firebaseUid || '').trim();
    if (!uid) return '';
    return DIGITAL_ID_QR_PREFIX + uid;
}

/**
 * Inner payload after the `DaDaGym|` / `GymDD|` strip — i.e. `id|{firebaseAuthUid}`.
 */
export function parseDigitalIdQrInnerAfterBrandStrip(inner) {
    var s = String(inner || '').trim();
    var m = s.match(/^id\|(.+)$/i);
    if (!m) return null;
    var uid = m[1].trim();
    if (!uid || uid.length < 10 || uid.length > 128) return null;
    if (!/^[A-Za-z0-9_-]+$/.test(uid)) return null;
    return uid;
}

function letters3FromEmail(email) {
    var local = String(email || '').split('@')[0] || '';
    var buf = '';
    for (var i = 0; i < local.length && buf.length < 3; i++) {
        var c = local[i].toLowerCase();
        if (c >= 'a' && c <= 'z') buf += c;
    }
    while (buf.length < 3) buf += 'x';
    return buf.substring(0, 3);
}

function randomDigits3() {
    var n = Math.floor(Math.random() * 1000);
    return n < 10 ? '00' + n : n < 100 ? '0' + n : String(n);
}

export function isValidGymPublicId(s) {
    return typeof s === 'string' && /^[a-z]{3}[0-9]{3}$/.test(s);
}

export function fetchGymPublicIdFromRegistry(db, uid) {
    if (!db || !uid) return Promise.resolve(null);
    return db
        .collection('gymPublicIds')
        .where('uid', '==', uid)
        .limit(1)
        .get()
        .then(function(snap) {
            if (snap.empty) return null;
            return snap.docs[0].id;
        })
        .catch(function() {
            return null;
        });
}

function allocateGymPublicId(db, uid, email, role) {
    var prefix = letters3FromEmail(email);

    function attempt(remaining) {
        if (remaining <= 0) {
            return Promise.reject(new Error('Could not assign a Gym ID. Try again.'));
        }
        var id = prefix + randomDigits3();
        var registryRef = db.collection('gymPublicIds').doc(id);
        return registryRef
            .get()
            .then(function(snap) {
                if (snap.exists) return attempt(remaining - 1);
                return registryRef
                    .set({
                        uid: uid,
                        role: role,
                        createdAt: firebase.firestore.FieldValue.serverTimestamp()
                    })
                    .then(function() {
                        return id;
                    })
                    .catch(function() {
                        return attempt(remaining - 1);
                    });
            });
    }

    return attempt(45);
}

export function ensureGymPublicId(db, uid, email, role) {
    if (!db || !uid) return Promise.resolve(null);
    email = String(email || '').trim();
    if (!email) return Promise.resolve(null);

    if (role === 'member') {
        return db
            .collection('members')
            .doc(uid)
            .get()
            .then(function(doc) {
                var d = doc.exists ? doc.data() : {};
                if (isValidGymPublicId(d.gymPublicId)) return d.gymPublicId;
                return fetchGymPublicIdFromRegistry(db, uid).then(function(fromReg) {
                    if (fromReg && isValidGymPublicId(fromReg)) {
                        return db
                            .collection('members')
                            .doc(uid)
                            .set(
                                {
                                    gymPublicId: fromReg,
                                    email: email
                                },
                                { merge: true }
                            )
                            .then(function() {
                                return fromReg;
                            });
                    }
                    return allocateGymPublicId(db, uid, email, 'member').then(function(pid) {
                        /* set+merge: works for create and update; always include email for rules + backfill */
                        return db
                            .collection('members')
                            .doc(uid)
                            .set(
                                {
                                    gymPublicId: pid,
                                    email: email
                                },
                                { merge: true }
                            )
                            .then(function() {
                                return pid;
                            });
                    });
                });
            });
    }

    if (role === 'trainer') {
        return db
            .collection('trainers')
            .doc(uid)
            .get()
            .then(function(doc) {
                var d = doc.exists ? doc.data() : {};
                if (isValidGymPublicId(d.gymPublicId)) return d.gymPublicId;
                return fetchGymPublicIdFromRegistry(db, uid).then(function(fromReg) {
                    if (fromReg && isValidGymPublicId(fromReg)) {
                        var rp = {
                            gymPublicId: fromReg,
                            email: email
                        };
                        if (!doc.exists) rp.approvalStatus = 'pending';
                        return db.collection('trainers').doc(uid).set(rp, { merge: true }).then(function() {
                            return fromReg;
                        });
                    }
                    return allocateGymPublicId(db, uid, email, 'trainer').then(function(pid) {
                        var wp = {
                            gymPublicId: pid,
                            email: email
                        };
                        if (!doc.exists) wp.approvalStatus = 'pending';
                        return db.collection('trainers').doc(uid).set(wp, { merge: true }).then(function() {
                            return pid;
                        });
                    });
                });
            });
    }

    if (role === 'admin') {
        return db
            .collection('users')
            .doc(uid)
            .get()
            .then(function(uDoc) {
                var ud = uDoc.exists ? uDoc.data() : {};
                if (isValidGymPublicId(ud.gymPublicId)) return ud.gymPublicId;
                return fetchGymPublicIdFromRegistry(db, uid).then(function(fromReg) {
                    if (fromReg) {
                        if (uDoc.exists) {
                            return db
                                .collection('users')
                                .doc(uid)
                                .update({ gymPublicId: fromReg })
                                .then(function() {
                                    return fromReg;
                                });
                        }
                        return fromReg;
                    }
                    return allocateGymPublicId(db, uid, email, 'admin').then(function(pid) {
                        if (uDoc.exists) {
                            return db
                                .collection('users')
                                .doc(uid)
                                .update({ gymPublicId: pid })
                                .then(function() {
                                    return pid;
                                });
                        }
                        return pid;
                    });
                });
            });
    }

    return Promise.resolve(null);
}
