/**
 * Hyundai Bluelink (Europe) client for the OneApp login flow.
 *
 * The endpoints, headers and request sequence follow the MIT licensed
 * andyfase/egmp-bluelink-scriptable (src/lib/bluelink-regions/europe.ts); see
 * THIRD_PARTY_NOTICES.md. This is an unofficial, reverse engineered API: Hyundai can
 * change it at any time.
 */
import { constants, createPublicKey, publicEncrypt, randomBytes, randomUUID } from "node:crypto";
import type { CarClient, ClimateOptions } from "./car.js";

const HOST = {
  api: "https://prd.eu-ccapi.hyundai.com:8080",
  cci: "https://cci-api-eu.hyundai.com",
  auth: "https://idpconnect-eu.hyundai.com",
};
const APP_ID = "014d2225-8495-4735-812d-2616334fd15d";
const SERVICE_ID = "6d477c38-3ca4-4cf3-9557-2a1929a94654";
const STAMP_KEY = "RFtoRq/vDXJmRndoZaZQyfOot7OrIqGVFj96iY2WL3yyH5Z/pUvlUhqmCxD2t+D65SQ=";
const CCI = {
  clientId: "4f4953b5-02e1-4dbc-8599-87e983ee1be5",
  redirectUri: "https://oneapp.hyundai.com/redirect",
  packageId: "com.hyundai.oneapp.eu",
  osVersion: "18.7",
  notificationProvider: "APNS",
};
const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 4.1.1; Galaxy Nexus Build/JRO03C) AppleWebKit/535.19 (KHTML, like Gecko) Chrome/18.0.1025.166 Mobile Safari/535.19_CCS_APP_AOS";
const OK_STATUS = new Set([200, 204, 302]);

export interface HyundaiEuOptions {
  username: string;
  password: string;
  pin: string;
  vin?: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Request signature: "<appId>:<unix seconds>" XORed with a fixed key, base64 encoded. */
export function stamp(nowMs: number): string {
  const raw = Buffer.from(`${APP_ID}:${Math.floor(nowMs / 1000)}`, "utf8");
  const key = Buffer.from(STAMP_KEY, "base64");
  const out = Buffer.alloc(Math.min(raw.length, key.length));
  for (let i = 0; i < out.length; i++) out[i] = raw[i]! ^ key[i]!;
  return out.toString("base64");
}

/** Hyundai expects RSA PKCS#1 v1.5 with the public key it publishes, sent as hex. */
export function encryptPassword(password: string, jwk: { n: string; e: string }): string {
  const key = createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" });
  return publicEncrypt({ key, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(password, "utf8")).toString("hex");
}

/** Danish UTC offset, because serverless functions run in UTC. */
function copenhagenOffset(nowMs: number): { short: string; full: string } {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Copenhagen", timeZoneName: "shortOffset" })
    .formatToParts(new Date(nowMs))
    .find((p) => p.type === "timeZoneName")?.value; // e.g. "GMT+2"
  const hours = Number(/GMT([+-]\d+)/.exec(part ?? "")?.[1] ?? 1);
  return { short: `${hours >= 0 ? "+" : "-"}${Math.abs(hours)}`, full: `${hours >= 0 ? "+" : "-"}${String(Math.abs(hours)).padStart(2, "0")}:00` };
}

const hex = (n: number) => randomBytes(Math.ceil(n / 2)).toString("hex").slice(0, n);
const clip = (s: string) => s.slice(0, 300);

class CookieJar {
  private cookies = new Map<string, string>();
  add(res: Response) {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(";");
      const i = pair!.indexOf("=");
      if (i > 0) this.cookies.set(pair!.slice(0, i).trim(), pair!.slice(i + 1).trim());
    }
  }
  header(): string | undefined {
    const h = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    return h || undefined;
  }
}

interface Session {
  deviceId: string;
  accessToken: string; // "Bearer ..."
  expiry: number; // ms
  vehicleId: string;
  ccs2: string;
}

export function createHyundaiEuCar(opts: HyundaiEuOptions): () => Promise<CarClient> {
  const doFetch = opts.fetchFn ?? fetch;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const apiHeaders = (s?: Pick<Session, "deviceId" | "ccs2">) => ({
    Accept: "application/json, text/plain, */*",
    "User-Agent": "okhttp/3.14.9",
    offset: copenhagenOffset(now()).short,
    "ccsp-service-id": SERVICE_ID,
    "ccsp-application-id": APP_ID,
    Stamp: stamp(now()),
    ...(s && { "ccsp-device-id": s.deviceId, ccuCCS2ProtocolSupport: s.ccs2 }),
  });

  const cciHeaders = (deviceId: string, tokens: Record<string, string> = {}): Record<string, string> => ({
    "client-id": CCI.packageId,
    "client-name": "hyundai",
    "client-version": "1.3.3",
    "client-os-code": "ios",
    "client-os-version": CCI.osVersion,
    "client-device-id": deviceId,
    "client-device-model": "iPhone",
    "client-notification-provider-type": CCI.notificationProvider,
    locale: "EN",
    timezone: copenhagenOffset(now()).full,
    Accept: "application/json",
    "Accept-Language": "en",
    "User-Agent": "okhttp/3.14.9",
    ...(tokens.nonCcsToken && { Authentication: tokens.nonCcsToken }),
    ...(tokens.accessToken && { authorization: `Bearer ${tokens.accessToken.replace(/^Bearer\s+/i, "")}` }),
    ...(tokens.exchangeableAccessToken && {
      "exchangeable-token": tokens.exchangeableAccessToken,
      "non-ccs-token": tokens.nonCcsToken ?? "",
    }),
  });

  async function json(res: Response, what: string): Promise<any> {
    const text = await res.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (!OK_STATUS.has(res.status) || String(body?.resCode) === "4002") {
      throw new Error(`${what} failed: HTTP ${res.status} ${clip(text)}`);
    }
    return body ?? {};
  }

  /** GET following redirects by hand so cookies from every hop are kept. */
  async function browse(url: string, jar: CookieJar): Promise<{ url: string; text: string; status: number }> {
    let current = url;
    for (let hop = 0; hop < 8; hop++) {
      const res = await doFetch(current, {
        redirect: "manual",
        headers: {
          "User-Agent": MOBILE_UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-GB,en;q=0.9",
          ...(jar.header() && { Cookie: jar.header()! }),
        },
      });
      jar.add(res);
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        current = new URL(location, current).toString();
        continue;
      }
      return { url: current, text: await res.text(), status: res.status };
    }
    throw new Error("Login failed: too many redirects");
  }

