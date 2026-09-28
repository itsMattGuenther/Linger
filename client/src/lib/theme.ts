/**
 * The warmth that arrives after sunset (SPEC §4.7). The app is dark only
 * (§5.3); warmth is the one change to its colors, the reader's own preference
 * and nobody else's business, so it never leaves this computer.
 *
 * **About "sunset".** The spec says the shift happens after local sunset, and
 * the honest way to know that is a latitude and a longitude. This app does not
 * ask for those and is not going to: a chat client that wants your coordinates
 * to tint its background has made a bad trade. So sunset is approximated by the
 * clock — warm in the evening, cool again in the morning, on the reader's own
 * local time. It is wrong by up to a couple of hours in June and December at
 * high latitudes, and the whole effect is a 200K tint that most people will
 * never consciously notice, which is the reason that is an acceptable trade and
 * a location permission is not.
 */
/** Warm from this hour of the local evening… */
const WARM_FROM_HOUR = 19;
/** …until this hour of the local morning. */
const WARM_UNTIL_HOUR = 7;

/**
 * Whether it is evening where the reader is. Evening warmth (LOOK-2) waits on
 * an evening version of the colors; this is the clock it will read.
 *
 * Takes the time rather than reading the clock so it can be tested, and so the
 * caller's one clock decides.
 */
export function isEvening(now: Date): boolean {
  const hour = now.getHours();
  return hour >= WARM_FROM_HOUR || hour < WARM_UNTIL_HOUR;
}
