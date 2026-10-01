import { Fragment, type MouseEvent } from "react";
import type { UserStatus } from "../../generated/UserStatus";
import { openExternal } from "../../lib/external";
import { fieldsOf } from "../../lib/status";
import { valueParts } from "../../lib/statusLinks";
import "./PersonFields.css";

/**
 * A person's fields (#270): what they're listening to, reading, playing, or
 * anything they labelled themselves, in their order. On their card, and in
 * the header of your DM with them (#351), drawn the same way in both.
 */
export function PersonFields({ status }: { status: UserStatus | null | undefined }) {
  const fields = fieldsOf(status);
  if (fields.length === 0) return null;
  return (
    <dl className="nx-person-fields">
      {fields.map((field) => (
        <div key={field.label} className="nx-person-field">
          <dt>{field.label}</dt>
          <dd>
            <FieldValue value={field.value} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * What a field says, with its web addresses drawn as links (#270): each opens
 * in the browser, never in this window, the way a link in a message does
 * (`lib/external.ts`). Nothing else in it is a link (`lib/statusLinks.ts`).
 */
function FieldValue({ value }: { value: string }) {
  return (
    <>
      {valueParts(value).map((part, at) =>
        part.kind === "link" ? (
          <a
            key={at}
            className="nx-person-link"
            href={part.href}
            title={part.href}
            rel="noreferrer noopener"
            onClick={(event: MouseEvent<HTMLAnchorElement>) => {
              event.preventDefault();
              openExternal(part.href);
            }}
          >
            {part.text}
          </a>
        ) : (
          <Fragment key={at}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}
