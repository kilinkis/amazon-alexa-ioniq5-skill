import * as Alexa from "ask-sdk-core";
import type { CarClient } from "./car.js";

export interface SkillDeps {
  getCar: () => Promise<CarClient>;
  /** Keeps a promise alive after the response is sent (e.g. Vercel's waitUntil). */
  keepAlive?: (promise: Promise<unknown>) => void;
  defaultTemperature?: number;
  climateDurationMin?: number;
  /** Alexa gives up after 8s, so answer before that even if the car is slow. */
  responseTimeoutMs?: number;
}

export const MIN_TEMP = 16;
export const MAX_TEMP = 28;

export function clampTemperature(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(MAX_TEMP, Math.max(MIN_TEMP, Math.round(n)));
}

const TIMEOUT = Symbol("timeout");

export function createSkill(deps: SkillDeps) {
  const defaultTemp = deps.defaultTemperature ?? 21;
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
        .speak("What should I do? You can say lock the car, defrost the car, or warm up the car.")
        .reprompt("Lock, defrost, or warm up?")
        .getResponse(),
  };

  const lock = intent("LockCarIntent", (h) => run(h, (c) => c.lock(), "Locking the car."));

  const defrost = intent("DefrostCarIntent", (h) =>
    run(h, (c) => c.startClimate({ temperature: defaultTemp, defrost: true, durationMin: duration }), "Defrosting the car."),
  );

  const climate = intent("StartClimateIntent", (h) => {
    const slot = Alexa.getSlotValue(h.requestEnvelope, "temperature");
    const temperature = clampTemperature(slot, defaultTemp);
    return run(
      h,
      (c) => c.startClimate({ temperature, defrost: false, durationMin: duration }),
      `Warming the car to ${temperature} degrees.`,
    );
  });

  const stop = intent("StopClimateIntent", (h) => run(h, (c) => c.stopClimate(), "Stopping the climate."));

  const help = intent("AMAZON.HelpIntent", async (h) =>
    h.responseBuilder
      .speak("You can say lock the car, defrost the car, warm up the car, or stop the climate.")
      .reprompt("What should I do?")
      .getResponse(),
  );

  const bye: Alexa.RequestHandler = {
    canHandle: (h) =>
      Alexa.getRequestType(h.requestEnvelope) === "IntentRequest" &&
      ["AMAZON.StopIntent", "AMAZON.CancelIntent"].includes(Alexa.getIntentName(h.requestEnvelope)),
    handle: (h) => h.responseBuilder.speak("Goodbye").getResponse(),
  };

  return Alexa.SkillBuilders.custom().addRequestHandlers(launch, lock, defrost, climate, stop, help, bye).create();
}
