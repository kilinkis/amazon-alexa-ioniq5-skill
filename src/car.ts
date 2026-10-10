export interface ClimateOptions {
  /** Target cabin temperature in Celsius. */
  temperature: number;
  /** Also run the windscreen defroster. */
  defrost: boolean;
  /** How long the climate runs before the car turns it off. */
  durationMin: number;
}

/**
 * Everything the skill needs from a car. Implement this to support another
 * brand or API (see bluelink.ts for the Hyundai/Kia implementation).
 */
export interface CarClient {
  lock(): Promise<void>;
  startClimate(options: ClimateOptions): Promise<void>;
  stopClimate(): Promise<void>;
}
