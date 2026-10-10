import { BlueLinky } from "bluelinky";
import type { CarClient, ClimateOptions } from "./car.js";

type Env = Record<string, string | undefined>;

function required(env: Env, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`Missing environment variable ${key}`);
  return value;
}

/**
 * Hyundai/Kia Bluelink (EU) via the unofficial `bluelinky` library.
 * The logged-in vehicle is cached for the lifetime of a warm serverless instance.
 */
export function createBluelinkCar(env: Env = process.env): () => Promise<CarClient> {
  let cached: Promise<CarClient> | undefined;

  const connect = async (): Promise<CarClient> => {
    const client = new BlueLinky({
      username: required(env, "BLUELINK_USERNAME"),
      password: required(env, "BLUELINK_PASSWORD"),
      pin: required(env, "BLUELINK_PIN"),
      brand: env.BLUELINK_BRAND === "kia" ? "kia" : "hyundai",
      region: "EU" as const,
      vin: env.BLUELINK_VIN,
      autoLogin: false,
    });
    await client.login();
    const vehicles = await client.getVehicles();
    const vehicle = env.BLUELINK_VIN ? client.getVehicle(env.BLUELINK_VIN) : vehicles[0];
    if (!vehicle) throw new Error("No vehicle found on this Bluelink account");

    return {
      lock: async () => void (await vehicle.lock()),
      stopClimate: async () => void (await vehicle.stop()),
      startClimate: async ({ temperature, defrost, durationMin }: ClimateOptions) =>
        void (await vehicle.start({
          hvac: true,
          duration: durationMin,
          temperature,
          defrost,
          heatedFeatures: defrost,
        })),
    };
  };

  return () => {
    cached ??= connect().catch((err) => {
      cached = undefined; // retry login on the next request
      throw err;
    });
    return cached;
  };
}
