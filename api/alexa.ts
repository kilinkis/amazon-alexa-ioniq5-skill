import { SkillRequestSignatureVerifier, TimestampVerifier } from "ask-sdk-express-adapter";
import type { RequestEnvelope } from "ask-sdk-model";
import { waitUntil } from "@vercel/functions";
import { createBluelinkCar } from "../src/bluelink.js";
import { createSkill } from "../src/skill.js";

const skill = createSkill({
  getCar: createBluelinkCar(),
  keepAlive: waitUntil,
  defaultTemperature: process.env.DEFAULT_TEMP_C ? Number(process.env.DEFAULT_TEMP_C) : undefined,
});

// This endpoint controls a car, so it fails closed: it needs a valid Alexa signature AND a
// configured skill ID. ALEXA_USER_ID optionally restricts it to one Alexa account.
export async function POST(request: Request): Promise<Response> {
  const expectedSkill = process.env.ALEXA_SKILL_ID;
  if (!expectedSkill) return new Response("ALEXA_SKILL_ID is not configured", { status: 500 });

  const body = await request.text();
  try {
    await new SkillRequestSignatureVerifier().verify(body, Object.fromEntries(request.headers));
    await new TimestampVerifier().verify(body);
  } catch {
    return new Response("Invalid Alexa request", { status: 400 });
  }

  const envelope = JSON.parse(body) as RequestEnvelope;
  const { application, user } = envelope.context.System;
  if (application.applicationId !== expectedSkill) return new Response("Unknown skill", { status: 403 });
  const expectedUser = process.env.ALEXA_USER_ID;
  if (expectedUser && user.userId !== expectedUser) return new Response("Unknown user", { status: 403 });

  return Response.json(await skill.invoke(envelope));
}
