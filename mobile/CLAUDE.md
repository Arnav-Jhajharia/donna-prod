# donna · mobile

native client for donna. lives inside donna-prod as `mobile/`. same product as the brain in `../src/donna/`, different surface. whatsapp and imessage are the other surfaces; this is the third.

## relationship to the parent

the canonical product context lives in `../CLAUDE.md`. read it first. this file only documents what's mobile-specific.

inherited conventions (do not restate, do not violate):
- voice rules (lowercase, no em dashes, no semicolons, no emojis, no markdown, no exclamations in user-visible strings)
- line-by-line working style
- verification protocol (no asserting versions/urls/api without checking)

## stack

- expo (current SDK — see `package.json` for the pin) + react native + typescript strict
- expo-router for navigation (file-based, under `app/`)
- clerk for auth (apple sign in via `useSSO`)
- livekit + callkeep + voip-push for the voice call feature
- design system mirrored from `../../donna/dashboard/project/ds`

no global state lib yet. add one only when state needs to cross-tab persistently.

## layout

`app/` holds expo-router pages organized by access control:

- `(auth)/` — pages shown only when signed out
- `onboarding/` — pages shown only after sign-in, before completing onboarding
- `(tabs)/` — main app, shown only after onboarding completes

the root `app/_layout.tsx` wraps everything in `<ClerkProvider>` and gates which group the user lands in based on auth + onboarded state. the gate reads `user.unsafeMetadata.onboarded` (v1, client-writable) or `user.publicMetadata.onboarded` (when backend-writable wiring lands).

`src/` holds shared code:

- `design/` — design system (tokens, roles, type, fonts, theme). components consume **roles**, never primitives. `theme.fg.primary`, never `palette.ink[900]`. that indirection is what makes dark mode and re-skinning free.
- `components/` — shared ui pieces
- `lib/` — non-ui utilities (auth token cache, etc.)

the design system has a read-only spec at `src/design/reference/` (copies of `tokens.css` + `SYSTEM.md` from the dashboard project). consult before deviating.

## scripts

```bash
npm start              # metro bundler (dev client)
npm run tunnel         # metro through expo's tunnel (use when phone + laptop on different wifi)
npm run typecheck
```

## the dev workflow

we don't use the ios simulator. we don't use expo go. **dev build path only**, because callkit + livekit voip require native modules.

an iOS app is two things glued together: **the native binary** (slow to build, rarely changes) and **the JS bundle** (instant, changes constantly). the dev build is a streaming container — it loads JS from metro on your laptop. you rebuild the binary *only* when native code or app config changes.

| change | rebuild needed? |
|---|---|
| any `.ts` / `.tsx` edit | no (metro hot-reloads) |
| add a pure-js npm package | no |
| add a native module (callkeep, livekit, etc.) | yes |
| change `app.json` plugins, infoPlist, entitlements | yes |
| bump expo sdk major version | yes |

for daily js work, metro is the loop. rebuilds are rare and scoped to native-module changes.

## first-time setup

```bash
npm install            # mobile deps. .npmrc has legacy-peer-deps=true
eas login              # auth to expo cloud
eas init               # writes projectId to app.json (only first time)
eas build --profile development --platform ios   # ~15-20 min cloud build
```

then install the resulting build on the phone via testflight invite or eas link.

## eas profiles

- `development` — dev client, internal distribution, real device only. for daily js iteration.
- `preview` — finished build (no dev client), js baked in. for sharing without testflight review.
- `production` — store-ready, autoIncrement on.

ios device builds need an apple developer account ($99/yr). eas handles provisioning automatically the first time you build. apple developer team association lives in xcode → settings → accounts on whichever mac you use to interact with eas (or set via `eas credentials`).

## env

`EXPO_PUBLIC_*` vars get inlined into the bundle at build time. **anything secret must NOT use that prefix** and must NOT live in this app — secrets stay on the backend.

env vars donna-mobile reads are documented in `.env.example`. keep that file current as new vars come in.

## auth

clerk handles identity. mobile path is apple sign in only right now (no email/password, no phone otp yet). flow:

1. user taps "continue with apple" on `(auth)/sign-in.tsx`
2. `useSSO({ strategy: 'oauth_apple' })` triggers apple's native sheet
3. clerk creates the user, returns a session jwt
4. jwt is persisted via `src/lib/token-cache.ts` (backed by `expo-secure-store` → iOS keychain)
5. the root layout's auth gate notices the new session and redirects

onboarded state lives on `clerk user metadata`. when the backend wires up clerk webhooks, the gate moves from `unsafeMetadata` (client-writable, v1) to `publicMetadata` (server-only, tamper-resistant).

## ios native config

`app.json` declares what the native build needs. the load-bearing entries:

- `usesAppleSignIn: true` — apple sign in entitlement
- `ios.infoPlist.UIBackgroundModes` includes `voip` + `audio` + `remote-notification` for the call feature
- `ios.infoPlist.ITSAppUsesNonExemptEncryption: false` — skips encryption export compliance step on app store submit
- usage description strings (microphone, calendar, etc.) — apple requires them before runtime permission requests

config plugins live in `app.json` `plugins` array. they run during `eas build` to inject native iOS/Android setup. adding a new native module that needs config means: install the npm package, add its plugin to the `plugins` array, rebuild.

## voice call wiring

partially set up. native deps + config plugins are installed (callkeep, livekit, webrtc). the actual orchestration (voip push → callkit invocation → livekit room join → agent → memory persistence) is documented in `../docs/voice-call.html` and not yet implemented.

## ingress to brain

mobile talks to donna-prod brain over authenticated http. the mobile ingress endpoint on the brain side validates the clerk jwt, identifies the user, dispatches to donna's tool loop. not yet wired. when it is, both sides of the contract land in one commit because both repos live in the same tree.

## sharp edges

- `EXPO_PUBLIC_*` env vars are public. treat them as such.
- the dev build binary on your phone is a streaming container. without metro running, the app is blank.
- ios bundle id `com.donna.app` is placeholder. claim a real one before any app store / testflight release.
- `@config-plugins/*` packages often lag behind expo sdk versions. `.npmrc` sets `legacy-peer-deps=true` so npm doesn't choke on outdated peer dep declarations. the actual plugins work fine across the version boundary.
- versions in `package.json`: never bump or pin without verifying on npm. config plugins and native modules drift independently of expo sdk and each other.
