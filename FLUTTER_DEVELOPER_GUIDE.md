# Indico Protocol — Flutter Android Developer Guide (Tangem App Integration)

> **Companion Specification**: [API_GUIDE.md](file:///e:/indico-build/indico-build/API_GUIDE.md)  
> **Target OS**: **Android ONLY** (API Level 21+)  
> **Wallet Integration**: Official **Tangem App** (`com.tangem.wallet`) via WalletConnect v2  
> **NFC Handling**: **Zero NFC coding in Flutter**. The installed Tangem App handles 100% of the NFC card tapping and hardware security internally.  
> **Blockchain Network**: Base Sepolia (`Chain ID: 84532`)  
> **Indico Contract**: [`0x422D36E2198863C5b2A6B8E2865fBf5196de96cF`](https://sepolia.basescan.org/address/0x422D36E2198863C5b2A6B8E2865fBf5196de96cF)  
> **USDC Contract**: [`0x036CbD53842c5426634e7929541eC2318f3dCF7e`](https://sepolia.basescan.org/address/0x036CbD53842c5426634e7929541eC2318f3dCF7e)  

---

## Table of Contents
1. [Architecture: Android App-to-App with Tangem](#1-architecture-android-app-to-app-with-tangem)
2. [Android Configuration (`AndroidManifest.xml` & `build.gradle`)](#2-android-configuration)
3. [Flutter Dependencies (`pubspec.yaml`)](#3-flutter-dependencies-pubspecyaml)
4. [App Screen Hierarchy & Navigation Map](#4-app-screen-hierarchy--navigation-map)
5. [Core Dart Implementations](#5-core-dart-implementations)
   - [5.1 Direct Tangem App Launcher & WalletConnect Session](#51-direct-tangem-app-launcher--walletconnect-session)
   - [5.2 Tangem EIP-191 Auth Nonce Signing (Indico Login)](#52-tangem-eip-191-auth-nonce-signing-indico-login)
   - [5.3 API Client with JWT Bearer Interceptor](#53-api-client-with-jwt-bearer-interceptor)
   - [5.4 6-Decimal Fixed-Point Monetary Handler](#54-6-decimal-fixed-point-monetary-handler)
   - [5.5 Client-Side SHA-256 Document Hashing](#55-client-side-sha-256-document-hashing)
   - [5.6 Executing Prepared On-Chain Transactions via Tangem App](#56-executing-prepared-on-chain-transactions-via-tangem-app)
6. [Design Tokens & Brand Theme](#6-design-tokens--brand-theme)
7. [Android Production Checklist](#7-android-production-checklist)

---

## 1. Architecture: Android App-to-App with Tangem

In this architecture, your Flutter app talks directly to the official **Tangem Wallet App** installed on the same Android device:

1. **Zero NFC Code in Flutter**:
   - The Flutter developer does **not** need to request NFC permissions, configure ISO7816 AIDs, or write low-level NFC communication logic.
   - The official Tangem App manages the physical card NFC read/write, PIN verification, and secure-chip signatures.
2. **App-to-App Bridge (WalletConnect v2)**:
   - Your Flutter app initiates a WalletConnect session and triggers a direct Android Intent to open the Tangem App (`com.tangem.wallet`).
   - Android opens Tangem seamlessly. Tangem prompts the user to tap their card.
   - Once signed, the user returns to the Indico app automatically.
3. **Backend-Assisted Calldata (No Solidity ABIs needed)**:
   - The Indico Backend REST API prepares all transaction calldata `{ to, data, value }`.
   - The Flutter app sends that payload to the Tangem App via `eth_sendTransaction`.
   - The Tangem card signs on-chip and broadcasts to Base Sepolia.
   - The Indico event indexer updates database projections.

```
+---------------------------------------------------------------------------------+
|                         INDICO FLUTTER APP (Android)                            |
+---------------------------------------------------------------------------------+
           |                                                      ^
 (1. REST API /prepare)                                  (4. Returns Tx Hash)
           |                                                      |
           v                                                      |
+----------------------+                               +--------------------------+
| Indico Backend REST  |                               | Tangem Wallet App        |
| - Prepares calldata  |                               | (com.tangem.wallet)      |
| - Validates rules    |                               | - Receives WC intent     |
+----------------------+                               | - Prompts user card tap  |
           ^                                           | - Signs on secure chip   |
           | (Indexer)                                 +--------------------------+
           |                                                      |
           |                                              (3. Broadcasts Tx)
           |                                                      |
           v                                                      v
+---------------------------------------------------------------------------------+
|                      BASE SEPOLIA BLOCKCHAIN (Chain ID: 84532)                  |
|                      Indico Smart Contract (0x422D36E2...96cF)                  |
+---------------------------------------------------------------------------------+
```

---

## 2. Android Configuration

Configure your Android project in `android/app/src/main/AndroidManifest.xml`:

### 2.1 Package Visibility Queries & Deep Links
Add `<queries>` inside the root `<manifest>` tag to allow your app to detect and launch the Tangem App:

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.indico.app">

    <!-- Allow Indico to query and deep-link directly into the Tangem App -->
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

    <application
        android:label="Indico"
        android:icon="@mipmap/ic_launcher">

        <activity
            android:name=".MainActivity"
            android:launchMode="singleTask"
            android:exported="true">
            
            <intent-filter>
                <action android:name="android.intent.action.MAIN"/>
                <category android:name="android.intent.category.LAUNCHER"/>
            </intent-filter>

            <!-- Return Deep Link Scheme for WalletConnect callbacks -->
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="indico" />
            </intent-filter>
        </activity>
    </application>
</manifest>
```

### 2.2 `build.gradle` (Module Level)
In `android/app/build.gradle`:
```groovy
android {
    defaultConfig {
        minSdkVersion 21
        targetSdkVersion 34
    }
}
```

---

## 3. Flutter Dependencies (`pubspec.yaml`)

Add these dependencies to your `pubspec.yaml`:

```yaml
dependencies:
  flutter:
    sdk: flutter

  # WalletConnect v2 (Official AppKit for Flutter)
  reown_appkit: ^1.1.0

  # App-to-App Launcher & Deep Links
  url_launcher: ^6.3.1
  android_intent_plus: ^5.1.4

  # Networking & Secure Storage
  dio: ^5.7.0
  flutter_secure_storage: ^9.2.2

  # State Management
  flutter_bloc: ^8.1.6
  equatable: ^2.0.5

  # Document Uploads & Cryptography
  crypto: ^3.0.6
  file_picker: ^8.1.7
  path_provider: ^2.1.5

  # UI Presentation
  google_fonts: ^6.2.1
  flutter_svg: ^2.0.16
  intl: ^0.19.0
```

---

## 4. App Screen Hierarchy & Navigation Map

```
1. Splash Screen (Check stored JWT in SecureStorage)
   │
   ├── 2. Connect Tangem Screen
   │    ├── Button: "Connect Tangem Wallet"
   │    ├── Checks if Tangem App is installed:
   │    │    ├── IF NO: Prompts download from Google Play Store
   │    │    └── IF YES: Direct Intent to Tangem App -> User approves session
   │    ├── Backend sends nonce: POST /api/v1/auth/nonce
   │    ├── Tangem App prompts card tap -> signs EIP-191 nonce
   │    └── Backend verifies: POST /api/v1/auth/verify -> Saves JWT in SecureStorage
   │
   ├── 3. Onboarding Status Check
   │    ├── If account pending: PendingApprovalScreen (Polled until admin approves)
   │    └── If terms unsigned: SignTermsScreen (Read terms -> Tangem App signs)
   │
   └── 4. Main App Shell (BottomNavigationBar - 4 Primary Tabs)
        ├── Tab 1: Home Dashboard
        │    ├── Total Credit, Available Credit, Active Loans, Locked Collateral
        │    └── Quick Actions: "Borrow USDC", "Pay Merchant", "Add Collateral"
        ├── Tab 2: Loans & Borrowing
        │    ├── Active Loans list (Status, Accrued Interest, Due Date)
        │    ├── "Borrow" Modal -> Tangem App signs -> Broadcasts tx
        │    └── "Repay" / "Extend" Modal -> Tangem App signs -> Broadcasts tx
        ├── Tab 3: Pay Merchant
        │    ├── QR Code scanner for Merchant invoice
        │    └── Payment confirmation -> Tangem App signs -> Broadcasts spend tx
        └── Tab 4: Assets & Collateral
             ├── Registered Collateral list
             └── "Add Asset" -> Pick document -> Client SHA-256 -> Upload -> Tangem signs
```

---

## 5. Core Dart Implementations

### 5.1 Direct Tangem App Launcher & WalletConnect Session

This service connects directly to the Tangem App on Android without showing unnecessary multi-wallet selection dialogs:

```dart
import 'package:flutter/material.dart';
import 'package:reown_appkit/reown_appkit.dart';
import 'package:url_launcher/url_launcher.dart';

class TangemWalletService {
  static const String tangemPackage = "com.tangem.wallet";
  static const String playStoreUrl = "https://play.google.com/store/apps/details?id=com.tangem.wallet";
  
  // Reown / WalletConnect Project ID (from cloud.reown.com)
  static const String projectId = "YOUR_WALLETCONNECT_PROJECT_ID";

  late ReownAppKitModal appKit;
  bool isInitialized = false;

  Future<void> init(BuildContext context) async {
    appKit = ReownAppKitModal(
      context: context,
      projectId: projectId,
      metadata: const PairingMetadata(
        name: "Indico",
        description: "Decentralized Credit & Real World Asset Finance",
        url: "https://indico.io",
        icons: ["https://indico.io/icon.png"],
        redirect: Redirect(
          native: "indico://",
          universal: "https://indico.io",
        ),
      ),
      // Configure Base Sepolia network directly
      optionalNamespaces: {
        'eip155': const RequiredNamespace(
          chains: ['eip155:84532'], // Base Sepolia
          methods: [
            'eth_sendTransaction',
            'personal_sign',
            'eth_signTypedData_v4',
          ],
          events: ['chainChanged', 'accountsChanged'],
        ),
      },
    );

    await appKit.init();
    isInitialized = true;
  }

  /// Checks if the Tangem App is installed on the user's Android phone
  Future<bool> isTangemInstalled() async {
    final intentUri = Uri.parse("tangem://");
    return await canLaunchUrl(intentUri);
  }

  /// Opens Google Play Store to install the Tangem App
  Future<void> openPlayStore() async {
    final url = Uri.parse(playStoreUrl);
    await launchUrl(url, mode: LaunchMode.externalApplication);
  }

  /// Connects directly to the Tangem App via deep link
  Future<void> connectTangem(BuildContext context) async {
    // If Tangem is not installed, direct user to Google Play
    final installed = await isTangemInstalled();
    if (!installed) {
      await openPlayStore();
      return;
    }

    // Launch AppKit pairing session targeting Tangem
    await appKit.openModalView();
  }

  /// Returns the connected Ethereum address
  String? get connectedAddress {
    final session = appKit.session;
    if (session == null) return null;
    final accounts = session.getAccounts();
    if (accounts == null || accounts.isEmpty) return null;
    // Format: "eip155:84532:0x123..." -> extracts "0x123..."
    return accounts.first.split(':').last;
  }
}
```

---

### 5.2 Tangem EIP-191 Auth Nonce Signing (Indico Login)

To authenticate with the Indico backend:
1. Call backend `POST /api/v1/auth/nonce` to get a nonce message.
2. Direct the Tangem App to prompt the user to tap their card and sign the EIP-191 message via `personal_sign`.
3. Submit the signature to `POST /api/v1/auth/verify` to receive the JWT Bearer token.

```dart
import 'package:dio/dio.dart';
import 'package:reown_appkit/reown_appkit.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class TangemAuthService {
  final Dio dio;
  final ReownAppKitModal appKit;
  final FlutterSecureStorage storage;

  TangemAuthService({
    required this.dio,
    required this.appKit,
    required this.storage,
  });

  Future<String> loginWithTangem(String walletAddress) async {
    // 1. Request nonce message from Indico Backend
    final nonceRes = await dio.post("/api/v1/auth/nonce", data: {
      "walletAddress": walletAddress.toLowerCase(),
    });

    final String nonceMessage = nonceRes.data["nonceMessage"] ?? nonceRes.data["message"];

    // 2. Request signature via Tangem App (triggers card tap inside Tangem)
    final signature = await appKit.request(
      topic: appKit.session!.topic,
      chainId: 'eip155:84532',
      request: SessionRequestParams(
        method: 'personal_sign',
        params: [nonceMessage, walletAddress.toLowerCase()],
      ),
    );

    // 3. Verify signature on Indico Backend & receive JWT Bearer token
    final verifyRes = await dio.post("/api/v1/auth/verify", data: {
      "walletAddress": walletAddress.toLowerCase(),
      "signature": signature.toString(),
    });

    final String token = verifyRes.data["token"];
    await storage.write(key: "jwt_token", value: token);
    await storage.write(key: "wallet_address", value: walletAddress.toLowerCase());

    return token;
  }
}
```

---

### 5.3 API Client with JWT Bearer Interceptor

```dart
import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class ApiClient {
  static const String baseUrl = "http://10.0.2.2:3000/api/v1"; // 10.0.2.2 for Android emulator
  final Dio dio;
  final FlutterSecureStorage storage;

  ApiClient({required this.storage})
      : dio = Dio(
          BaseOptions(
            baseUrl: baseUrl,
            connectTimeout: const Duration(seconds: 10),
            receiveTimeout: const Duration(seconds: 15),
            headers: {"Content-Type": "application/json", "Accept": "application/json"},
          ),
        ) {
    dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) async {
          final token = await storage.read(key: "jwt_token");
          if (token != null && token.isNotEmpty) {
            options.headers["Authorization"] = "Bearer $token";
          }
          return handler.next(options);
        },
        onError: (error, handler) async {
          if (error.response?.statusCode == 401) {
            await storage.delete(key: "jwt_token");
          }
          return handler.next(error);
        },
      ),
    );
  }
}
```

---

### 5.4 6-Decimal Fixed-Point Monetary Handler

```dart
class IndicoAmount {
  static const int decimals = 6;
  static const int multiplier = 1000000;

  /// Converts decimal string ("1500.50") to exact integer units (1500500000)
  static BigInt toUnits(String amountStr) {
    final clean = amountStr.trim().replaceAll(',', '');
    if (!RegExp(r'^(0|[1-9]\d*)(\.\d{1,6})?$').hasMatch(clean)) {
      throw FormatException("Invalid amount format: $amountStr");
    }
    final parts = clean.split('.');
    final intPart = BigInt.parse(parts[0]);
    final fracPartStr = parts.length > 1 ? parts[1].padRight(decimals, '0') : '000000';
    final fracPart = BigInt.parse(fracPartStr);
    return (intPart * BigInt.from(multiplier)) + fracPart;
  }

  /// Formats BigInt units (1500000000) to formatted display ("1,500.00 USDC")
  static String formatUnits(BigInt units, {String symbol = "USDC"}) {
    final isNegative = units < BigInt.zero;
    final absUnits = units.abs();
    final intPart = absUnits ~/ BigInt.from(multiplier);
    final fracPart = (absUnits % BigInt.from(multiplier)).toString().padLeft(decimals, '0');
    final displayFrac = fracPart.substring(0, 2);
    final sign = isNegative ? "-" : "";
    return "$sign$intPart.$displayFrac $symbol";
  }
}
```

---

### 5.5 Client-Side SHA-256 Document Hashing

Before submitting any asset document (PDF or image), compute its SHA-256 hash in Dart:

```dart
import 'dart:io';
import 'package:crypto/crypto.dart';

class DocumentHasher {
  /// Computes exact 0x-prefixed 64-hex-character SHA-256 hash
  static Future<String> computeDocHash(File file) async {
    final bytes = await file.readAsBytes();
    final digest = sha256.convert(bytes);
    return "0x${digest.toString().toLowerCase()}";
  }
}
```

---

### 5.6 Executing Prepared On-Chain Transactions via Tangem App

This is how transactions (borrow, spend, repay, register collateral) are executed:
1. Flutter calls Backend REST API: `POST /api/v1/loans/prepare-request`
2. Backend returns `{ to, data, value }`.
3. Flutter forwards `{ from, to, data, value }` to the Tangem App via `eth_sendTransaction`.
4. The Tangem App asks the user to tap their card, signs, and broadcasts the transaction.
5. Tangem returns the transaction hash `0x...` to the Flutter app!

```dart
import 'package:dio/dio.dart';
import 'package:reown_appkit/reown_appkit.dart';

class TangemTransactionExecutor {
  final Dio dio;
  final ReownAppKitModal appKit;

  TangemTransactionExecutor({
    required this.dio,
    required this.appKit,
  });

  /// Executes any prepared backend transaction through the Tangem App
  Future<String> executeTransaction({
    required String senderAddress,
    required String prepareEndpoint,
    required Map<String, dynamic> preparePayload,
  }) async {
    // Step 1: Call Backend to prepare calldata and check gas
    final prepareRes = await dio.post(prepareEndpoint, data: preparePayload);
    final prep = prepareRes.data;

    if (prep["canAfford"] == false) {
      throw Exception("Insufficient Base ETH for gas. Shortfall: ${prep['ethShortfall']} ETH");
    }

    final String toAddress = prep["to"];
    final String callData = prep["data"];
    final String value = prep["value"] ?? "0x0";

    // Step 2: Send transaction request to Tangem App
    // Android switches to Tangem App -> User taps card -> Tangem signs & broadcasts
    final txHash = await appKit.request(
      topic: appKit.session!.topic,
      chainId: 'eip155:84532', // Base Sepolia
      request: SessionRequestParams(
        method: 'eth_sendTransaction',
        params: [
          {
            'from': senderAddress,
            'to': toAddress,
            'data': callData,
            'value': value,
          }
        ],
      ),
    );

    // Step 3: Return tx hash for tracking
    return txHash.toString();
  }
}
```

---

## 6. Design Tokens & Brand Theme

| Token | Hex Value | Semantic Usage |
|:---|:---|:---|
| **Background Dark** | `#0f172a` | Scaffold primary background |
| **Card Surface** | `#1e293b` | Elevated cards, bottom sheets |
| **Border Subtle** | `rgba(255, 255, 255, 0.08)` | Dividers, card borders |
| **Primary Accent** | `#7c3aed` | Primary buttons, active tabs |
| **Cyan Accent** | `#38bdf8` | Highlighted values, transaction hashes |
| **Success / Approved** | `#10b981` | Positive balances, approved badges |
| **Warning / Grace** | `#f59e0b` | Expiry warnings, extension periods |
| **Danger / Liquidation** | `#ef4444` | Defaulted loans, destructive actions |
| **USDC Color** | `#0284c7` | USDC currency indicators |
| **Credit Color** | `#a855f7` | Protocol Credit indicators |

---

## 7. Android Production Checklist

1. **Tangem App Fallback**:
   - If the user does not have the Tangem App installed, display a friendly button: *"Install Tangem App from Google Play"* opening `market://details?id=com.tangem.wallet`.
2. **Android Single-Task Launch Mode**:
   - Ensure `android:launchMode="singleTask"` is set on `MainActivity` in `AndroidManifest.xml` so when returning from the Tangem App, the existing activity resumes without re-creating state.
3. **Indexer Polling Delay**:
   - After receiving the `txHash` from Tangem, wait ~2–4 seconds before refreshing local balance cards to give the Indico backend worker time to index the event on Base Sepolia.
4. **Android 13+ File Permissions**:
   - For document uploads, use `READ_MEDIA_IMAGES` on Android 13+ (API 33+) and `READ_EXTERNAL_STORAGE` on older versions.
