# Testing the Indico app on an Android phone over Wi-Fi

This guide is for testing the app on a **real Android phone** while the backend runs on **your desktop** (`npm run dev`, port 3000). The phone and the desktop are on the **same Wi-Fi**. You don't need a USB cable or any Android tools.

## How it works

On the phone, `localhost` means the phone itself. So the app has to call your desktop by its **Wi-Fi IP address**:

```text
Phone (indico app)  ──Wi-Fi──>  http://<desktop-IP>:3000  ──>  backend on your desktop
```

This test build has a **Server address** setting on the sign-in screen. You type your desktop's address once, the app checks it can reach the backend, and it remembers the address. Nothing has to be rebuilt.

## What you receive

| | |
| --- | --- |
| File | `indico-debug.apk` (about 214 MB, debug build) |
| SHA-256 | `35a24f831b6dd942717a716cb31626ca3862da0cd8836d8a2f5734aa4be7bb54` |
| App name on the phone | `indico` |
| Package id | `com.example.indico_asset_ledger` |
| Needs | Android 7.0 or newer |
| Default server | `http://localhost:3000`. Change it on the sign-in screen (step 4). |

This is a **debug** build on purpose:
- Only debug builds may use plain `http://`. Release builds require HTTPS.
- Only debug builds have the Server address setting.
- Debug builds fill in the email verification token for you.

It starts a little slower and shows a small "DEBUG" banner. Both are normal.

## 1. Start the backend on the desktop

In `Indico-App/backend`, the `.env` must keep `HOST="0.0.0.0"` (the default in `.env.example`). With `127.0.0.1`, the phone can't connect.

```sh
npx prisma db push
SEED_MOCK_DATA=true npx tsx prisma/seed.ts   # creates alice@indico.example / UserPass2026! and two merchants
npm run dev       # API on :3000
npm run worker    # chain indexer (second terminal)
```

Check on the desktop: `curl http://localhost:3000/health` should return `{"status":"ok",...}`.

## 2. Find the desktop's Wi-Fi IP address

| Desktop | Command | Example |
| --- | --- | --- |
| macOS | `ipconfig getifaddr en0` | `192.168.1.20` |
| Windows | `ipconfig`, then "IPv4 Address" under the Wi-Fi adapter | `192.168.1.20` |
| Linux | `hostname -I` (first address) | `192.168.1.20` |

Your server address is then **`http://192.168.1.20:3000`** (use your own IP).

Check from the desktop: `curl http://192.168.1.20:3000/health`.

## 3. Let the phone through the desktop's firewall

- **Windows:**
  - Windows asks the first time Node.js listens. Choose **Allow access** on **Private networks**.
  - Make sure the Wi-Fi is set to **Private**, not Public.
  - Or add a rule in an admin terminal:
    ```bat
    netsh advfirewall firewall add rule name="Indico API 3000" dir=in action=allow protocol=TCP localport=3000
    ```
- **macOS:** if the firewall is on (System Settings → Network → Firewall), allow incoming connections for `node` when asked.
- **Linux (ufw):** `sudo ufw allow 3000/tcp`.

**Test from the phone:** open Chrome on the phone and go to `http://192.168.1.20:3000/health`. If you see `{"status":"ok",...}`, the network is ready. If it doesn't load, see Troubleshooting.

## 4. Install the app and set the server address

1. Copy `indico-debug.apk` to the phone (Google Drive, a USB file transfer, etc.) and open it. Allow "install unknown apps" for that app when Android asks.
2. Open **indico**.
3. On the sign-in screen, below "Sign up", tap **Server: http://localhost:3000**.
4. Enter `http://192.168.1.20:3000` (your IP) and tap **Test & save**:
   - The app calls `/health` and saves the address only if the backend answers.
   - The link now shows your address.
   - The app remembers it after restarts.
   - **Use default** switches back to `localhost:3000`.

> If your desktop's IP changes (new network, router restart), tap the Server link again and enter the new IP.

## 5. Test the app

### A. Seeded user (main flow)

