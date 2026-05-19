# Booking check-in and QR codes

This document explains how class **booking check-in** works for members, trainers, and admins, and what to configure in Firebase.

## For gym staff (trainers & admins)

### Scanning a member's QR

1. Open the **trainer** or **admin** dashboard and go to the **check-in** section (member check-in / booking check-in).
2. Tap **Start scanner** and allow the browser to use the camera.
3. Point the camera at the member's QR code from their phone (booking confirmation or **My bookings**).

The scanner uses the **html5-qrcode** library (`Html5Qrcode`). If the library fails to load, members can still use the **reference number** and staff can type it into the lookup field.

### Manual lookup

Enter the numeric **reference** shown on the member's booking screen, or paste the full scanned text if needed, then run lookup.

### What the app does after a scan

- **New QR format (v2):** the string looks like  
  `DaDaGym|v2|<member Firebase UID>|<booking document ID>`  
  The app opens that booking directly in Firestore and checks the member id matches the QR.

- **Older QR format:** `DaDaGym|<reference number>`  
  The app resolves the booking via `bookingLookups` and/or a `bookingCode` query (same as before v2).

**Trainers** only get full check-in actions for bookings where they are the assigned trainer; otherwise they see a short "not with you" style message.

---

## For members

### Where to get the QR

- Right after **booking a class** (confirmation modal).
- **My bookings:** tap the row for a booking that has a reference number to open the same confirmation/QR view.

The **reference number** is always shown for staff who prefer typing it.

### What the QR contains

- **v2 (current):** member Firebase user id + Firestore booking document id (plus the `DaDaGym|v2|` prefix), so check-in does not rely only on the numeric code.
- **Legacy:** numeric reference only (`DaDaGym|<code>`). Still supported.

If an old screenshot only shows the short code, that still works for check-in.

---

## For developers / Firebase setup

### Relevant frontend files

| Area | Files |
|------|--------|
| QR generation (member) | `frontend/js/booking-confirmation.js` |
| Scan payload parsing | `frontend/js/booking-checkin-parse.js` |
| Admin check-in | `frontend/js/admin.js` |
| Trainer check-in | `frontend/js/trainer.js` |
| Member booking + My bookings | `frontend/js/member.js` |

### Firestore collections

- **`bookings`** — one document per slot; document id is the slot key (see `bookingSlotDocId` in `member.js`). Fields include `memberId`, `trainerId`, `bookingCode`, etc.
- **`bookingLookups`** — doc id = string `bookingCode`; fields include `bookingId`, `memberId`, `trainerId` (used for legacy / numeric resolution).

### Security rules (important)

Deploy rules so that:

- **Admins** can **`get`** `bookingLookups/{code}` (not only trainers), or legacy admin lookups will fail.
- **Admins** can **read** `bookings` as already defined for your dashboard (direct `get` and queries used by check-in).
- **Trainers** keep existing rules: read bookings where they are the trainer (and list/get patterns you already use).

Example merge point: `allow get: if isApprovedTrainer() || isAdmin();` on `bookingLookups` (adjust to match your project's `isAdmin()` helper).

Deploy:

```bash
firebase deploy --only firestore:rules
```

### Scanner library

- **html5-qrcode** is loaded from a CDN where admin/trainer (and punch) pages include it — see `admin.html` / `trainer.html` (and `punch.html` if applicable).
- Member **QR generation** uses **qrcodejs** on `member.html`, not html5-qrcode.

---

## Troubleshooting

| Issue | What to check |
|--------|----------------|
| "Firestore blocked this lookup" | Rules: admin `get` on `bookingLookups`, admin read on `bookings`; deploy rules. |
| Trainer sees permission errors | Trainer must be signed in; rules must allow their reads/updates on that booking. |
| Camera does not start | Browser permissions, HTTPS (or localhost), try manual reference entry. |
| v2 QR not scanning | Lighting, distance, or use numeric reference; v2 QR is denser — confirmation UI uses higher error correction. |

---

## Version note

**v2** QR payloads were added so check-in can use **member id + booking document id** directly. New QR codes use the `DaDaGym|` prefix. **Legacy** `GymDD|`-prefixed payloads remain valid for older printed/screenshotted codes.
