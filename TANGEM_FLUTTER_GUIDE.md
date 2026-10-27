# Indico Protocol — Tangem Wallet Integration Guide for Flutter Developers

> **Target OS:** Android ONLY (API 21+)  
> **Wallet Hardware:** Tangem NFC Card (EAL6+ Secure Element)  
> **Mobile App Bridge:** Official Tangem Wallet App (`com.tangem.wallet`) via WalletConnect v2 (Reown)  
> **Backend URL:** `https://indico-app-backend.onrender.com`  
> **Network:** Base Sepolia (`Chain ID: 84532`, EVM Namespace: `eip155:84532`)  
> **Indico Contract:** `0x422D36E2198863C5b2A6B8E2865fBf5196de96cF`  
> **USDC Contract:** `0x036CbD53842c5426634e7929541eC2318f3dCF7e`  

---

## 1. High-Level Architecture (Why Zero NFC Code is Needed)

You do **NOT** need to write any NFC code or integrate low-level ISO-7816 smart card APDUs in Flutter. 

Instead, the Indico app uses an **App-to-App Bridge** via WalletConnect v2 (Reown):
1. When your Flutter app needs a signature or transaction, it triggers a WalletConnect request.
2. The Android OS automatically deep-links into the official **Tangem Wallet App** installed on the user's phone.
3. The Tangem App asks the user to hold their physical Tangem card against the back of their phone.
4. The card's secure chip generates the cryptographic secp256k1 signature and broadcasts the transaction.
5. The Tangem app immediately returns control and the transaction hash back to your Flutter app.

```
+---------------------------------------------------------------------------------+
|                         INDICO FLUTTER MOBILE APP                               |
+---------------------------------------------------------------------------------+
            |                                                     ^
 (1) Calls /prepare-*                                     (4) Receives Tx Hash
            |                                                     |
            v                                                     |
+--------------------------+                           +--------------------------+
|  Indico Backend REST API |                           |    Tangem Wallet App     |
| (Render / Neon Cloud)    |                           |   (com.tangem.wallet)    |
| - Prepares raw calldata  |                           | - Receives WC intent     |
| - Returns {to,data,value}|                           | - Prompts NFC Card Tap   |
+--------------------------+                           | - Signs on secure chip   |
                                                       +--------------------------+
                                                                  |
                                                          (3) Broadcasts Tx
                                                                  |
                                                                  v
+---------------------------------------------------------------------------------+
|                       BASE SEPOLIA BLOCKCHAIN (Chain ID: 84532)                 |
+---------------------------------------------------------------------------------+
```

---

## 2. Project Prerequisites & Android Setup