  async function login(): Promise<Session> {
    const reg = await json(
      await doFetch(`${HOST.api}/api/v1/spa/notifications/register`, {
        method: "POST",
        headers: { ...apiHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          pushRegId: `${hex(22)}:${hex(63)}-${hex(55)}`,
          pushType: "GCM",
          uuid: randomUUID().toLowerCase(),
        }),
      }),
      "Device registration",
    );
    const deviceId: string | undefined = reg.resMsg?.deviceId;
    if (!deviceId) throw new Error("Device registration returned no device ID");

    const jar = new CookieJar();
    const authorize = await browse(
      `${HOST.auth}/auth/api/v2/user/oauth2/authorize?` +
        new URLSearchParams({
          response_type: "code",
          client_id: CCI.clientId,
          redirect_uri: CCI.redirectUri,
          lang: "en",
          state: "ccsp",
          country: "de",
        }),
      jar,
    );
    if (authorize.url.includes("/error?status=400") || authorize.text.toLowerCase().includes("abusing request")) {
      throw new Error("Hyundai blocked the login request (WAF). This is not a password problem.");
    }
    if (authorize.status !== 200) throw new Error(`Login page failed: HTTP ${authorize.status}`);

    const certs = await browse(`${HOST.auth}/auth/api/v1/accounts/certs`, jar);
    let jwk: { n: string; e: string; kid?: string };
    try {
      const parsed = JSON.parse(certs.text);
      jwk = parsed.retValue ?? parsed;
    } catch {
      throw new Error(`Could not read Hyundai's RSA key: ${clip(certs.text)}`);
    }
    if (!jwk?.n || !jwk?.e) throw new Error("Hyundai's RSA key response had no key material");

