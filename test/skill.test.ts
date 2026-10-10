import { describe, expect, it, vi } from "vitest";
import type { RequestEnvelope } from "ask-sdk-model";
import type { CarClient } from "../src/car.js";
import { clampTemperature, createSkill } from "../src/skill.js";

const fakeCar = (): CarClient & { calls: unknown[][] } => {
  const calls: unknown[][] = [];
  return {
    calls,
    lock: async () => void calls.push(["lock"]),
    stopClimate: async () => void calls.push(["stop"]),
    startClimate: async (o) => void calls.push(["start", o]),
  };
};

const envelope = (request: object): RequestEnvelope =>
  ({
    version: "1.0",
    session: { new: true, sessionId: "s", application: { applicationId: "app" }, user: { userId: "u" } },
    context: { System: { application: { applicationId: "app" }, user: { userId: "u" }, device: { deviceId: "d" } } },
    request: { requestId: "r", timestamp: new Date().toISOString(), locale: "en-US", ...request },
  }) as unknown as RequestEnvelope;

const intent = (name: string, temperature?: string) =>
  envelope({
    type: "IntentRequest",
    intent: { name, confirmationStatus: "NONE", slots: temperature ? { temperature: { name: "temperature", value: temperature, confirmationStatus: "NONE" } } : {} },
  });

const speech = (res: Awaited<ReturnType<ReturnType<typeof createSkill>["invoke"]>>) =>
  (res.response.outputSpeech as { ssml: string }).ssml;

describe("skill", () => {
  it("locks the car", async () => {
    const car = fakeCar();
    const res = await createSkill({ getCar: async () => car }).invoke(intent("LockCarIntent"));
    expect(car.calls).toEqual([["lock"]]);
    expect(speech(res)).toContain("Locking the car");
  });

  it("defrosts with the default temperature", async () => {
    const car = fakeCar();
    await createSkill({ getCar: async () => car, temperatures: { defrost: 22 }, climateDurationMin: 10 }).invoke(intent("DefrostCarIntent"));
    expect(car.calls).toEqual([["start", { temperature: 22, defrost: true, durationMin: 10 }]]);
  });

  it("warms to a spoken temperature, clamped to a safe range", async () => {
    const car = fakeCar();
    const skill = createSkill({ getCar: async () => car });
    await skill.invoke(intent("StartClimateIntent", "24"));
    await skill.invoke(intent("StartClimateIntent", "99"));
    expect(car.calls.map((c) => (c[1] as { temperature: number }).temperature)).toEqual([24, 27]);
  });

  it("uses separate default temperatures per mode and lets speech override them", async () => {
    const car = fakeCar();
    const skill = createSkill({ getCar: async () => car, temperatures: { warm: 22, defrost: 24, cool: 18 } });
    await skill.invoke(intent("StartClimateIntent"));
    await skill.invoke(intent("DefrostCarIntent"));
    await skill.invoke(intent("CoolCarIntent"));
    await skill.invoke(intent("CoolCarIntent", "20"));
    expect(car.calls.map((c) => c[1])).toEqual([
      { temperature: 22, defrost: false, durationMin: 10 },
      { temperature: 24, defrost: true, durationMin: 10 },
      { temperature: 18, defrost: false, durationMin: 10 },
      { temperature: 20, defrost: false, durationMin: 10 },
    ]);
  });

  it("stops the climate", async () => {
    const car = fakeCar();
    await createSkill({ getCar: async () => car }).invoke(intent("StopClimateIntent"));
    expect(car.calls).toEqual([["stop"]]);
  });

  it("reports failure without leaking details", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await createSkill({ getCar: async () => Promise.reject(new Error("bad password hunter2")) }).invoke(intent("LockCarIntent"));
    expect(speech(res)).toContain("could not reach the car");
    expect(speech(res)).not.toContain("hunter2");
  });

  it("answers before Alexa's deadline when the car is slow, and keeps working", async () => {
    const keepAlive = vi.fn();
    const slow: CarClient = { ...fakeCar(), lock: () => new Promise(() => undefined) };
    const res = await createSkill({ getCar: async () => slow, keepAlive, responseTimeoutMs: 20 }).invoke(intent("LockCarIntent"));
    expect(speech(res)).toContain("can take a minute");
    expect(keepAlive).toHaveBeenCalledOnce();
  });

  it("asks what to do on launch", async () => {
    const res = await createSkill({ getCar: async () => fakeCar() }).invoke(envelope({ type: "LaunchRequest" }));
    expect(speech(res)).toContain("lock the car");
    expect(res.response.shouldEndSession).toBe(false);
  });
});

describe("clampTemperature", () => {
  it("falls back for missing or invalid values", () => {
    expect(clampTemperature(undefined, 21)).toBe(21);
    expect(clampTemperature("?", 21)).toBe(21);
    expect(clampTemperature("5", 21)).toBe(17);
  });
});
