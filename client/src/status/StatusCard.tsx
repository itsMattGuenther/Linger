/**
 * Somebody's status, drawn (SPEC §4.6).
 *
 * One component, two places: the roster card when you open it, and the popover
 * you get from a name in the stream. They were never allowed to drift — a
 * status that reads one way in the panel and another over a message is two
 * statuses.
 *
 * The line renders in the person's own styling, because that is the AIM
 * feature this is: the away message was a mood board and a joke delivery
 * mechanism, and half of that was the font it arrived in.
 */
import type { User } from "../generated/User";
import { nameProps } from "../lib/names";
import { absoluteUrl } from "../lib/url";
import "./status.css";

/**
 * The three labeled fields, in SPEC §4.6's order. Labels match the editor's,
 * from the one list in `status.ts`, so what you type under "working on" comes
 * back out under "working on".
 */
function fieldsOf(user: User): [string, string][] {
  const status = user.status;
  if (!status) return [];
  const all: [string, string | null][] = [
    ["reading", status.reading],
    ["listening to", status.listening],
    ["working on", status.working_on],
  ];
  return all.filter((pair): pair is [string, string] => pair[1] !== null && pair[1] !== "");
}

export default function StatusCard({
  baseUrl,
  user,
  /**
   * The away message this surface has already drawn above the card, if any.
   *
   * The roster puts it on the person's lines; the popover puts it at the top of
   * its own card. Either way it supersedes the status line (SPEC §4.6) and must
   * not appear twice, so whoever drew it says so and the line steps aside.
   */
  awayShown,
}: {
  baseUrl: string;
  user: User;
  awayShown: boolean;
}) {
  const status = user.status;
  if (!status) return null;

  const fields = fieldsOf(user);
  const line = awayShown ? null : status.line;
  const hasLine = line !== null && line !== "";
  const image = status.image_url;
  if (!hasLine && fields.length === 0 && image === null) return null;

  return (
    <div className="person-status">
      {hasLine ? (
        <p {...nameProps(user, "status-line")}>
          {line}
        </p>
      ) : null}
      {fields.length === 0 ? null : (
        <dl className="status-fields">
          {fields.map(([label, value]) => (
            <div className="status-field" key={label}>
              <dt className="meta">{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {/*
        SPEC §4.6's one image, at its 400×200. The panel it is drawn in is
        narrower than that, so 400×200 is the box it is drawn *to* — the width
        gives way and the 2:1 shape does not, which is what keeps the roster
        card and the popover showing the same picture.

        `loading="lazy"` because a roster of thirty people is thirty of these,
        and only the card you opened is on screen.
      */}
      {image === null ? null : (
        <img
          className="status-image"
          src={absoluteUrl(baseUrl, image)}
          alt={`${user.display_name}'s status image`}
          loading="lazy"
        />
      )}
    </div>
  );
}
