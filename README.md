# alexa-ioniq-bluelink

A private Alexa skill that controls a Hyundai (tested target: Ioniq 5, Europe) through Bluelink, hosted as a single Vercel function.

> "Alexa, ask my ioniq to lock the car"
> "Alexa, ask my ioniq to defrost the car"
> "Alexa, ask my ioniq to warm up the car to 22 degrees"
> "Alexa, ask my ioniq to cool down the car"
> "Alexa, ask my ioniq to stop the climate"

Warm, defrost and cool each have their own default target temperature (`WARM_TEMP_C`, `DEFROST_TEMP_C`, `COOL_TEMP_C`), and a temperature you say out loud overrides it (17 to 27 degrees). The Bluelink API only takes a target temperature, so "cool" simply uses a lower target and the car's automatic climate does the rest.

Unlock is intentionally **not** implemented, see [Security](#security).

## Read this first

- **Unofficial and unaudited.** This talks to Hyundai's Bluelink Europe API directly, following the login flow documented in [egmp-bluelink-scriptable](https://github.com/andyfase/egmp-bluelink-scriptable) (MIT, see `THIRD_PARTY_NOTICES.md`). Hyundai can change the API or its login at any time and break it. Check your Bluelink terms of use. You use it at your own risk.
- **Not yet verified against Hyundai's real servers.** The tests use a fake Hyundai server, so a first real run may still reveal differences. Errors name the failing step (device registration, sign in, token exchange, PIN check, command).
- Older libraries such as `bluelinky` no longer log in: Hyundai's identity server blocks their old client with "classified as an abusing request". This project uses the newer OneApp login instead. Hyundai changes this from time to time.
- Europe and Hyundai only for now (Kia uses different constants and is not implemented).
- Calling the car too often can drain the 12V battery. The skill only sends a command when you ask, and never polls.

## How it works

```
Alexa -> POST /api/alexa (Vercel) -> verify signature, skill ID -> intent -> CarClient -> Hyundai EU API
```

- `src/car.ts`: the `CarClient` interface (lock, start climate, stop climate). Implement it to add another car or API.
- `src/hyundai-eu.ts`: Hyundai Europe implementation (login, PIN control token, lock, climate).
- `src/skill.ts`: Alexa intents. It answers within Alexa's 8 second limit; if the car is slow it says the command was sent and keeps working in the background.
- `api/alexa.ts`: the Vercel endpoint with request verification.

## Setup

1. Make sure the official Bluelink app works with your username, password and PIN. If login fails later, log in once in the app or on Hyundai's website to accept any new terms.
2. Alexa developer console: create a **Custom** skill, **Provision your own**, **Start from scratch**. Add the locale you use (English US or UK), paste the matching file from `skill-package/interactionModels/custom/` into the JSON editor, save and build. Copy the **Skill ID**.
3. Deploy: import this repo in Vercel.
4. In Vercel, set the environment variables from `.env.example`. `ALEXA_SKILL_ID` is mandatory: without it the endpoint rejects every request. Redeploy.
5. In the Alexa console set the endpoint to **HTTPS**, `https://<project>.vercel.app/api/alexa`, with the wildcard-certificate option.
6. Test in the **Test** tab (Development): `ask my ioniq to lock the car`. The Echo must use the same language as the model and be signed in to the account that owns the skill.

Never commit credentials. Put them only in Vercel environment variables.

## Security

The endpoint controls a physical car, so:

- It **fails closed**: no `ALEXA_SKILL_ID`, no service.
- It verifies Alexa's request signature and timestamp, and the skill ID.
- Set `ALEXA_USER_ID` to accept only your Alexa account.
- The skill stays in Alexa's **development** stage, so only devices on your Amazon account can use it. Do not publish it.
- **No unlock.** Anyone who can speak to the Echo could otherwise unlock the car. If you add it, require an Alexa voice PIN.
- Bluelink credentials grant control of your car. Treat the Vercel project like a password manager entry.

## Extending

- Add an intent: extend `src/skill.ts`, add samples to every `skill-package/interactionModels/custom/*.json`, add a method to `CarClient` and a test.
- Another brand or region: implement `CarClient` and pass it to `createSkill` in `api/alexa.ts`.

## Develop

```bash
pnpm install
pnpm typecheck
pnpm test
```

## Alexa routines

A routine with the action **Custom** and the text `ask my ioniq to defrost the car` gives you a short phrase of your own. The trigger phrase must match what Alexa heard exactly (see More, Activity in the Alexa app).

## License

MIT
