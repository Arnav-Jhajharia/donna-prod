# mac mini setup

one-time setup to bring the donna repo to a new machine. follow top to bottom. each step is independent so you can pause anywhere.

this gets the mac mini ready for two things:
- pulling and editing the donna repo
- running xcode for native iOS work (CallKit + LiveKit debugging, faster local builds than EAS cloud)

estimated time: ~45 min hands-on, plus xcode downloading in the background.

---

## pre-flight

before you start:
- macOS sequoia 15.0 or newer (check: apple menu → about this mac)
- ~30gb free disk space (xcode is 15gb, simulators are another 5-10gb)
- your github account is set up
- the current laptop has donna-prod's `.env` files — you'll copy them over

---

## step 1 · install xcode (the long one)

start this first. it takes ~30 min to download.

1. open the app store
2. search "xcode"
3. install (it's free, ~15gb)

while it downloads, continue with steps 2 through 5.

after xcode finishes:

```bash
sudo xcode-select --install
sudo xcodebuild -license accept
```

then open xcode once. let it install additional iOS platform components when prompted. close it.

sign into your apple developer account in xcode so EAS can find your team on cloud builds:
- xcode → settings → accounts → +
- sign in with the apple id tied to your developer account

---

## step 2 · homebrew

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

at the end of the install, it prints two commands like:

```bash
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
eval "$(/opt/homebrew/bin/brew shellenv)"
```

run them. then verify:

```bash
brew --version
```

---

## step 3 · node 20 via nvm

```bash
brew install nvm
mkdir -p ~/.nvm
echo 'export NVM_DIR="$HOME/.nvm"' >> ~/.zshrc
echo '[ -s "/opt/homebrew/opt/nvm/nvm.sh" ] && . "/opt/homebrew/opt/nvm/nvm.sh"' >> ~/.zshrc
source ~/.zshrc

nvm install 20
nvm alias default 20
```

verify:

```bash
node -v   # v20.x.x
npm -v
```

---

## step 4 · react native toolchain

```bash
brew install watchman
brew install cocoapods
```

watchman is the file watcher metro uses. cocoapods handles the native iOS dep graph (needed for EAS dev client builds even if EAS cloud-builds for you).

---

## step 5 · eas cli

```bash
npm install -g eas-cli
eas login
```

use your expo account credentials (same as the other laptop).

verify:

```bash
eas whoami
```

---

## step 6 · git config

`user.name` and `user.email` are per-machine. set them so commits from this machine show the right author on github:

```bash
git config --global user.name "Arnav Jhajharia"
git config --global user.email "bharatankh@gmail.com"
```

(replace with whatever email you use on github)

---

## step 7 · clone the repo

```bash
mkdir -p ~/code
cd ~/code
git clone https://github.com/Arnav-Jhajharia/donna-prod
cd donna-prod
```

install brain deps:

```bash
npm install
```

install mobile deps:

```bash
cd mobile
npm install
cd ..
```

first install is the slowest (400-500mb of node_modules across both). expect ~5 min on decent wifi.

---

## step 8 · the .env files (gitignored)

`.env` files don't sync via git. copy them manually from the other laptop.

**brain (`donna-prod/.env`)** — required keys:

```
ANTHROPIC_API_KEY=...
```

**mobile (`mobile/.env`)** — required keys:

```
EXPO_PUBLIC_DONNA_API_URL=...
EXPO_PUBLIC_DONNA_USER_ID=
```

easiest way to move them:

```bash
# on the other laptop, in donna-prod/:
cat .env > /tmp/donna-brain-env.txt
cat mobile/.env > /tmp/donna-mobile-env.txt
# airdrop both files to the mac mini

# on the mac mini, in donna-prod/:
cp ~/Downloads/donna-brain-env.txt .env
cp ~/Downloads/donna-mobile-env.txt mobile/.env
rm ~/Downloads/donna-*-env.txt
```

or use 1Password / your password manager to fetch the values.

---

## step 9 · verify everything works

brain:

```bash
cd ~/code/donna-prod
npm run typecheck    # should pass
npm run dev          # should boot the cli loop
```

ctrl-c to stop.

mobile:

```bash
cd ~/code/donna-prod/mobile
npm start
```

you should see metro start with a qr code. scan it with the iphone camera (expo go installed). app should load. ctrl-c to stop.

---

## step 10 · iOS development extras (only when we hit week 3)

these are only needed when we start integrating CallKit + LiveKit native modules. skip until then.

verify xcode command-line tools are real:

```bash
xcodebuild -version
```

should print something like:

```
Xcode 16.x
Build version ...
```

if it shows the command-line tools path instead of xcode, run:

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
```

then verify your apple developer team is associated:

```bash
xcrun simctl list devicetypes | head -5
```

should print iOS device types. if it fails, sign in to xcode → settings → accounts.

---

## multi-computer workflow

both machines pull from `main`. work happens on whichever feels comfortable:

| machine | natural role |
|---|---|
| current laptop | js iteration, code edits, design, docs, brain backend |
| mac mini | native debugging, fast local builds, xcode-touched anything |

**before switching machines:**

```bash
git status              # confirm nothing uncommitted
git pull                # get latest
```

**when you switch machines:**

```bash
git pull
npm install             # if package.json changed since last pull
cd mobile && npm install && cd ..
```

if anything breaks after a pull, delete `node_modules` and reinstall:

```bash
rm -rf node_modules mobile/node_modules
npm install
cd mobile && npm install && cd ..
```

---

## common gotchas

- **"command not found: brew" after install** — restart the terminal, or `source ~/.zprofile`.
- **"command not found: nvm" after install** — restart the terminal, or `source ~/.zshrc`.
- **`npm install` fails with peer-dep errors** — try `npm install --legacy-peer-deps`.
- **`xcodebuild` shows the wrong path** — `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`.
- **cocoapods complains about ruby version** — `brew install ruby`, follow the path-export instructions homebrew prints, restart terminal.
- **`eas build` fails with "no apple team found"** — sign in to xcode → settings → accounts. EAS reads team info from there on first build.
- **metro starts but iphone can't connect** — same wifi network, no vpn, no corporate captive portal. if those fail: `npx expo start --tunnel`.

---

## when you're done

```bash
cd ~/code/donna-prod
git status              # should be clean
node -v                 # v20.x.x
brew --version
xcodebuild -version     # should print xcode version (only if step 1 finished)
eas whoami              # should print your expo username
```

if all five succeed, the mac mini is ready.

push any first commit from this machine to confirm git auth works:

```bash
echo "" >> README.md
git add README.md
git commit -m "test: first commit from mac mini"
git push
```

then revert the change:

```bash
git revert HEAD --no-edit
git push
```

(this is paranoid but proves the round-trip works. you can skip if you trust it.)

---

## what's still ahead

after this setup is done, the mac mini is dormant until week 3 of the build (CallKit + LiveKit native integration). it'll sit there, fully provisioned, waiting. then we switch to it for the native work.
