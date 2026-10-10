import { describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const vehicle = {
  lock: async () => void calls.push("lock"),
  stop: async () => void calls.push("stop"),
  start: async (o: unknown) => void calls.push(`start ${JSON.stringify(o)}`),
};

// Mocking only the named export means a wrong default import fails here
// ("BlueLinky is not a constructor"), as it did on Vercel.
vi.mock("bluelinky", () => ({
  BlueLinky: class {
    login = async () => "ok";
    getVehicles = async () => [vehicle];
    getVehicle = () => vehicle;
  },
}));

import { createBluelinkCar } from "../src/bluelink.js";

const env = { BLUELINK_USERNAME: "u", BLUELINK_PASSWORD: "p", BLUELINK_PIN: "0000" };

describe("createBluelinkCar", () => {
  it("logs in and maps car commands to bluelinky calls", async () => {
    const car = await createBluelinkCar(env)();
    await car.lock();
    await car.startClimate({ temperature: 21, defrost: true, durationMin: 10 });
    await car.stopClimate();
    expect(calls).toEqual([
      "lock",
      'start {"hvac":true,"duration":10,"temperature":21,"defrost":true,"heatedFeatures":true}',
      "stop",
    ]);
  });

  it("reports missing credentials by name", async () => {
    await expect(createBluelinkCar({})()).rejects.toThrow("BLUELINK_USERNAME");
  });
});
