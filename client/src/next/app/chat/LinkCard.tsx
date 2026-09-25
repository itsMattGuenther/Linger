import { memo } from "react";
import type { LinkPreview } from "../../../generated/LinkPreview";
import { Icon } from "../../kit";
import "./LinkCard.css";

/**
 * A link, as a one-line card: its icon, its title, its domain (SPEC §4.7:
 * "not a 400px billboard"). The card is its final size from the start, with
 * the address's host until the server's preview arrives, so it never makes a
 * row grow after it has been measured.
 */
export const LinkCard = memo(function LinkCard({
  url,
  preview,
  onOpen,
}: {
  url: string;
  preview: LinkPreview | undefined;
  onOpen: (url: string) => void;
}) {
  const domain = preview?.domain ?? hostOf(url);
  const title = preview?.title ?? domain;
  return (
    <button type="button" className="nx-linkcard" title={url} aria-label={`${title}, ${domain}`} onClick={() => onOpen(url)}>
      <span className="nx-linkcard-icon" aria-hidden="true">
        {preview?.icon ? <img src={preview.icon} alt="" /> : <Icon name="link" size="md" />}
      </span>
      <span className="nx-linkcard-text">
        <span className="nx-linkcard-title">{title}</span>
        <span className="nx-linkcard-domain">{domain}</span>
      </span>
    </button>
  );
});

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}
