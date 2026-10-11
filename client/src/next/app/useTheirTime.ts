import { useMemo, useSyncExternalStore } from "react";
import type { User } from "../../generated/User";
import { timeFor } from "../../lib/localTime";
import { currentMinute, subscribeMinute } from "../../lib/minuteClock";

const nobody = () => () => undefined;
const never = () => 0;

/**
 * "3:12 AM for Jules" when Jules shows their local time (#604), else null.
 *
 * Only somebody who shares a clock listens to the one minute clock
 * (`lib/minuteClock.ts`), so a list of people who don't costs no timer at
 * all, and one who does is drawn again once a minute.
 */
export function useTheirTime(user: Pick<User, "time_zone" | "display_name">): string | null {
  const zone = user.time_zone ?? null;
  const minute = useSyncExternalStore(zone === null ? nobody : subscribeMinute, zone === null ? never : currentMinute);
  return useMemo(() => (zone === null ? null : timeFor(zone, user.display_name, minute)), [zone, user.display_name, minute]);
}