| Step | Expected result |
| --- | --- |
| Sign in with `alice@indico.example` / `UserPass2026!` | You reach the **Platform Terms** screen. It says the account is *pending administrator approval* and shows a **Continue to App** button. |
| Tap **Continue to App** | Dashboard: "Welcome back", credit **$100,000** |
| **Assets** tab | Lists alice's assets (references start with `BD-`) |
| **Upload** an asset (PDF, PNG or JPEG) | It's created as **Pending**. On the asset detail screen, **Download Document** asks where to save the file and saves it. |
| **Loans** and **Activity** tabs | Both are empty. This is expected (see "Known limits"). |
| **Send / Spend** | Lists the two seeded merchants. Searching "meridian" filters the list. |
| **Profile → Sign Out** | Back to the sign-in screen |
| Close the app and reopen it after signing in | The session is restored, and you're not asked to sign in again. |

While you test, the `npm run dev` terminal shows each request from the phone with its status code.

### B. New account

| Step | Expected result |
| --- | --- |
| **Sign up** with a new email and password | Goes to "Verify your email address". The token field is already filled in (debug build). |
| Tap **Verify** | Account verified. Next comes the wallet step. |
| **Connect wallet** | Fails with *"Wallet connection is not configured. Set REOWN_PROJECT_ID for this build."* Expected for this APK (see below). |

You can also test **Forgot password**. The reset token is filled in automatically too, as long as the backend isn't running with `NODE_ENV=production`.

## Known limits of this build

- **No wallet (WalletConnect).** This APK was built without a Reown project id, so connecting a wallet and signing transactions aren't available. New accounts stop at the wallet step, so use alice for everything else.
- **On-chain actions are refused.** Alice is approved in the database but **not on-chain**. The backend therefore refuses these actions with *"not approved on-chain"*:
  - register asset on-chain;
  - spend;
  - borrow.

  The app shows that message. This is backend and seed behaviour, not an app bug.
- **No loans or transactions.** The history comes from the chain indexer. No transactions have been sent, and indexer events are currently not being stored (issue 1 in `app_api_audit.md`). So Loans and Activity are empty.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| **Test & save** says "Could not reach …" | Open `http://<IP>:3000/health` in Chrome on the phone. If that fails too, it's the network, not the app. Go through the next rows. |
| `/health` works on the desktop with `localhost` but not with the IP | `HOST` in `.env` must be `0.0.0.0`. Restart `npm run dev` after changing it. |
| Works on the desktop with the IP, not on the phone | Firewall (step 3), or the phone isn't on the same Wi-Fi. The phone must not be on mobile data, a VPN, or a different band or SSID that's isolated. |
| Still blocked on a guest, office or hotel Wi-Fi | Many of these networks block devices from talking to each other ("AP / client isolation"). Use a home network or a phone hotspot with the desktop connected to it, or use the USB fallback below. |
| "Network error" after it worked before | The desktop's IP changed. Check it again (step 2) and update the Server address. |
| Install fails with "App not installed" | Uninstall the old indico app first, then install again. |

## Fallback: USB instead of Wi-Fi

If the Wi-Fi blocks the connection, keep the Server address at the default `http://localhost:3000` and forward the port over USB:

```sh
# needs Android platform-tools (macOS: brew install --cask android-platform-tools)
# and USB debugging enabled on the phone
adb devices                      # accept the prompt on the phone
adb reverse tcp:3000 tcp:3000    # run again after every reconnect
```

## Rebuilding this APK (app developer)

```sh
cp config/env.example.json config/dev.json
flutter build apk --debug --dart-define-from-file=config/dev.json
# output: build/app/outputs/flutter-apk/app-debug.apk
```

- You can also set the desktop's IP as the default instead of `localhost`: add `--dart-define=API_BASE_URL=http://192.168.1.20:3000`.
- To enable the wallet, put a project id from cloud.reown.com into `REOWN_PROJECT_ID` in `config/dev.json` first.
- The Server address setting only exists in debug builds. Release builds always use `API_BASE_URL`.