### 2.1 Get a Free Reown (WalletConnect) Project ID
1. Go to [cloud.reown.com](https://cloud.reown.com) (free).
2. Create a project named **Indico**.
3. Copy the **Project ID** (e.g. `a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6`).

### 2.2 Flutter Dependencies (`pubspec.yaml`)
Add these packages to your Flutter app:

```yaml
dependencies:
  flutter:
    sdk: flutter
  # WalletConnect v2 / Reown AppKit
  reown_appkit: ^1.1.0
  # Deep-linking into Tangem App
  url_launcher: ^6.3.0
  # HTTP API client
  http: ^1.2.0
  # Secure JWT storage
  flutter_secure_storage: ^9.2.2
```

### 2.3 Android Configuration (`android/app/src/main/AndroidManifest.xml`)
In order for Android 11+ to allow your app to detect and launch the official Tangem App, add these `<queries>` inside the root `<manifest>` tag:

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <!-- Allow Indico to discover and launch the Tangem App -->
    <queries>
        <package android:name="com.tangem.wallet" />
        <intent>
            <action android:name="android.intent.action.VIEW" />
            <data android:scheme="wc" />
        </intent>
        <intent>
            <action android:name="android.intent.action.VIEW" />
            <data android:scheme="tangem" />
        </intent>
    </queries>

    <application ...>
        <!-- Deep link return handler so Tangem can return back to Indico -->
        <activity ...>
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="indico" android:host="wc" />
            </intent-filter>
        </activity>
    </application>
</manifest>
```

---

## 3. Step-by-Step Implementation

### Step 3.1: Initialize the WalletConnect / Tangem Service

Create a singleton service `lib/services/tangem_service.dart`:

```dart
import 'package:flutter/foundation.dart';
import 'package:reown_appkit/reown_appkit.dart';
import 'package:url_launcher/url_launcher.dart';

class TangemService {
  static final TangemService instance = TangemService._internal();
  TangemService._internal();

  late ReownAppKitModal appKit;
  bool isInitialized = false;

  static const String reownProjectId = 'YOUR_REOWN_PROJECT_ID'; // From cloud.reown.com
  static const String baseSepoliaChainId = 'eip155:84532';

  // Base Sepolia Network Specification
  final ReownAppKitModalNetworkInfo baseSepoliaNetwork = ReownAppKitModalNetworkInfo(
    name: 'Base Sepolia',
    chainId: '84532',
    currency: 'ETH',
    rpcUrl: 'https://sepolia.base.org',
    explorerUrl: 'https://sepolia.basescan.org',
  );

  Future<void> init(BuildContext context) async {
    if (isInitialized) return;

    appKit = ReownAppKitModal(
      context: context,
      projectId: reownProjectId,
      metadata: const PairingMetadata(
        name: 'Indico',
        description: 'Indico Institutional Asset Ledger',
        url: 'https://indico-app-backend.onrender.com',
        icons: ['https://indico-app-backend.onrender.com/favicon.ico'],
        redirect: Redirect(
          native: 'indico://wc',
          universal: 'https://indico-app-backend.onrender.com/app',
        ),
      ),
      featuredWalletIds: {
        'com.tangem.wallet', // Prioritize Tangem
      },
    );

    await appKit.init();
    isInitialized = true;
  }

  /// Returns the connected Ethereum address or null
  String? get connectedAddress => appKit.session?.address;

  /// Returns true if Tangem App is currently installed on the phone
  Future<bool> isTangemInstalled() async {
    final uri = Uri.parse('tangem://');
    return await canLaunchUrl(uri);
  }

  /// Open Tangem App directly
  Future<void> openTangemApp() async {
    final tangemUri = Uri.parse('tangem://');
    if (await canLaunchUrl(tangemUri)) {
      await launchUrl(tangemUri, mode: LaunchMode.externalApplication);
    } else {
      // Fallback: Open Google Play Store to install Tangem
      final playStoreUri = Uri.parse('market://details?id=com.tangem.wallet');
      await launchUrl(playStoreUri, mode: LaunchMode.externalApplication);
    }
  }
}
```

---

### Step 3.2: Connecting Tangem & Binding Wallet to User Profile

To authenticate a user's wallet with the backend, Indico requires an **EIP-191 personal signature**.

```dart
class TangemAuthHelper {
  final TangemService _tangem = TangemService.instance;

  /// 1. Connect Tangem Wallet via WalletConnect Modal
  Future<String?> connectTangem(BuildContext context) async {
    await _tangem.init(context);
    await _tangem.appKit.openModalView();
    return _tangem.connectedAddress;
  }

  /// 2. Request EIP-191 Signature from Tangem Card
  Future<String> signBindingMessage({
    required String accountRef,
    required String walletAddress,
  }) async {
    final message = "Indico Protocol Binding: $accountRef";
    
    // Launch Tangem to prompt card tap
    await _tangem.openTangemApp();

    final signature = await _tangem.appKit.request(
      topic: _tangem.appKit.session!.topic,
      chainId: TangemService.baseSepoliaChainId,
      request: SessionRequestParams(
        method: 'personal_sign',
        params: [
          message,
          walletAddress,
        ],
      ),
    );

    return signature as String;
  }
}
```

#### Sending to Backend:
Once signed, submit to the backend:
```http
POST https://indico-app-backend.onrender.com/profile/wallet/bind
Headers:
  Authorization: Bearer <USER_JWT_TOKEN>
  Content-Type: application/json

Body:
{
  "walletAddress": "0xd785f1668D59710199d8b9aF37eD31883621Aa65",
  "signature": "0x3045022100e478..."
}
```

---

### Step 3.3: Executing Prepared On-Chain Transactions via Tangem

The Indico backend uses a **Zero-ABI / Prepared-Transaction** pattern. 
- You do **not** need Solidity ABIs or web3.dart.
- The backend gives you `{ to, data, value, gasLimit }`.
- You pass that exact payload to Tangem via `eth_sendTransaction`.

```dart
class TangemTxExecutor {
  final TangemService _tangem = TangemService.instance;

  /// Executes any prepared transaction returned by the Indico Backend
  Future<String> executePreparedTransaction({
    required Map<String, dynamic> preparedTx,
  }) async {
    final session = _tangem.appKit.session;
    if (session == null) {
      throw Exception('Tangem Wallet is not connected.');
    }

    // Direct app switch into Tangem so the user taps their physical card
    await _tangem.openTangemApp();

    final txParams = {
      'from': session.address,
      'to': preparedTx['to'],
      'data': preparedTx['data'],
      'value': preparedTx['value'] ?? '0x0',
    };

    if (preparedTx.containsKey('gasLimit') && preparedTx['gasLimit'] != null) {
      txParams['gas'] = preparedTx['gasLimit'];
    }

    // Sends eth_sendTransaction RPC to Tangem App
    final txHash = await _tangem.appKit.request(
      topic: session.topic,
      chainId: TangemService.baseSepoliaChainId,
      request: SessionRequestParams(
        method: 'eth_sendTransaction',
        params: [txParams],
      ),
    );

    return txHash as String;
  }
}
```

---

## 4. Complete Backend `/prepare-*` Route Reference

Below are the 6 transaction types your app will execute.

### 4.1 Terms Agreement Signing
- **Backend Route:** `POST /terms/prepare-sign`
- **What it does:** Records on-chain that user accepted terms hash.
- **Backend Response:**
  ```json
  {
    "to": "0x422D36E2198863C5b2A6B8E2865fBf5196de96cF",
    "data": "0x7a83b2e2...",
    "value": "0x0"
  }
  ```
- **Action:** Pass directly to `executePreparedTransaction(preparedTx)`.

---

### 4.2 Asset On-Chain Registration
- **Backend Route:** `POST /assets/{id}/prepare-register`
- **What it does:** Locks asset SHA-256 document hash onto Base Sepolia.
- **Backend Response:**
  ```json
  {
    "to": "0x422D36E2198863C5b2A6B8E2865fBf5196de96cF",
    "data": "0x98f24a10...",
    "value": "0x0"
  }
  ```
- **Action:** Pass directly to `executePreparedTransaction(preparedTx)`.

---

### 4.3 Credit Spend (Payment to Merchant)
- **Backend Route:** `POST /credit/prepare-spend`
- **Request Body:**
  ```json
  {
    "merchant": "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
    "amount": "250000000" // 250.000000 USDC (6 decimals)
  }
  ```
- **Backend Response:**
  ```json
  {
    "to": "0x422D36E2198863C5b2A6B8E2865fBf5196de96cF",
    "data": "0x2e1a7d4d...",
    "value": "0x0"
  }
  ```
- **Action:** Pass directly to `executePreparedTransaction(preparedTx)`.

---

### 4.4 Borrow Loan
- **Backend Route:** `POST /loans/prepare-borrow`
- **Request Body:**
  ```json
  {
    "principal": "500000000" // 500.000000 USDC
  }
  ```
- **Backend Response:**
  ```json
  {
    "to": "0x422D36E2198863C5b2A6B8E2865fBf5196de96cF",
    "data": "0xa6f9dae1...",
    "value": "0x0",
    "requiredCollateral": "625000000" // 625.000000 USDC (125% ratio)
  }
  ```
- **Action:**
  - Display `requiredCollateral` to the user.
  - Pass the `{ to, data, value }` to `executePreparedTransaction(preparedTx)`.

---

### 4.5 Loan Repayment (2-Step Execution)
- **Backend Route:** `POST /loans/prepare-repay`
- **Request Body:**
  ```json
  {
    "loanId": "3"
  }
  ```
- **Backend Response:**
  ```json
  {
    "approvalTx": {
      "to": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // USDC Token
      "data": "0x095ea7b3...",
      "value": "0x0"
    },
    "repayTx": {
      "to": "0x422D36E2198863C5b2A6B8E2865fBf5196de96cF", // Indico Ledger
      "data": "0x371303c0...",
      "value": "0x0"
    }
  }
  ```
- **Important:** Repaying requires **two card taps**:
  1. `await executePreparedTransaction(preparedTx['approvalTx']);` (Approves USDC)
  2. `await executePreparedTransaction(preparedTx['repayTx']);` (Executes Repay & Releases Collateral)

---

### 4.6 Loan Due-Date Extension
- **Backend Route:** `POST /loans/prepare-extend`
- **Request Body:**
  ```json
  {
    "loanId": "3"
  }
  ```
- **Backend Response:**
  ```json
  {
    "to": "0x422D36E2198863C5b2A6B8E2865fBf5196de96cF",
    "data": "0x1b4a92c3...",
    "value": "0x0"
  }
  ```
- **Action:** Pass directly to `executePreparedTransaction(preparedTx)`.

---

## 5. Monetary Numbers: 6 Decimals Fixed-Point Rule

In the Indico Protocol, USDC has **6 decimals**. Never use floating-point `double` arithmetic for financial math.

Use this Dart helper:

```dart
class IndicoAmount {
  /// Converts human string "100.50" -> integer string "100500000"
  static String toUnits(String amount) {
    final parts = amount.trim().split('.');
    final whole = parts[0];
    String frac = parts.length > 1 ? parts[1] : '';
    if (frac.length > 6) {
      frac = frac.substring(0, 6);
    } else {
      frac = frac.padRight(6, '0');
    }
    return BigInt.parse('$whole$frac').toString();
  }

  /// Converts units "100500000" -> human display "$100.50"
  static String format(String units) {
    final bi = BigInt.parse(units);
    final isNegative = bi.isNegative;
    final absVal = bi.abs().toString().padLeft(7, '0');
    final splitIndex = absVal.length - 6;
    final whole = absVal.substring(0, splitIndex);
    final frac = absVal.substring(splitIndex, splitIndex + 2); // 2 decimals for UI
    return "${isNegative ? '-' : ''}\$$whole.$frac";
  }
}
```

---

## 6. Pre-Configured Test Accounts for Live Testing

You can connect directly to the live cloud backend:
- **Server Address:** `https://indico-app-backend.onrender.com`

| Account | Email | Password | Wallet Address | Status & History |
| --- | --- | --- | --- | --- |
| **MetaMask / Tangem Live User** | `testuser1@indico.com` | `12345678` | `0xd785f1668D59710199d8b9aF37eD31883621Aa65` | Approved on-chain, **15 real transactions**, **$47,450.75 USDC** available credit. |
| **Seeded Mock User** | `alice@indico.example` | `UserPass2026!` | `0x70997970c51812dc3a010c7d01b50e0d17dc79c8` | Approved in DB, **$100,000.00 USDC** credit. |

---

## 7. Developer Checklist for Implementation

- [ ] Add `reown_appkit` and `url_launcher` to `pubspec.yaml`.
- [ ] Add `<queries>` for `com.tangem.wallet` in `AndroidManifest.xml`.
- [ ] Register at [cloud.reown.com](https://cloud.reown.com) and set `reownProjectId`.
- [ ] Implement `TangemService` singleton.
- [ ] Bind wallet via `personal_sign` and `POST /profile/wallet/bind`.
- [ ] Execute `prepare-*` transactions via `eth_sendTransaction`.
- [ ] Handle 2-step transactions on `prepare-repay` (Approve USDC then Repay).
- [ ] Verify transactions on [BaseScan Sepolia](https://sepolia.basescan.org).
