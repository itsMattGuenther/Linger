const porchIcon = new URL(
  "../../../assets/logo/Linger Pixel Porch Icon Set FINAL.png",
  import.meta.url,
).href;

/** Reuse the chosen identity without turning people into avatars. */
export default function PorchMark({
  className = "",
  decorative = false,
}: {
  className?: string;
  decorative?: boolean;
}) {
  return (
    <img
      className={`porch-mark ${className}`}
      src={porchIcon}
      alt={decorative ? "" : "Linger porch"}
      width={388}
      height={384}
    />
  );
}
