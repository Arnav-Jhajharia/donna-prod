# donna · mobile

native client for donna. lives inside donna-prod as `mobile/` — same product as the brain in `../src/donna/`, different surface. whatsapp and imessage are the other surfaces; this is the third.

## relationship to the parent

the canonical product context lives in `../CLAUDE.md`. read it first. this file only documents what's mobile-specific.

inherited conventions (do not restate, do not violate):
- voice: lowercase, no em dashes, no semicolons, no emojis, no markdown in user-visible strings
- code style: small focused files (200-400 lines, hard ceiling 800), immutable updates, organize by feature
- how we work: line-by-line, deliberate. no "while we're here" additions. one small thing, commit, next.

## stack

- expo sdk 52 + react native 0.76 (new architecture enabled)
- typescript strict + `noUncheckedIndexedAccess`
- expo-router for navigation (file-based, in `app/`)
- no state library yet — add only when cross-screen state shows up

## layout

```
app/                       — expo-router pages, file-based routing
  _layout.tsx              — root: clerkprovider + theme + auth gate
  (auth)/
    _layout.tsx            — signed-out stack
    sign-in.tsx            — splash + apple sign in (clerk useSSO)
  onboarding/               — only reachable when signed in but not onboarded
    _layout.tsx            — linear stack, gestures off
    fork.tsx               — page 2: ring me / let's type
    call.tsx               — page 3: placeholder for the call surface (callkit takes over)
    letter.tsx             — page 3a: declined-path letter
    identification.tsx     — page 4: name + city (declined path only)
    days.tsx               — page 5: what fills your days
    people.tsx             — page 6: who matters
    vacuum.tsx             — page 7: oauth cards (gmail / calendar / claude)
    ingestion.tsx          — page 8: rolling captions while donna reads
    reveal.tsx             — page 9: the wow paragraph
    demo.tsx               — page 10: first action card
    phone.tsx              — page 11: optional whatsapp linking
    handoff.tsx            — page 12: marks onboarded=true, drops into (tabs)
  (tabs)/
    _layout.tsx            — tabs: dashboard · live · history (custom tab bar)
    dashboard.tsx          — integrations, voice, quiet hours, account
    index.tsx              — live (chat, default tab)
    history.tsx            — timeline of memories, briefs, chats, held-back
src/
  design/                  — the design system (mirrors ../../donna/dashboard/project/ds)
    reference/             — read-only copy of the dashboard's tokens.css + SYSTEM.md
    primitives.ts          — palette, alpha, space, radius
    roles.ts               — bg.*, fg.*, border.* (light + dark)
    type.ts                — typography roles as TextStyle objects
    fonts.ts               — useDonnaFonts() — loads EB Garamond + Red Hat Text
    theme.tsx              — ThemeProvider + useTheme()
    index.ts               — barrel
  components/
    ChatBubble.tsx         — donna / user bubble
    ChatComposer.tsx       — pill input + send
    TabBar.tsx             — custom bottom tabs
    OnboardingShell.tsx    — placeholder shell for onboarding pages
  lib/
    token-cache.ts         — clerk's token cache, backed by expo-secure-store
  config.ts                — env var surface (EXPO_PUBLIC_*)
```

components consume **roles**, never primitives. `theme.fg.primary`, never `palette.ink[900]`.

## scripts

```bash
npm start              # metro bundler (serves js to expo go / dev client)
npm run typecheck
```

## running on device — dev build only

we don't use the ios simulator. we also don't use expo go anymore — we're committed to the dev build path from day one because the native modules we need (callkit + livekit voip) require it. expo go gets dropped from the workflow.

**first time setup (one-time per developer)**
1. `npm install` in `mobile/` — installs `expo-dev-client` + all expo deps
2. `eas login` — authenticate against expo cloud
3. `eas init` — creates the project on expo's servers, writes the `projectId` to app.json
4. `eas build --profile development --platform ios` — kicks off a cloud build, ~15-20 min
5. install the resulting build on the phone via the eas link or testflight invite

**daily dev loop**
1. `npx expo start --dev-client` on the laptop
2. open the donna dev build on the phone
3. it auto-connects to metro and hot-reloads on every save

`eas.json` profiles:
- `development` — dev client, internal distribution, real device (no simulator)
- `preview` — finished build (no dev client), internal distribution. used for sharing builds without testflight review
- `production` — store-ready

ios device builds need an apple developer account ($99/yr). eas handles provisioning automatically the first time.

## ios native config

`app.json` declares:
- `usesAppleSignIn: true` — required for apple sign in to work (adds the entitlement)
- `UIBackgroundModes: ["voip", "audio", "remote-notification"]` — voip push wake, background audio during calls, regular push delivery
- `ITSAppUsesNonExemptEncryption: false` — exempts donna from extra encryption export compliance review at app store submission

config plugins (in order):
- `expo-router` · file-based routing
- `expo-asset` · static asset handling
- `expo-dev-client` · custom dev client (required since we don't use expo go)
- `expo-secure-store` · ios keychain access for clerk token cache
- `expo-apple-authentication` · native apple sign in flow
- `@config-plugins/react-native-callkeep` · callkit bridge for the incoming-call ui
- `@config-plugins/react-native-voip-push-notification` · pushkit bridge for voip pushes
- `@livekit/react-native-expo-plugin` · adds webrtc native deps for voice calls

if any of these are removed, the call feature stops working. don't remove without aligning on it.

## auth

clerk handles identity. apple sign in is the only method right now (mobile). under the hood:
- `useSSO({ strategy: 'oauth_apple' })` in (auth)/sign-in.tsx triggers the native apple sheet
- clerk creates a user, returns a session jwt
- jwt persists in ios keychain via `src/lib/token-cache.ts` (backed by expo-secure-store)
- root `_layout.tsx` gates routes: signed out → /(auth)/sign-in, signed in but not onboarded → /onboarding/fork, signed in + onboarded → /(tabs)

"onboarded" is currently tracked on the clerk user via `unsafeMetadata.onboarded` (client-writable for v1). once the brain backend can set `publicMetadata` via webhook, the flag moves there (server-only writable, tamper-resistant).

env required:
- `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` · from clerk dashboard, safe to expose in the bundle

## voice call wiring (in progress)

native deps are installed and config plugins are loaded — but the actual call orchestration isn't wired yet. when we ship that work:
- backend triggers a voip push via apns
- `react-native-voip-push-notification` receives it in `AppDelegate`
- within 5s we must call `reportNewIncomingCall` via `react-native-callkeep`
- on accept, `@livekit/react-native` joins a room with the agent

see `../docs/voice-call.html` for the full architecture.

## env

`EXPO_PUBLIC_*` vars are inlined into the bundle at build time. anything secret must NOT use that prefix and must NOT live in this app — secrets stay on the backend.

required: `EXPO_PUBLIC_DONNA_API_URL` (where the donna-prod server is reachable).

## ingress

the backend currently has two ingress paths (`../src/server.ts` — `/webhook` for whatsapp, `/imessage/webhook` for linq). a third path for mobile clients needs designing — likely an authenticated `/mobile/message` endpoint that mirrors the dispatcher pattern. do not invent the protocol here without aligning on the backend first; both sides of the contract live in this same repo now, so cross-cutting changes can land in one commit.

## sharp edges

- expo public env vars are public. treat them as such.
- the new architecture flag in `app.json` is on by default in sdk 52. some third-party libs lag — verify before adding any native module.
- ios bundle id `com.donna.app` is placeholder. claim a real one before any testflight build.
