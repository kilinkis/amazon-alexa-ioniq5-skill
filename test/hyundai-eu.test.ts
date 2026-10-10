import { generateKeyPairSync, privateDecrypt, constants } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createHyundaiEuCar, encryptPassword, stamp } from "../src/hyundai-eu.js";

describe("stamp", () => {
  it("is deterministic for a given time and base64 encoded", () => {
    expect(stamp(1_700_000_000_000)).toBe(stamp(1_700_000_000_000));
    expect(stamp(1_700_000_000_000)).not.toBe(stamp(1_700_000_001_000));
    expect(Buffer.from(stamp(0), "base64").length).toBeGreaterThan(30);
  });
});

describe("encryptPassword", () => {
  it("produces a hex string of the key size that the private key can decrypt", () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string };
    const hex = encryptPassword("hunter2", jwk);
    expect(hex).toMatch(/^[0-9a-f]{512}$/);
    // PKCS#1 v1.5 decryption is disabled in newer Node versions; only check it where available.
    try {
      const plain = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(hex, "hex"));
      expect(plain.toString()).toBe("hunter2");
    } catch (err) {
      expect(String(err)).toMatch(/RSA_PKCS1_PADDING|unsupported/i);
    }
  });
});

/** A tiny fake of Hyundai's servers, recording every call. */
function fakeHyundai(options: { blocked?: boolean; commandResult?: string } = {}) {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...(publicKey.export({ format: "jwk" }) as object), kid: "k1" };
  const calls: { method: string; url: string; headers: Record<string, string>; body?: string }[] = [];

  const fetchFn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    calls.push({ method: init.method ?? "GET", url, headers, body: init.body ? String(init.body) : undefined });
    const ok = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status, headers: extra });

    if (url.includes("/notifications/register")) return ok({ resMsg: { deviceId: "dev-1" } });
    if (url.includes("/oauth2/authorize")) {
      return options.blocked
        ? new Response("Bad Request. It was classified as an abusing request and blocked.", { status: 400 })
        : new Response("<html>login</html>", { status: 200, headers: { "set-cookie": "sid=abc; Path=/" } });
    }
    if (url.includes("/accounts/certs")) return ok({ retValue: jwk });
    if (url.includes("/account/signin")) {
      return new Response(null, { status: 302, headers: { location: "https://oneapp.hyundai.com/redirect?code=CODE1&state=ccsp" } });
    }
    if (url.includes("/auth/token?code=")) return ok({ accessToken: "cci", exchangeableAccessToken: "ex", nonCcsToken: "non" });
    if (url.includes("token-exchange")) return ok({ accessToken: "ccs-token", expiresTime: 4_000_000_000 });
    if (url.endsWith("/api/v1/spa/vehicles")) return ok({ resMsg: { vehicles: [{ vehicleId: "veh-1", vin: "VIN1", ccuCCS2ProtocolSupport: 1 }] } });
    if (url.endsWith("/api/v1/user/pin")) return ok({ controlToken: "ctl", expiresTime: 600 });
    if (url.includes("/control/")) return ok({ msgId: "msg-1" });
    if (url.includes("/notifications/veh-1/records")) return ok({ resMsg: [{ recordId: "msg-1", result: options.commandResult ?? "success" }] });
    return ok({}, 404);
  }) as typeof fetch;

  return { fetchFn, calls };
}

const make = (fake: ReturnType<typeof fakeHyundai>) =>
  createHyundaiEuCar({ username: "me@example.com", password: "pw", pin: "1234", fetchFn: fake.fetchFn, sleep: async () => undefined });

describe("createHyundaiEuCar", () => {
  it("logs in, gets a control token with the PIN, and locks", async () => {
    const fake = fakeHyundai();
    const car = await make(fake)();
    await car.lock();

    const pin = fake.calls.find((c) => c.url.endsWith("/user/pin"))!;
    expect(JSON.parse(pin.body!)).toEqual({ pin: "1234", deviceId: "dev-1" });
    const lock = fake.calls.find((c) => c.url.endsWith("/vehicles/veh-1/ccs2/control/door"))!;
    expect(JSON.parse(lock.body!)).toEqual({ command: "close" });
    expect(lock.headers.authorization).toBe("Bearer ctl");
    expect(lock.headers["ccsp-device-id"]).toBe("dev-1");
    const signin = fake.calls.find((c) => c.url.endsWith("/account/signin"))!;
    expect(signin.headers.cookie).toBe("sid=abc");
    expect(signin.body).not.toContain("password=pw");
  });

  it("starts the climate with defrost and a temperature", async () => {
    const fake = fakeHyundai();
    const car = await make(fake)();
    await car.startClimate({ temperature: 22, defrost: true, durationMin: 10 });
    const call = fake.calls.find((c) => c.url.endsWith("/control/temperature"))!;
    expect(JSON.parse(call.body!)).toMatchObject({ command: "start", hvacTemp: 22, windshieldFrontDefogState: true, tempUnit: "C" });
  });

  it("logs in once and reuses the session and control token", async () => {
    const fake = fakeHyundai();
    const getCar = make(fake);
    await (await getCar()).lock();
    await (await getCar()).stopClimate();
    expect(fake.calls.filter((c) => c.url.includes("/notifications/register"))).toHaveLength(1);
    expect(fake.calls.filter((c) => c.url.endsWith("/user/pin"))).toHaveLength(1);
  });

  it("explains a WAF block as not a password problem", async () => {
    await expect(make(fakeHyundai({ blocked: true }))()).rejects.toThrow(/blocked.*not a password problem/i);
  });

  it("fails when the car reports the command failed", async () => {
    const car = await make(fakeHyundai({ commandResult: "fail" }))();
    await expect(car.lock()).rejects.toThrow("reported the command as fail");
  });
});
