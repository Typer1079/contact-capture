# Contact Capture

A mobile-first web app (installable PWA) for capturing contacts and exporting them.

**This version (v0.1, test build)**
- Sign in with email + password (Supabase Auth)
- Type a contact by hand, or scan the PDF417 barcode on the back of a US/Canadian driver's license (consent required; keeps name, address, sex and physical description, never the license number or birth date)
- Saved contact list with search, multi-select, and delete
- **Add to phone**: one tap builds a vCard so iOS or Android can save it to Contacts
- **CSV export** in three layouts: All fields, Google Contacts, Outlook
- No CRM sync. License data is never sent to Salesforce or HubSpot in this version.

**Coming next:** voice capture, business card OCR, then the Cloudflare Worker for HubSpot and Salesforce.

---

## How the security works

| Concern | What this app does |
|---|---|
| Who can see data | Postgres **row-level security**: each user can only read and change their own rows, enforced by the database, not the app. |
| Keys in the browser | Only Supabase's *publishable/anon* key is in the app. It's designed to be public; RLS is what protects data. The secret `service_role` key is never used. |
| License data | Barcode is decoded **on the device** (WebAssembly, self-hosted, no CDN). The parser only reads name, address, sex, height, weight, eye and hair color. License number, birth date, expiry, and document numbers are never extracted, saved, or sent. |
| Consent | Scanning is blocked until two consent boxes are ticked. The time of consent is saved with the contact, and the database rejects license-sourced contacts without it. |
| Cross-site scripting | Strict Content Security Policy (no inline scripts, no third-party scripts), React escaping, input length limits on the client and in the database. |
| CSV injection | Cells starting with `= + - @` are prefixed with `'` so Excel won't run them as formulas. |
| Passwords | 12-character minimum; sign-in errors don't reveal which emails have accounts. |
| Dependencies | Dependabot weekly updates; tests run on every push. |

---

## Setup from scratch (about 30 minutes)

### 1. Install tools on your computer
- **Node.js 22 LTS**: https://nodejs.org
- **Git**: https://git-scm.com (macOS: run `git --version` and accept the prompt to install)
- A code editor, e.g. **VS Code**

### 2. Create the Supabase project (database + login)
1. Sign up at https://supabase.com and click **New project**. Pick a region near you (e.g. *East US*), set a strong database password, and save it in your password manager.
2. When it's ready, open **SQL Editor → New query**, paste the whole of `supabase/migrations/001_contacts.sql`, and click **Run**. You should see "Success. No rows returned."
3. Open **Project Settings → API** (or the **Connect** button) and copy:
   - the **Project URL**
   - the **publishable** / **anon** key (NOT the `service_role` / secret key)
4. Open **Authentication → URL Configuration**:
   - **Site URL**: `https://YOUR-GITHUB-USERNAME.github.io/contact-capture/`
   - **Redirect URLs**: add that same URL, plus `http://localhost:5173/` for local testing
5. Open **Authentication → Sign In / Providers → Email** and make sure **Confirm email** is on.
6. *Recommended:* in **Authentication → Attack Protection**, turn on **leaked password protection** if your plan offers it, and set a CAPTCHA later if you open sign-ups to others.

> To keep it private to you and invited users only: after you create your own account, turn **off** "Allow new users to sign up" (Authentication → Sign In / Providers) and invite others from **Authentication → Users → Invite**.

### 3. Run it locally
```bash
cd contact-capture
cp .env.example .env.local      # then paste your URL and anon key into .env.local
npm install
npm run dev
```
Open http://localhost:5173, create an account, confirm the email, and sign in.

To test the camera on your **phone** during development, run `npm run dev -- --host` and open the shown network address. Browsers only allow the camera on `https` or `localhost`, so the easiest phone test is the GitHub Pages deploy below.

### 4. Put it on GitHub
1. On https://github.com/new create a repository named **contact-capture** (Private is fine; GitHub Pages from a private repo needs a paid plan. If you're on the free plan, make it Public. No secrets are in the code).
2. In the project folder:
   ```bash
   git init
   git add .
   git commit -m "Contact Capture v0.1"
   git branch -M main
   git remote add origin https://github.com/YOUR-GITHUB-USERNAME/contact-capture.git
   git push -u origin main
   ```
3. In the repo on GitHub: **Settings → Secrets and variables → Actions → Variables tab → New repository variable**. Add:
   - `VITE_SUPABASE_URL` = your Project URL
   - `VITE_SUPABASE_ANON_KEY` = your publishable/anon key
4. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
5. **Actions** tab → open "Test and deploy to GitHub Pages" → **Run workflow** (or just push again). In about a minute the site is live at `https://YOUR-GITHUB-USERNAME.github.io/contact-capture/`.
6. Recommended repo security: **Settings → Code security** → turn on **Dependabot alerts**, **Dependabot security updates**, and **Secret scanning / push protection**. Under **Settings → Branches**, add a rule for `main` requiring the workflow to pass.

### 5. Install on your phone
Open the site on your phone:
- **iPhone (Safari):** Share → *Add to Home Screen*
- **Android (Chrome):** menu → *Install app*

### 6. Test the license scanner
`docs/test-license-barcode.png` is a **fake** license barcode ("Test Sample", Sugar Land TX). Open it on your computer screen and scan it with the phone. You should get a prefilled form: Test Sample, Sugar Land TX, Male, 5'10", 180 lb, brown eyes, brown hair.

---

## Updating the app
Each update comes with a list of files and where they go.
1. **If the update includes a new `supabase/migrations/00X_….sql` file, run it first** in Supabase → SQL Editor → New query → paste → Run. (The app will fail to save until you do.)
2. Copy each file into the folder GitHub Desktop uses (**Repository → Show in Finder**) at the path listed, replacing the old one.
3. In GitHub Desktop: check the Changes list matches the update (and never includes `.env.local`), write a summary, **Commit to main**, **Push origin**.
4. Wait about 2 minutes, then fully close and reopen the app on your phone.

## Project layout
```
src/
  App.tsx                  screens and navigation
  components/
    Auth.tsx               sign in / sign up / reset
    ContactForm.tsx        editable review form (scan results are highlighted)
    ContactList.tsx        search, select, CSV export, add-to-phone, delete
    LicenseScanner.tsx     consent gate + camera/photo PDF417 scan
  lib/
    aamva.ts               license parser (allow-list: name, address, physical description)
    barcode.ts             on-device PDF417 reader (zxing-wasm, self-hosted)
    csv.ts / vcard.ts      export formats
    contactsApi.ts         Supabase reads/writes
    validate.ts            input cleanup and validation
supabase/migrations/       database schema + row-level security (run each file once, in order)
.github/workflows/         test + deploy to GitHub Pages
```

## Commands
| Command | What it does |
|---|---|
| `npm run dev` | local dev server |
| `npm test` | unit tests (parser, CSV, vCard) |
| `npm run lint` | lint |
| `npm run build` | type-check and production build to `dist/` |

## Known limits of GitHub Pages
GitHub Pages can't send custom HTTP headers, so the security policy is a `<meta>` tag. That covers scripts and connections but not clickjacking protection (`frame-ancestors`). If you later want full headers, put Cloudflare in front of the site or host on Cloudflare Pages. It's the same build and a 5-minute switch.
