import * as Alexa from "ask-sdk-core";
import type { CarClient } from "./car.js";

export interface SkillDeps {
  getCar: () => Promise<CarClient>;
  /** Keeps a promise alive after the response is sent (e.g. Vercel's waitUntil). */
  keepAlive?: (promise: Promise<unknown>) => void;
  /** Default target temperatures (Celsius) per mode; a spoken temperature overrides them. */
  temperatures?: Partial<Record<"warm" | "defrost" | "cool", number>>;
  climateDurationMin?: number;
  /** Alexa gives up after 8s, so answer before that even if the car is slow. */
  responseTimeoutMs?: number;
}

export const MIN_TEMP = 17;
export const MAX_TEMP = 27;

export function clampTemperature(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(MAX_TEMP, Math.max(MIN_TEMP, Math.round(n)));
}

const TIMEOUT = Symbol("timeout");

export function createSkill(deps: SkillDeps) {
  const temps = { warm: 21, defrost: 22, cool: 19, ...deps.temperatures };
  const duration = deps.climateDurationMin ?? 10;
  const timeoutMs = deps.responseTimeoutMs ?? 6000;

  /** Run a car command; report success, failure, or "still working" if it is slow. */
  const run = async (
    h: Alexa.HandlerInput,
    command: (car: CarClient) => Promise<void>,
    done: string,
  ) => {
    const work = deps.getCar().then(command);
    deps.keepAlive?.(work.catch(() => undefined));
    try {
      const result = await Promise.race([
        work,
        new Promise<typeof TIMEOUT>((r) => setTimeout(() => r(TIMEOUT), timeoutMs)),
      ]);
      const speech = result === TIMEOUT ? "I sent the command. The car can take a minute to respond." : done;
      return h.responseBuilder.speak(speech).getResponse();
    } catch (err) {
      console.error("car command failed", err instanceof Error ? err.message : err);
      return h.responseBuilder.speak("Sorry, I could not reach the car right now.").getResponse();
    }
  };

  const intent = (name: string, handle: (h: Alexa.HandlerInput) => Promise<ReturnType<Alexa.ResponseBuilder["getResponse"]>>): Alexa.RequestHandler => ({
    canHandle: (h) =>
      Alexa.getRequestType(h.requestEnvelope) === "IntentRequest" && Alexa.getIntentName(h.requestEnvelope) === name,
    handle,
  });

  const launch: Alexa.RequestHandler = {
    canHandle: (h) => Alexa.getRequestType(h.requestEnvelope) === "LaunchRequest",
    handle: (h) =>
      h.responseBuilder
        .speak("What should I do? You can say lock the car, defrost the car, warm up the car, or cool down the car.")
        .reprompt("Lock, defrost, or warm up?")
        .getResponse(),
  };

  const lock = intent("LockCarIntent", (h) => run(h, (c) => c.lock(), "Locking the car."));

  /** Start the climate in one mode; a spoken temperature slot overrides the mode's default. */
  const climateIntent = (name: string, mode: "warm" | "defrost" | "cool", defrost: boolean, verb: string) =>
    intent(name, (h) => {
      const temperature = clampTemperature(Alexa.getSlotValue(h.requestEnvelope, "temperature"), temps[mode]);
      return run(
        h,
        (c) => c.startClimate({ temperature, defrost, durationMin: duration }),
        `${verb} to ${temperature} degrees.`,
      );
    });

  const defrost = climateIntent("DefrostCarIntent", "defrost", true, "Defrosting the car");
  const climate = climateIntent("StartClimateIntent", "warm", false, "Warming the car");
  const cool = climateIntent("CoolCarIntent", "cool", false, "Cooling the car");

  const stop = intent("StopClimateIntent", (h) => run(h, (c) => c.stopClimate(), "Stopping the climate."));

  const help = intent("AMAZON.HelpIntent", async (h) =>
    h.responseBuilder
      .speak("You can say lock the car, defrost the car, warm up the car, cool down the car, or stop the climate.")
      .reprompt("What should I do?")
      .getResponse(),
  );

  const bye: Alexa.RequestHandler = {
    canHandle: (h) =>
      Alexa.getRequestType(h.requestEnvelope) === "IntentRequest" &&
      ["AMAZON.StopIntent", "AMAZON.CancelIntent"].includes(Alexa.getIntentName(h.requestEnvelope)),
    handle: (h) => h.responseBuilder.speak("Goodbye").getResponse(),
  };

  return Alexa.SkillBuilders.custom().addRequestHandlers(launch, lock, defrost, climate, cool, stop, help, bye).create();
}