    const signin = await doFetch(`${HOST.auth}/auth/account/signin`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "User-Agent": MOBILE_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-GB,en;q=0.9",
        "Content-Type": "application/x-www-form-urlencoded",
        ...(jar.header() && { Cookie: jar.header()! }),
      },
      body: new URLSearchParams({
        client_id: CCI.clientId,
        encryptedPassword: "true",
        password: encryptPassword(opts.password, jwk),
        redirect_uri: CCI.redirectUri,
        scope: "",
        nonce: "",
        state: "ccsp",
        username: opts.username,
        connector_session_key: "",
        kid: jwk.kid ?? "",
        _csrf: "",
      }),
    });
    const location = signin.headers.get("location");
    if (signin.status !== 302 || !location) throw new Error(`Sign in failed: HTTP ${signin.status}`);
    const params = new URL(location, HOST.auth).searchParams;
    const code = params.get("code");
    if (!code) {
      if (location.includes("/web/v1/user/authorization")) {
        throw new Error("Hyundai needs you to accept new terms: log in once in the Bluelink app or on the website");
      }
      if (location.includes("error")) throw new Error(`Sign in rejected: ${params.get("error_description") ?? "unknown"}. Check username and password.`);
      throw new Error("Sign in returned to the login page. Check username and password.");
    }

    const tokenRes = await json(
      await doFetch(`${HOST.cci}/domain/api/v1/auth/token?code=${encodeURIComponent(code)}`, {
        method: "POST",
        headers: cciHeaders(deviceId),
      }),
      "Token request",
    );
    const cciTokens = {
      accessToken: tokenRes.accessToken ?? "",
      exchangeableAccessToken: tokenRes.exchangeableAccessToken ?? "",
      nonCcsToken: tokenRes.nonCcsToken ?? "",
    };
    const ccs = await json(
      await doFetch(`${HOST.cci}/domain/api/v1/auth/token-exchange?serviceType=CCS`, {
        method: "POST",
        headers: cciHeaders(deviceId, cciTokens),
      }),
      "Token exchange",
    );
    const ccsToken: string | undefined = ccs.accessToken ?? ccs.ccsAccessToken;
    if (!ccsToken) throw new Error("Token exchange returned no access token");
    const expiresTime = Number(ccs.expiresTime);
    const expiry = Number.isFinite(expiresTime) && expiresTime > 0
      ? (expiresTime > 1e11 ? expiresTime : expiresTime * 1000)
      : now() + 3600_000;

    const base = { deviceId, accessToken: `Bearer ${ccsToken.replace(/^Bearer\s+/i, "")}`, expiry, ccs2: "0" };
    const vehicles = await json(
      await doFetch(`${HOST.api}/api/v1/spa/vehicles`, {
        headers: { ...apiHeaders(base), Authorization: base.accessToken },
      }),
      "Vehicle list",
    );
    const list: any[] = vehicles.resMsg?.vehicles ?? [];
    const vehicle = opts.vin ? list.find((v) => v.vin === opts.vin) : list[0];
    if (!vehicle) throw new Error(opts.vin ? `VIN ${opts.vin} not found on this account` : "No vehicle on this account");
    return { ...base, vehicleId: vehicle.vehicleId, ccs2: String(vehicle.ccuCCS2ProtocolSupport ?? 0) };
  }

  let control: { token: string; expiry: number } | undefined;

  async function controlToken(s: Session): Promise<string> {
    if (control && control.expiry > now() + 30_000) return control.token;
    const res = await json(
      await doFetch(`${HOST.api}/api/v1/user/pin`, {
        method: "PUT",
        headers: {
          ...apiHeaders(s),
          Authorization: s.accessToken,
          "Content-Type": "application/json",
          vehicleId: s.vehicleId,
        },
        body: JSON.stringify({ pin: opts.pin, deviceId: s.deviceId }),
      }),
      "PIN check (is the PIN correct?)",
    );
    control = { token: `Bearer ${res.controlToken}`, expiry: now() + Number(res.expiresTime) * 1000 };
    return control.token;
  }

  async function command(s: Session, path: string, body: object): Promise<void> {
    const res = await json(
      await doFetch(`${HOST.api}/api/v2/spa/vehicles/${s.vehicleId}/ccs2/control/${path}`, {
        method: "POST",
        headers: { ...apiHeaders(s), Authorization: await controlToken(s), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      `Command ${path}`,
    );
    const id: string | undefined = res.msgId;
    if (!id) return;
    for (let attempt = 0; attempt < 10; attempt++) {
      await sleep(2000);
      const records = await json(
        await doFetch(`${HOST.api}/api/v1/spa/notifications/${s.vehicleId}/records`, {
          headers: { ...apiHeaders(s), Authorization: s.accessToken },
        }),
        "Command status",
      );
      const record = (records.resMsg ?? []).find((r: any) => r.recordId === id);
      if (record?.result === "success") return;
      if (record?.result === "fail" || record?.result === "non-response") {
        throw new Error(`The car reported the command as ${record.result}`);
      }
    }
  }

  let cached: Promise<Session> | undefined;
  const session = async (): Promise<Session> => {
    if (cached) {
      const s = await cached.catch(() => undefined);
      if (s && s.expiry > now() + 60_000) return s;
    }
    control = undefined;
    cached = login().catch((err) => {
      cached = undefined; // log in again on the next request
      throw err;
    });
    return cached;
  };

  return async () => {
    await session(); // fail fast on login problems
    return {
      lock: async () => command(await session(), "door", { command: "close" }),
      stopClimate: async () => command(await session(), "temperature", { command: "stop" }),
      startClimate: async ({ temperature, defrost }: ClimateOptions) =>
        command(await session(), "temperature", {
          command: "start",
          windshieldFrontDefogState: defrost,
          hvacTempType: 1,
          heating1: defrost ? 2 : 0,
          tempUnit: "C",
          drvSeatLoc: "L",
          hvacTemp: temperature,
        }),
    };
  };
}

export function hyundaiEuCarFromEnv(env: Record<string, string | undefined> = process.env): () => Promise<CarClient> {
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`Missing environment variable ${k}`);
    return v;
  };
  let factory: (() => Promise<CarClient>) | undefined;
  return async () => {
    // One client per warm instance, so the login session is reused between requests.
    factory ??= createHyundaiEuCar({
      username: need("BLUELINK_USERNAME"),
      password: need("BLUELINK_PASSWORD"),
      pin: need("BLUELINK_PIN"),
      vin: env.BLUELINK_VIN,
    });
    return factory();
  };
}
